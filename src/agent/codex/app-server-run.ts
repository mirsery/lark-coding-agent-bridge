import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { CodexSandboxMode } from '../../config/permissions';
import { log } from '../../core/logger';
import { spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import type { AgentEvent, AgentRun, RunApprovals } from '../types';
import { isReadOnlyCommand } from '../../runtime/approvals';
import { CodexAppServerTranslator } from './app-server-translator';
import { codexRateLimitEvent } from './rate-limit';

type AppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface CodexAppServerRunOptions {
  runId: string;
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** `-c key=value` overrides, same as the `exec` path passes. */
  config: readonly string[];
  /** First turn's text, bridge system prompt already applied. */
  prompt: string;
  images?: readonly string[];
  threadId?: string;
  model?: string;
  effort?: string;
  sandbox: CodexSandboxMode;
  stopGraceMs: number;
  clientVersion: string;
  /**
   * Gated run: Codex asks before running anything outside its read-only
   * sandbox (approvalPolicy "untrusted"), and each ask goes to `decide`.
   */
  approvals?: RunApprovals;
  /** Called when the app-server never got a conversation open (unsupported, hung, crashed). */
  onStartupFailure?: (reason: string) => void;
  /** How long handshake + opening the thread may take. */
  startupTimeoutMs?: number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;
/** How long a refused turn waits for the rate-limit snapshot before giving up on it. */
const RATE_LIMIT_READ_TIMEOUT_MS = 5_000;

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

/**
 * One long-lived `codex app-server` process serving a conversation: the
 * first turn starts or resumes the thread, `send` runs the next turn in the
 * same process (no new Codex start-up), `stop` interrupts cleanly with
 * `turn/interrupt` before falling back to signals. Events of every turn flow
 * through one stream that ends when the process exits — the same contract
 * the Claude adapter's streamed-input runs have, so RunExecutor reuses it.
 */
export function startCodexAppServerRun(opts: CodexAppServerRunOptions): AgentRun {
  const child = spawnProcess(opts.binary, ['app-server', '--listen', 'stdio://', ...opts.config], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as AppServerChild;
  log.info('agent', 'spawn', {
    pid: child.pid ?? null,
    cwd: opts.cwd,
    transport: 'app-server',
    hasThread: Boolean(opts.threadId),
    promptChars: opts.prompt.length,
    images: opts.images?.length ?? 0,
    model: opts.model,
    effort: opts.effort,
  });

  const queue = new EventQueue();
  const pending = new Map<number, Pending>();
  const stderr: string[] = [];
  let nextId = 0;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let turn: CodexAppServerTranslator | undefined;
  let inputOpen = true;
  let exited = false;
  let stopRequested = false;
  /** Paths each pending file-change item touches, for its approval prompt. */
  const fileChanges = new Map<string, string[]>();
  /**
   * Mid-turn supplements (`inject`) sent with `turn/steer` but not yet read:
   * Codex echoes each as a `userMessage` item carrying our client id once the
   * turn takes it in.
   */
  const unread = new Map<string, { prompt: string; preview: string }>();
  /** `turn/steer` requests still waiting for their answer. */
  const steers = new Set<Promise<void>>();
  /** A finished turn's closing events, held while a supplement is still unread. */
  let held: AgentEvent[] | undefined;

  const write = (message: Record<string, unknown>): boolean => {
    if (!inputOpen || exited) return false;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`, 'utf8');
    return true;
  };
  const request = (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      if (!write({ id, method, ...(params ? { params } : {}) })) {
        pending.delete(id);
        reject(new Error(`codex app-server no longer accepts requests (${method})`));
      }
    });
  const closeInput = (): void => {
    if (!inputOpen) return;
    inputOpen = false;
    child.stdin.end();
  };

  const emit = (events: AgentEvent[]): void => {
    for (const event of events) queue.push(event);
    if (turn?.done) {
      turn = undefined;
      turnId = undefined;
    }
  };

  /**
   * The turn completed while a supplement was still unread — its steer was
   * refused (the turn was already wrapping up) or is still in flight. That is
   * not the end of the bridge's turn: once every steer has its answer, what
   * is left goes to Codex as a follow-up turn of the same conversation, and
   * the held answer becomes progress text before it.
   */
  const holdForSupplements = (events: AgentEvent[]): void => {
    held = events;
    void Promise.allSettled([...steers]).then(() => {
      const closing = held;
      if (!closing || exited) return;
      held = undefined;
      const left = [...unread.values()];
      unread.clear();
      if (left.length === 0 || stopRequested) {
        emit(closing);
        return;
      }
      let usage: Extract<AgentEvent, { type: 'usage' }> | undefined;
      for (const event of closing) {
        if (event.type === 'done') continue;
        if (event.type === 'usage') usage = event;
        else queue.push(event.type === 'final_text' ? { type: 'text', delta: event.content } : event);
      }
      for (const supplement of left) queue.push({ type: 'supplement', preview: supplement.preview });
      log.info('codex-app-server', 'supplement-follow-up-turn', { pid: child.pid ?? null, count: left.length });
      turn = undefined;
      turnId = undefined;
      const next = startTurn(left.map((supplement) => supplement.prompt).join('\n\n'), undefined);
      if (usage) next?.carryUsage(usage);
    });
  };

  /**
   * The plan's quota refused the turn. Hold its end until Codex says which
   * window ran out and when it reopens (`account/rateLimits/read`, never a
   * reset credit), and report that first: the run then ends paused and the
   * bridge resumes it after the reset, as with Claude.
   */
  const holdForQuota = (events: AgentEvent[], message: string): void => {
    held = events;
    const at = Date.now();
    void Promise.race([
      request('account/rateLimits/read').catch(() => undefined),
      delay(RATE_LIMIT_READ_TIMEOUT_MS).then(() => undefined),
    ]).then((snapshot) => {
      const closing = held;
      if (!closing) return;
      held = undefined;
      const limit = codexRateLimitEvent(snapshot, { blocked: true, message, at });
      log.info('codex-app-server', 'usage-limit', {
        limitType: limit?.limitType ?? null,
        resetsAt: limit?.resetsAt ? new Date(limit.resetsAt).toISOString() : null,
        fromSnapshot: snapshot !== undefined,
      });
      if (limit) queue.push(limit);
      emit(closing);
    });
  };

  const startTurn = (prompt: string, images: readonly string[] | undefined): CodexAppServerTranslator | undefined => {
    if (!threadId) return undefined;
    const started = new CodexAppServerTranslator(threadId);
    turn = started;
    emit(started.start());
    request('turn/start', {
      threadId,
      input: [
        { type: 'text', text: prompt, text_elements: [] },
        ...(images ?? []).map((path) => ({ type: 'localImage', path })),
      ],
      ...(opts.effort ? { effort: opts.effort } : {}),
    })
      .then((result) => {
        turnId ??= str(record(result.turn)?.id);
      })
      .catch((err: Error) => emit(turn?.fail(`codex app-server rejected turn/start: ${err.message}`) ?? []));
    return started;
  };

  const onLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown> | undefined;
    try {
      msg = record(JSON.parse(trimmed));
    } catch {
      return;
    }
    if (!msg) return;
    const method = str(msg.method);
    if (method === undefined && typeof msg.id === 'number') {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      const error = record(msg.error);
      if (error) waiter?.reject(new Error(str(error.message) ?? 'codex app-server error'));
      else waiter?.resolve(record(msg.result) ?? {});
      return;
    }
    if (method && msg.id !== undefined) {
      const params = record(msg.params) ?? {};
      const requestId = msg.id;
      const approval = approvalRequest(method, params, fileChanges);
      if (approval && opts.approvals) {
        // Answer only after a person decided; Codex waits meanwhile.
        void opts.approvals
          .decide(approval)
          .catch(() => ({ decision: 'deny' as const, reason: 'approval failed' }))
          .then((answer) => write({ id: requestId, result: { decision: answer.decision === 'allow' ? 'accept' : 'decline' } }));
        return;
      }
      // Anything else (or an approval on an ungated run, which uses
      // approvalPolicy "never"): refuse rather than leave Codex waiting.
      log.warn('codex-app-server', 'server-request-refused', { method });
      write({ id: requestId, error: { code: -32601, message: 'not supported by lark-channel-bridge' } });
      return;
    }
    if (!method) return;
    const params = record(msg.params) ?? {};
    if (method === 'item/started') {
      const item = record(params.item);
      if (item?.type === 'fileChange' && typeof item.id === 'string') fileChanges.set(item.id, changedPaths(item));
    }
    if (method === 'turn/started') turnId = str(record(params.turn)?.id) ?? turnId;
    if (method === 'item/started') {
      // A supplement sent with turn/steer was read: Codex echoes it back.
      const item = record(params.item);
      const clientId = item?.type === 'userMessage' ? str(item.clientId) : undefined;
      const supplement = clientId === undefined ? undefined : unread.get(clientId);
      if (clientId !== undefined && supplement) {
        unread.delete(clientId);
        queue.push({ type: 'supplement', preview: supplement.preview });
      }
    }
    if (!turn) return;
    if (method === 'account/rateLimits/updated' && !turn.done) {
      const update = codexRateLimitEvent(params, { blocked: false, at: Date.now() });
      if (update) queue.push(update);
    }
    const events = turn.notification(method, params);
    if (!turn.done) return emit(events);
    const usageLimit = turn.usageLimit;
    if (usageLimit && events.at(-1)?.type === 'error' && !stopRequested) return holdForQuota(events, usageLimit);
    if (unread.size > 0 && events.at(-1)?.type === 'done' && !stopRequested) return holdForSupplements(events);
    // Supplements still unread when a turn fails or stops are gone with it.
    unread.clear();
    emit(events);
  };

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', onLine);
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderr.push(text);
    for (const line of text.split('\n')) if (line.trim()) log.warn('agent', 'stderr', { line });
  });
  child.stdin.on('error', (err) => log.warn('agent', 'stdin-error', { message: err.message }));
  child.on('error', (err) => {
    emit(turn?.fail(`failed to spawn codex: ${err.message}`) ?? [{ type: 'error', message: `failed to spawn codex: ${err.message}`, terminationReason: 'failed' }]);
  });
  child.on('exit', (code, signal) => {
    exited = true;
    inputOpen = false;
    log.info('agent', 'exit', { pid: child.pid ?? null, code, signal, transport: 'app-server' });
    for (const waiter of pending.values()) waiter.reject(new Error('codex app-server exited'));
    pending.clear();
    unread.clear();
    if (held) {
      // The turn had finished; nothing is left to read its supplements.
      const closing = held;
      held = undefined;
      emit(closing);
    }
    if (turn) {
      emit(
        stopRequested
          ? [{ type: 'done', threadId: threadId ?? '', terminationReason: 'interrupted' }]
          : turn.fail(`codex app-server exited with code ${code ?? signal}${tail(stderr)}`),
      );
      turn = undefined;
    }
    // Let readline drain whatever stdout still holds, then end the stream.
    setImmediate(() => queue.end());
  });

  // Start-up: handshake, open the conversation, run the first turn.
  void (async () => {
    const startupTimer = setTimeout(() => {
      for (const waiter of pending.values()) waiter.reject(new Error('timed out'));
      pending.clear();
    }, opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    try {
      await request('initialize', {
        clientInfo: { name: 'lark-channel-bridge', title: 'Lark Channel Bridge', version: opts.clientVersion },
        capabilities: null,
      });
      write({ method: 'initialized' });
      const threadParams = {
        cwd: opts.cwd,
        // Gated: read-only sandbox, and Codex asks before stepping outside it.
        sandbox: opts.approvals ? 'read-only' : opts.sandbox,
        approvalPolicy: opts.approvals ? 'untrusted' : 'never',
        ...(opts.model ? { model: opts.model } : {}),
      };
      const opened = opts.threadId
        ? await request('thread/resume', { ...threadParams, threadId: opts.threadId })
        : await request('thread/start', threadParams);
      threadId = str(record(opened.thread)?.id) ?? opts.threadId;
      if (!threadId) throw new Error('codex app-server returned no thread id');
      clearTimeout(startupTimer);
      startTurn(opts.prompt, opts.images);
    } catch (err) {
      clearTimeout(startupTimer);
      const reason = err instanceof Error ? err.message : String(err);
      const message = `codex app-server start-up failed: ${reason}${tail(stderr)}`;
      log.warn('codex-app-server', 'startup-failed', { reason: message.slice(0, 500) });
      // A stop during start-up is the user's doing, not a broken app-server.
      if (!stopRequested) opts.onStartupFailure?.(reason);
      emit([{ type: 'error', message, terminationReason: 'failed' }]);
      closeInput();
      if (!exited) child.kill('SIGTERM');
    }
  })();

  return {
    runId: opts.runId,
    events: queue,
    send(prompt: string): boolean {
      if (exited || !inputOpen || !threadId || turn) return false;
      startTurn(prompt, undefined);
      return true;
    },
    inject(prompt: string, preview: string): boolean {
      // Only a turn under way can take it; otherwise the caller queues it.
      if (exited || !inputOpen || !threadId || !turnId || !turn || turn.done || held) {
        log.info('agent', 'inject-refused', { pid: child.pid ?? null, transport: 'app-server' });
        return false;
      }
      const clientId = randomUUID();
      unread.set(clientId, { prompt, preview });
      const steer = request('turn/steer', {
        threadId,
        expectedTurnId: turnId,
        clientUserMessageId: clientId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      }).then(
        () => undefined,
        // Still unread: the turn's end sends it as a follow-up turn.
        (err: Error) => log.warn('codex-app-server', 'steer-refused', { reason: err.message.slice(0, 300) }),
      );
      steers.add(steer);
      void steer.finally(() => steers.delete(steer));
      log.info('agent', 'inject', { pid: child.pid ?? null, transport: 'app-server', promptChars: prompt.length });
      return true;
    },
    endInput(): void {
      closeInput();
    },
    async stop(): Promise<void> {
      if (exited) return;
      stopRequested = true;
      // Ask Codex to stop the turn itself first: no orphaned tool processes,
      // and the thread records the interruption.
      if (turn && threadId && turnId) {
        await Promise.race([
          request('turn/interrupt', { threadId, turnId }).catch(() => undefined),
          delay(2_000),
        ]);
      }
      closeInput();
      if (await waitForExit(child, opts.stopGraceMs)) return;
      log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: opts.stopGraceMs });
      child.kill('SIGTERM');
      if (await waitForExit(child, opts.stopGraceMs)) return;
      log.warn('agent', 'stop-sigkill', { pid: child.pid ?? null, graceMs: opts.stopGraceMs });
      child.kill('SIGKILL');
    },
    waitForExit(timeoutMs: number): Promise<boolean> {
      return waitForExit(child, timeoutMs);
    },
  };
}

/** The approval a Codex server request asks for, or undefined when it is not one. */
function approvalRequest(
  method: string,
  params: Record<string, unknown>,
  fileChanges: Map<string, string[]>,
): { tool: string; summary: string; readOnly?: boolean; command?: string } | undefined {
  if (method === 'item/commandExecution/requestApproval') {
    const raw = str(params.command);
    if (raw === undefined) return { tool: 'command_execution', summary: '(command)', readOnly: false };
    const command = unwrapShellCommand(raw, params.proposedExecpolicyAmendment);
    return { tool: 'command_execution', summary: command, readOnly: isReadOnlyCommand(command), command };
  }
  if (method === 'item/fileChange/requestApproval') {
    const paths = fileChanges.get(str(params.itemId) ?? '') ?? [];
    const root = str(params.grantRoot);
    return {
      tool: 'file_change',
      summary: paths.length > 0 ? `修改文件：${paths.join(', ')}` : root ? `写入目录：${root}` : '修改文件',
    };
  }
  return undefined;
}

const SHELLS = new Set(['sh', 'bash', 'zsh']);

/**
 * The script inside Codex's shell wrapper. Approval requests carry the
 * command as `/bin/zsh -lc "<script>"`, plus the same as argv in
 * `proposedExecpolicyAmendment`; prefer the argv, else undo the quoting.
 * Anything not in that shape comes back unchanged (and so is judged as is).
 */
export function unwrapShellCommand(command: string, argv?: unknown): string {
  if (Array.isArray(argv) && argv.length === 3 && argv.every((a) => typeof a === 'string')) {
    const [shell, flag, script] = argv as string[];
    if (SHELLS.has(shell!.split('/').pop()!) && (flag === '-lc' || flag === '-c')) return script!;
  }
  const m = /^(?:\S*\/)?(sh|bash|zsh) -l?c (.+)$/s.exec(command.trim());
  if (!m) return command;
  const quoted = m[2]!;
  if (quoted.length >= 2 && quoted.startsWith("'") && quoted.endsWith("'")) {
    const inner = quoted.slice(1, -1).replace(/'\\''/g, '\u0000');
    return inner.includes("'") ? command : inner.replace(/\u0000/g, "'");
  }
  if (quoted.length >= 2 && quoted.startsWith('"') && quoted.endsWith('"')) {
    const inner = quoted.slice(1, -1);
    if (/(^|[^\\])(\\\\)*"/.test(inner)) return command;
    return inner.replace(/\\(["\\$`])/g, '$1');
  }
  return command;
}

function changedPaths(item: Record<string, unknown>): string[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return changes.map((c) => str(record(c)?.path)).filter((p): p is string => Boolean(p));
}

function waitForExit(child: AppServerChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(stderr: string[]): string {
  const text = stderr.join('').trim();
  return text ? `: ${text.slice(-500)}` : '';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Push-driven event stream shared by every turn of the process. */
class EventQueue implements AsyncIterable<AgentEvent> {
  private readonly items: AgentEvent[] = [];
  private ended = false;
  private wake: (() => void) | undefined;

  push(event: AgentEvent): void {
    if (this.ended) return;
    this.items.push(event);
    this.notify();
  }

  end(): void {
    this.ended = true;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}
