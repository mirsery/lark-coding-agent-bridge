import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun } from '../agent/types';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { agentDescriptor, isAgentKind } from '../agent/registry';
import { RunRejected, SpawnFailed } from './errors';
import { isTerminalEvent, ProcessSession } from './process-session';
import type { UsageEntry } from './usage-ledger';

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
  /**
   * How long a process may keep running background tasks after its last
   * user turn before it is stopped anyway.
   */
  maxBackgroundLingerMs?: number;
  /** Where each turn's token / cost report is booked against the person behind it. */
  usage?: { record(entry: UsageEntry): void };
}

/**
 * What a submitter hears about a process after its user turn ended: a turn
 * the agent ran on its own (a background task it started reported back), or
 * that the process was stopped with background work still running.
 */
export type BackgroundTurn =
  | { kind: 'turn'; events: AgentEvent[] }
  | { kind: 'stopped'; reason: 'max-linger'; afterMs: number }
  | { kind: 'stopped'; reason: 'shutdown' };

export type BackgroundTurnHandler = (turn: BackgroundTurn) => Promise<void>;

export interface SubmitRunInput {
  scopeId: string;
  policy: RunPolicyAllow;
  sessionId?: string;
  threadId?: string;
  model?: string;
  effort?: string;
  images?: readonly string[];
  stopGraceMs?: number;
  nowait?: boolean;
  /** Who this run is for — the person its usage is booked against. */
  actor?: { id: string; name?: string };
  /**
   * Receives background turns once this run's user turn is over. A later
   * submission for the same scope replaces it, so follow-ups go to whoever
   * talked to the process last. Without one they are only logged.
   */
  onBackgroundTurn?: BackgroundTurnHandler;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export interface RunExecution {
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  subscribe(): AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
}

const DEFAULT_MAX_BACKGROUND_LINGER_MS = 30 * 60 * 1000;

/** A spawned process, tracked per scope while it may still serve turns. */
interface LiveProcess {
  scopeId: string;
  session: ProcessSession;
  /** Run options that must match for a new user turn to reuse the process. */
  compatKey: string;
  dimensions: Record<string, unknown>;
  onBackgroundTurn: BackgroundTurnHandler | undefined;
  /** Latest submitter: background turns are booked against them. */
  actor: { id: string; name?: string } | undefined;
  source: string;
  lingerTimer: NodeJS.Timeout | undefined;
  finishing: boolean;
  /** Settles once a finishing process has exited (or been stopped). */
  finished: Promise<void> | undefined;
}

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;
  private readonly maxBackgroundLingerMs: number;
  private readonly usage: RunExecutorDeps['usage'];
  private readonly live = new Map<string, LiveProcess>();

  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs =
      deps.postDoneExitGraceMs ?? agentDescriptor(isAgentKind(deps.agent.id) ? deps.agent.id : undefined).exitGraceMs;
    this.maxBackgroundLingerMs = deps.maxBackgroundLingerMs ?? DEFAULT_MAX_BACKGROUND_LINGER_MS;
    this.usage = deps.usage;
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const submittedAt = this.now();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    const release = input.nowait ? this.pool.tryAcquire() : await this.pool.acquire();
    if (!release) {
      releaseScope();
      throw new RunRejected('pool-full', 'process pool is full');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }

