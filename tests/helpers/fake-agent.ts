import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../../src/agent/types.js';

export interface FakeAgentRun extends AgentRun {
  readonly opts: AgentRunOptions;
  readonly injected: string[];
  release(): void;
  readonly stopped: boolean;
  readonly waitForExitCalls: number;
}

/**
 * A run that stops after `afterEvents` events and waits — for a supplement
 * (`inject`, which it reports as a `supplement` event) or for `release()` —
 * before emitting the rest, like a CLI busy with a long tool call.
 */
export interface FakePause {
  afterEvents: number;
}

/** Events the process emits on its own after its user turn (a background task reporting back). */
export interface FakeBackgroundTurn {
  afterMs: number;
  events: readonly AgentEvent[];
}

class FakeRun implements FakeAgentRun {
  readonly runId: string;
  readonly opts: AgentRunOptions;
  readonly events: AsyncIterable<AgentEvent>;
  readonly waitForExitResult: boolean;
  /** Present only for runs with a background turn, like a streamed-input CLI. */
  send?: (prompt: string) => boolean;
  /** Present only for paused runs, like a CLI that takes input mid-turn. */
  inject?: (prompt: string, preview: string) => boolean;
  /** Prompts handed over through `inject`. */
  readonly injected: string[] = [];
  #stopped = false;
  #waitForExitCalls = 0;
  #finished = false;
  #resume: (() => void) | undefined;
  #pendingSupplements: string[] = [];

  constructor(
    opts: AgentRunOptions,
    events: readonly AgentEvent[],
    waitForExitResult: boolean,
    background?: FakeBackgroundTurn,
    pause?: FakePause,
  ) {
    this.runId = opts.runId;
    this.opts = opts;
    this.waitForExitResult = waitForExitResult;
    this.events = this.iterate(events, background, pause);
    if (background) this.send = () => false;
    if (pause) {
      this.inject = (prompt, preview) => {
        if (this.#finished) return false;
        this.injected.push(prompt);
        this.#pendingSupplements.push(preview);
        this.release();
        return true;
      };
    }
  }

  /** Let a paused run go on without a supplement. */
  release(): void {
    const resume = this.#resume;
    this.#resume = undefined;
    resume?.();
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  get waitForExitCalls(): number {
    return this.#waitForExitCalls;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
  }

  async waitForExit(): Promise<boolean> {
    this.#waitForExitCalls++;
    return this.waitForExitResult;
  }

  private async *iterate(
    events: readonly AgentEvent[],
    background: FakeBackgroundTurn | undefined,
    pause: FakePause | undefined,
  ): AsyncIterable<AgentEvent> {
    for (const [index, event] of events.entries()) {
      if (this.#stopped) return;
      if (pause && index === pause.afterEvents) {
        await new Promise<void>((resolve) => {
          this.#resume = resolve;
        });
        for (const preview of this.#pendingSupplements.splice(0)) yield { type: 'supplement', preview };
      }
      if (event.type === 'done' || event.type === 'error') this.#finished = true;
      yield event;
    }
    this.#finished = true;
    if (!background) return;
    await new Promise((resolve) => setTimeout(resolve, background.afterMs));
    for (const event of background.events) {
      if (this.#stopped) return;
      yield event;
    }
  }
}

export type FakeAgentEvents =
  | readonly AgentEvent[]
  | readonly (readonly AgentEvent[])[];

export class FakeAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly runs: FakeAgentRun[] = [];
  readonly runOptions: AgentRunOptions[] = [];
  botIdentity: AgentBotIdentity | undefined;
  #available: boolean;
  #eventRuns: AgentEvent[][];
  #waitForExitResults: boolean[];
  #background: FakeBackgroundTurn | undefined;
  #pause: FakePause | undefined;

  constructor(options: {
    id?: string;
    displayName?: string;
    available?: boolean;
    events?: FakeAgentEvents;
    waitForExit?: boolean | readonly boolean[];
    /** Background turn emitted by the first run after its user turn. */
    background?: FakeBackgroundTurn;
    /** The first run pauses mid-turn and takes supplements. */
    pause?: FakePause;
  } = {}) {
    this.id = options.id ?? 'fake-agent';
    this.displayName = options.displayName ?? 'Fake Agent';
    this.#available = options.available ?? true;
    this.#eventRuns = normalizeEventRuns(options.events ?? []);
    this.#waitForExitResults = normalizeWaitForExitResults(options.waitForExit);
    this.#background = options.background;
    this.#pause = options.pause;
  }

  async isAvailable(): Promise<boolean> {
    return this.#available;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  run(opts: AgentRunOptions): AgentRun {
    this.runOptions.push(opts);
    const events = this.#eventRuns.shift() ?? [];
    const waitForExitResult = this.#waitForExitResults.shift() ?? true;
    const background = this.#background;
    this.#background = undefined;
    const pause = this.#pause;
    this.#pause = undefined;
    const run = new FakeRun(opts, events, waitForExitResult, background, pause);
    this.runs.push(run);
    return run;
  }

  enqueue(...events: AgentEvent[]): void {
    if (this.#eventRuns.length === 0) this.#eventRuns.push([]);
    this.#eventRuns[0]?.push(...events);
  }

  setEvents(events: FakeAgentEvents): void {
    this.#eventRuns = normalizeEventRuns(events);
  }

  setAvailable(available: boolean): void {
    this.#available = available;
  }

  setWaitForExit(result: boolean | readonly boolean[]): void {
    this.#waitForExitResults = normalizeWaitForExitResults(result);
  }
}

export function createFakeAgent(events: readonly AgentEvent[] = []): FakeAgentAdapter {
  return new FakeAgentAdapter({ events });
}

function normalizeEventRuns(events: FakeAgentEvents): AgentEvent[][] {
  if (events.length === 0) return [];
  return Array.isArray(events[0])
    ? (events as readonly (readonly AgentEvent[])[]).map((runEvents) => [...runEvents])
    : [[...(events as readonly AgentEvent[])]];
}

function normalizeWaitForExitResults(result: boolean | readonly boolean[] | undefined): boolean[] {
  if (result === undefined) return [];
  if (typeof result === 'boolean') return [result];
  return [...result];
}
