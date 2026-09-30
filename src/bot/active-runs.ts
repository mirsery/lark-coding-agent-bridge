import type { AgentRun } from '../agent/types';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  /** When the run was registered — the in-memory fallback for elapsed-time
   * display when no durable RunRecord exists (e.g. comment runs). */
  startedAt: number;
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();
  private readonly reservations = new Set<string>();
  /**
   * Processes whose user turn is over but which are still running background
   * tasks the agent started (see RunExecutor). Not "active": new messages for
   * the scope are handed to them rather than queued. Interrupts stop them.
   */
  private readonly lingering = new Map<string, AgentRun>();
  private pauseDepth = 0;
  private pauseReason: string | undefined;

  reserve(chatId: string): (() => void) | undefined {
    if (this.handles.has(chatId) || this.reservations.has(chatId)) return undefined;
    this.reservations.add(chatId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservations.delete(chatId);
    };
  }

  register(chatId: string, run: AgentRun, startedAt: number = Date.now()): RunHandle {
    if (this.handles.has(chatId)) {
      throw new Error(`run already active for scope: ${chatId}`);
    }
    this.reservations.delete(chatId);
    const handle: RunHandle = { run, interrupted: false, startedAt };
    this.handles.set(chatId, handle);
    return handle;
  }

  pauseNewRuns(reason: string): () => void {
    this.pauseDepth++;
    this.pauseReason = reason;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pauseDepth = Math.max(0, this.pauseDepth - 1);
      if (this.pauseDepth === 0) this.pauseReason = undefined;
    };
  }

  newRunsPaused(): boolean {
    return this.pauseDepth > 0;
  }

  newRunsPauseReason(): string | undefined {
    return this.pauseReason;
  }

  get(chatId: string): RunHandle | undefined {
    return this.handles.get(chatId);
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }

  snapshot(): RunHandle[] {
    return [...this.handles.values()];
  }

  /** Scope → handle pairs, for views that need to know *which* scope runs. */
  entries(): Array<{ scope: string; handle: RunHandle }> {
    return [...this.handles.entries()].map(([scope, handle]) => ({ scope, handle }));
  }

  scopes(): string[] {
    return [...this.handles.keys()];
  }

  setLingering(chatId: string, run: AgentRun): void {
    this.lingering.set(chatId, run);
  }

  clearLingering(chatId: string, run: AgentRun): void {
    if (this.lingering.get(chatId) === run) this.lingering.delete(chatId);
  }

  isLingering(chatId: string): boolean {
    return this.lingering.has(chatId);
  }

  lingeringScopes(): string[] {
    return [...this.lingering.keys()];
  }

  /**
   * Interrupt the current run for this chat, if any, and any background
   * tasks its process is still running. Returns true if anything was
   * stopped. Fires stop() fire-and-forget — the old run's generator exits on
   * its own as the subprocess dies.
   */
  interrupt(chatId: string): boolean {
    const result = this.interruptDetailed(chatId);
    return result.active || result.background;
  }

  /** {@link interrupt}, reporting whether a user turn and/or background work was stopped. */
  interruptDetailed(chatId: string): { active: boolean; background: boolean } {
    const lingering = this.lingering.get(chatId);
    if (lingering) {
      this.lingering.delete(chatId);
      void lingering.stop().catch(() => {
        /* stop errors are non-fatal */
      });
    }
    const h = this.handles.get(chatId);
    if (!h) return { active: false, background: Boolean(lingering) };
    this.reservations.delete(chatId);
    h.interrupted = true;
    this.handles.delete(chatId);
    void h.run.stop().catch(() => {
      /* stop errors are non-fatal */
    });
    return { active: true, background: Boolean(lingering) };
  }

  async stopAll(): Promise<void> {
    const all = [...this.handles.values()];
    const lingering = [...this.lingering.values()];
    this.handles.clear();
    this.reservations.clear();
    this.lingering.clear();
    for (const h of all) h.interrupted = true;
    await Promise.allSettled([...all.map((h) => h.run.stop()), ...lingering.map((run) => run.stop())]);
  }

  async waitForAll(timeoutMs = 300_000): Promise<void> {
    const all = [...this.handles.values()];
    await Promise.allSettled(all.map((h) => h.run.waitForExit(timeoutMs)));
  }
}