    const runId = this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const runOptions = {
      runId,
      prompt: input.policy.prompt,
      cwd: input.policy.cwdRealpath,
      sessionId: input.sessionId,
      threadId: input.threadId,
      model: input.model,
      effort: input.effort,
      images: input.images,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
    };
    const compatKey = runCompatKey(runOptions);
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? 'unknown',
      stage: input.observability?.stage ?? 'submit',
    };

    // A process still running background tasks for this scope takes the
    // prompt as its next turn, so that work is not killed to spawn anew.
    let live: LiveProcess | undefined;
    let turnEvents: AsyncIterable<AgentEvent> | undefined;
    const previous = this.live.get(input.scopeId);
    // A process still exiting on its own after its last turn is left to
    // finish its bookkeeping in the background; the conversation it wrote is
    // already complete, so the new turn does not wait for it.
    if (previous && !previous.finishing) {
      const resumeTarget = input.sessionId ?? input.threadId;
      const compatible =
        previous.compatKey === compatKey &&
        !previous.finishing &&
        !previous.session.hasExited &&
        !previous.session.hasAttachedTurn &&
        (!resumeTarget || resumeTarget === previous.session.conversationId);
      if (compatible && previous.session.run.send) {
        const events = previous.session.attachTurn();
        if (previous.session.run.send(input.policy.prompt)) {
          live = previous;
          turnEvents = events;
          this.endLinger(live);
          live.dimensions = dimensions;
          log.info('run', 'reuse-process', { ...dimensions, background: live.session.background });
        } else {
          previous.session.detachTurn();
        }
      }
      if (!live) await this.retire(previous, compatible ? 'input-closed' : 'incompatible');
    }

    let run: AgentRun;
    if (live && turnEvents) {
      run = live.session.run;
    } else {
      try {
        await this.agent.prepareRun?.(runOptions);
      } catch (err) {
        release();
        releaseScope();
        if (err instanceof SpawnFailed) throw err;
        throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
      }
      if (this.activeRuns.newRunsPaused()) {
        release();
        releaseScope();
        throw new RunRejected(
          'reconnect-in-progress',
          this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
        );
      }
      try {
        run = this.agent.run(runOptions);
      } catch (err) {
        release();
        releaseScope();
        throw new SpawnFailed('agent spawn failed', err);
      }
      let created!: LiveProcess;
      const session = new ProcessSession(run, {
        onBackgroundTurn: (events) => this.deliverBackgroundTurn(created, events),
        onExit: () => this.forget(created),
      });
      created = {
        scopeId: input.scopeId,
        session,
        compatKey,
        dimensions,
        onBackgroundTurn: undefined,
        actor: undefined,
        source: 'unknown',
        lingerTimer: undefined,
        finishing: false,
        finished: undefined,
      };
      live = created;
      turnEvents = created.session.attachTurn();
      this.live.set(input.scopeId, created);
    }
    live.onBackgroundTurn = input.onBackgroundTurn;
    live.actor = input.actor;
    live.source = dimensions.source;
    log.info('run', 'started', {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
    });

    let handle: RunHandle;
    try {
      handle = this.activeRuns.register(input.scopeId, run);
    } catch (err) {
      releaseScope();
      release();
      await run.stop().catch(() => {});
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    const owner = live;
    let cleaned = false;
    const cleanup = async (terminal: AgentEvent | undefined): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      this.activeRuns.unregister(input.scopeId, run);
      release();
      if (handle.interrupted) return;
      if (
        terminal?.type === 'done' &&
        owner.session.background > 0 &&
        run.send &&
        !owner.session.hasExited
      ) {
        this.startLinger(owner);
        return;
      }
      await this.finish(owner);
    };
    let terminal: AgentEvent | undefined;
    const fanout = new EventFanout(
      observeRunEvents(turnEvents, { dimensions, startedAt, now: this.now }, (event) => {
        if (event.type === 'usage') this.bookUsage(owner, event);
        else terminal = event;
      }),
      async () => {
        await cleanup(terminal);
      },
    );

    return {
      runId,
      scopeId: input.scopeId,
      run,
      handle,
      subscribe: () => fanout.subscribe(),
      stop: async () => {
        handle.interrupted = true;
        await run.stop();
        await run.waitForExit(this.postDoneExitGraceMs);
        await cleanup(undefined);
      },
    };
  }

  /**
   * Tell every scope whose process is only running background tasks that the
   * work is being stopped, then stop it — for shutdown / reconnect, where the
   * process dies with this daemon anyway.
   */
  async stopLingering(): Promise<void> {
    const lingering = [...this.live.values()].filter(
      (live) => !live.session.hasExited && !live.session.hasAttachedTurn && !live.finishing,
    );
    await Promise.allSettled(
      lingering.map(async (live) => {
        log.info('run', 'linger-stopped', { ...live.dimensions, reason: 'shutdown', background: live.session.background });
        await this.notify(live, { kind: 'stopped', reason: 'shutdown' });
        await this.retire(live, 'shutdown');
      }),
    );
  }

  /** Keep a process whose user turn ended while its background tasks run on. */
  private startLinger(live: LiveProcess): void {
    this.endLinger(live);
    this.activeRuns.setLingering(live.scopeId, live.session.run);
    live.lingerTimer = setTimeout(() => {
      void this.expireLinger(live);
    }, this.maxBackgroundLingerMs);
    live.lingerTimer.unref?.();
    log.info('run', 'linger-start', {
      ...live.dimensions,
      background: live.session.background,
      maxLingerMs: this.maxBackgroundLingerMs,
    });
  }

  private endLinger(live: LiveProcess): void {
    if (live.lingerTimer) clearTimeout(live.lingerTimer);
    live.lingerTimer = undefined;
    this.activeRuns.clearLingering(live.scopeId, live.session.run);
  }

  private async expireLinger(live: LiveProcess): Promise<void> {
    live.lingerTimer = undefined;
    if (live.session.hasExited || live.session.hasAttachedTurn) return;
    log.warn('run', 'linger-timeout', {
      ...live.dimensions,
      background: live.session.background,
      maxLingerMs: this.maxBackgroundLingerMs,
    });
    await this.notify(live, { kind: 'stopped', reason: 'max-linger', afterMs: this.maxBackgroundLingerMs });
    await this.retire(live, 'max-linger');
  }

  private bookUsage(live: LiveProcess, usage: Extract<AgentEvent, { type: 'usage' }>): void {
    if (!this.usage || !live.actor) return;
    try {
      this.usage.record({
        actorId: live.actor.id,
        ...(live.actor.name ? { actorName: live.actor.name } : {}),
        source: live.source,
        scopeId: live.scopeId,
        usage,
      });
    } catch (err) {
      log.warn('run', 'usage-record-failed', { ...live.dimensions, err: String(err) });
    }
  }

  private deliverBackgroundTurn(live: LiveProcess, events: AgentEvent[]): void {
    for (const event of events) if (event.type === 'usage') this.bookUsage(live, event);
    log.info('run', 'background-turn', {
      ...live.dimensions,
      events: events.length,
      background: live.session.background,
    });
    void this.notify(live, { kind: 'turn', events }).then(async () => {
      // The adapter closes input after a turn that leaves no background tasks;
      // make sure the process then actually goes away.
      if (live.session.background === 0 && !live.session.hasAttachedTurn) await this.finish(live);
    });
  }

  private async notify(live: LiveProcess, turn: BackgroundTurn): Promise<void> {
    if (!live.onBackgroundTurn) return;
    try {
      await live.onBackgroundTurn(turn);
    } catch (err) {
      log.warn('run', 'background-turn-delivery-failed', {
        ...live.dimensions,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Let a process with nothing left to do exit; stop it if it won't. */
  private finish(live: LiveProcess): Promise<void> {
    if (!live.finished) {
      live.finishing = true;
      live.finished = this.awaitExit(live);
    }
    return live.finished;
  }

  private async awaitExit(live: LiveProcess): Promise<void> {
    this.endLinger(live);
    const exited = await live.session.run.waitForExit(this.postDoneExitGraceMs);
    if (!exited) {
      log.warn('run', 'post-done-exit-timeout', {
        ...live.dimensions,
        graceMs: this.postDoneExitGraceMs,
        background: live.session.background,
      });
      await live.session.run.stop().catch((err) => {
        log.warn('run', 'post-done-stop-failed', {
          ...live.dimensions,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
    this.forget(live);
  }

  /** Stop a process that can no longer serve this scope's turns. */
  private async retire(
    live: LiveProcess,
    reason: 'incompatible' | 'input-closed' | 'max-linger' | 'shutdown',
  ): Promise<void> {
    log.info('run', 'retire-process', { ...live.dimensions, reason, background: live.session.background });
    if (reason === 'input-closed') {
      await this.finish(live);
      return;
    }
    if (live.finished) {
      await live.finished;
      return;
    }
    live.finishing = true;
    live.finished = (async () => {
      this.endLinger(live);
      await live.session.run.stop().catch(() => {});
      this.forget(live);
    })();
    await live.finished;
  }

  private forget(live: LiveProcess): void {
    this.endLinger(live);
    if (this.live.get(live.scopeId) === live) this.live.delete(live.scopeId);
  }
}

/** Everything a running process was started with that a later turn must share. */
function runCompatKey(opts: {
  cwd?: string;
  model?: string;
  effort?: string;
  sandbox?: string;
  permissionMode?: string;
  images?: readonly string[];
}): string {
  return JSON.stringify([
    opts.cwd ?? null,
    opts.model ?? null,
    opts.effort ?? null,
    opts.sandbox ?? null,
    opts.permissionMode ?? null,
    // Image arguments ride on argv; a turn that carries them needs a new process.
    opts.images?.length ? opts.images : null,
  ]);
}

function observeRunEvents(
  events: AsyncIterable<AgentEvent>,
  opts: {
    dimensions: Record<string, unknown>;
    startedAt: number;
    now: () => number;
  },
  onEvent: (event: AgentEvent) => void,
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      for await (const event of events) {
        if (isTerminalEvent(event) || event.type === 'usage') onEvent(event);
        if (event.type === 'done') {
          log.info('run', 'completed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
          });
          yield event;
          return;
        }
        if (event.type === 'error') {
          log.warn('run', 'failed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
            error: event.message,
          });
          yield event;
          return;
        }
        yield event;
      }
    },
  };
}

class EventFanout {
  private readonly source: AsyncIterable<AgentEvent>;
  private readonly onDone: () => Promise<void>;
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private started = false;
  private done = false;
  private error: unknown;

  constructor(source: AsyncIterable<AgentEvent>, onDone: () => Promise<void>) {
    this.source = source;
    this.onDone = onDone;
  }

  subscribe(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<AgentEvent>> => {
            this.start();
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            if (this.done) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              const wake = (): void => {
                this.waiters.delete(wake);
                resolve();
              };
              this.waiters.add(wake);
            });
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.source) {
        this.buffer.push(event);
        this.wakeAll();
        if (isTerminalEvent(event)) break;
      }
    } catch (err) {
      this.error = err;
    } finally {
      // Start cleanup first (it frees the scope and pool slot synchronously),
      // then end the subscriptions: consumers must not wait for the process
      // to finish exiting, which can take a while (see exitGraceMs).
      const cleanup = this.onDone();
      this.done = true;
      this.wakeAll();
      await cleanup;
    }
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }
}
