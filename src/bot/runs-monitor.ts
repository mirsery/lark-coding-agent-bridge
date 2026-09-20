import type { ActiveRuns } from './active-runs';
import type { PendingQueue } from './pending-queue';
import type { RunRegistry } from '../runtime/run-registry';

/** One in-flight run of the hosting process, as the web console sees it. */
export interface ScopeRunSnapshot {
  /** Session scope key (`chatId`, `chatId:threadId`, `comment:…`, `meeting:…`). */
  scope: string;
  /** Where the run came from. Non-IM prefixes other than `comment:` (e.g. a
   * meeting scope) are reported as `im` — the wire type stays small and the
   * scope string still tells the whole story. */
  source: 'im' | 'comment';
  chatId?: string;
  threadId?: string;
  promptPreview: string;
  startedAt: number;
  /** Messages queued behind this run in the in-memory pending queue. */
  queueDepth: number;
}

/**
 * The console's window into one connected profile's live runs. Late-bound onto
 * `Controls` by startChannel (like `meeting`) because everything it reads —
 * ActiveRuns, PendingQueue, RunRegistry — is local to the channel instance.
 */
export interface RunsMonitor {
  snapshot(): ScopeRunSnapshot[];
  /** Exactly the IM `/stop` path: interrupt the scope's active run, if any. */
  interrupt(scope: string): boolean;
}

/** Scopes that are not plain `chatId[:threadId]` IM scopes. */
const NON_IM_PREFIX = /^(comment|meeting):/;

export function createRunsMonitor(deps: {
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  runs?: RunRegistry;
}): RunsMonitor {
  return {
    snapshot: () => {
      // Durable IM records carry the fields ActiveRuns doesn't (prompt
      // preview, origin chat); match them up by scope.
      const records = new Map((deps.runs?.listOwn() ?? []).map((r) => [r.scope, r]));
      return deps.activeRuns.entries().map(({ scope, handle }) => {
        const rec = records.get(scope);
        const isIm = !NON_IM_PREFIX.test(scope);
        const sep = scope.indexOf(':');
        const chatId = rec?.chatId ?? (isIm ? (sep === -1 ? scope : scope.slice(0, sep)) : undefined);
        const threadId =
          rec?.threadId ?? (isIm && sep !== -1 ? scope.slice(sep + 1) : undefined);
        return {
          scope,
          source: scope.startsWith('comment:') ? ('comment' as const) : ('im' as const),
          ...(chatId ? { chatId } : {}),
          ...(threadId ? { threadId } : {}),
          promptPreview: rec?.promptPreview ?? (isIm ? '' : scope),
          startedAt: rec?.startedAt ?? handle.startedAt,
          queueDepth: deps.pending.depth(scope),
        };
      });
    },
    interrupt: (scope) => deps.activeRuns.interrupt(scope),
  };
}
