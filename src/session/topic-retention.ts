import type { ChatContextCursorStore } from '../bot/chat-context';
import { log } from '../core/logger';
import type { SessionCatalog } from './catalog';
import type { PendingRotationStore } from './rotation-store';
import type { SessionStore } from './store';

const DEFAULT_INTERVAL_MS = 60 * 60_000;
const TOPIC_SCOPE = /^oc_[^:]+:omt_[^:]+$/;

export interface ExpireTopicSessionsInput {
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  pendingRotations: PendingRotationStore;
  contextCursors: ChatContextCursorStore;
  retentionMonths: number;
  isProtected(scopeId: string): boolean;
  onExpire?(scopeId: string): void;
  now?: number;
}

export interface StartTopicSessionRetentionInput
  extends Omit<ExpireTopicSessionsInput, 'retentionMonths' | 'now'> {
  retentionMonths(): number;
  now?: () => number;
  intervalMs?: number;
}

/** The exact bridge scope shape emitted for a Lark topic thread. */
export function isTopicSessionScope(scopeId: string): boolean {
  return TOPIC_SCOPE.test(scopeId);
}

/** Add whole host-local calendar months, clamping month-end dates (Jan 31 + 1 = Feb 28/29). */
export function topicSessionExpiresAt(lastActivityAt: number, months: number): number {
  const source = new Date(lastActivityAt);
  const targetMonth = source.getMonth() + months;
  const targetYear = source.getFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(targetYear, normalizedMonth + 1, 0).getDate();
  return new Date(
    targetYear,
    normalizedMonth,
    Math.min(source.getDate(), lastDay),
    source.getHours(),
    source.getMinutes(),
    source.getSeconds(),
    source.getMilliseconds(),
  ).getTime();
}

/** Remove expired bridge-owned resumable state. Native Lark/agent history is untouched. */
export async function expireTopicSessions(input: ExpireTopicSessionsInput): Promise<string[]> {
  if (!Number.isSafeInteger(input.retentionMonths) || input.retentionMonths <= 0) return [];
  const now = input.now ?? Date.now();
  const activity = new Map<string, number>();
  for (const { scopeId, entry } of input.sessions.entries()) {
    if (!entry.sessionId || !entry.cwd || !isTopicSessionScope(scopeId)) continue;
    activity.set(scopeId, Math.max(activity.get(scopeId) ?? 0, entry.updatedAt));
  }
  for (const entry of input.sessionCatalog?.entries() ?? []) {
    if (!isTopicSessionScope(entry.scopeId)) continue;
    activity.set(entry.scopeId, Math.max(activity.get(entry.scopeId) ?? 0, entry.updatedAt));
  }

  const expired: string[] = [];
  for (const [scopeId, lastActivityAt] of activity) {
    if (!Number.isFinite(lastActivityAt)) continue;
    const expiresAt = topicSessionExpiresAt(lastActivityAt, input.retentionMonths);
    if (!Number.isFinite(expiresAt) || expiresAt > now) continue;
    // All mutations below are synchronous until the final flush, so a new run
    // cannot enter between this last protection check and the removals.
    if (input.isProtected(scopeId)) continue;
    input.sessions.clear(scopeId);
    input.sessionCatalog?.removeScope(scopeId);
    input.pendingRotations.delete(scopeId);
    input.contextCursors.delete(scopeId);
    input.onExpire?.(scopeId);
    expired.push(scopeId);
    log.info('session-retention', 'topic-expired', {
      scope: scopeId,
      months: input.retentionMonths,
      lastActivityAt,
    });
  }
  if (expired.length > 0) {
    await Promise.all([
      input.sessions.flush(),
      input.sessionCatalog?.flush(),
      input.pendingRotations.flush(),
      input.contextCursors.flush(),
    ]);
  }
  return expired;
}

/** Hourly scheduler whose getter makes Web and /config edits effective live. */
export function startTopicSessionRetention(input: StartTopicSessionRetentionInput): {
  sweep(): Promise<void>;
  stop(): Promise<void>;
} {
  let stopped = false;
  let running: Promise<unknown> | undefined;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running.then(() => undefined);
    const months = input.retentionMonths();
    if (months === 0) return Promise.resolve();
    running = expireTopicSessions({
      ...input,
      retentionMonths: months,
      now: input.now?.() ?? Date.now(),
    })
      .catch((err: unknown) => log.warn('session-retention', 'sweep-failed', { err: String(err) }))
      .finally(() => {
        running = undefined;
      });
    return running.then(() => undefined);
  };
  const timer = setInterval(() => void tick(), input.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  void tick();
  return {
    sweep: tick,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
