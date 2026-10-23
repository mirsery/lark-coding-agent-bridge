import type { AgentEvent } from '../types';

type RateLimitEvent = Extract<AgentEvent, { type: 'rate_limit' }>;

/**
 * Codex's usage-limit refusal, in both transports: app-server tags it
 * `codexErrorInfo: "usageLimitExceeded"`, `exec --json` only has the text.
 * Real samples: tests/fixtures/codex-usage-limit.json.
 */
export const USAGE_LIMIT_ERROR_INFO = 'usageLimitExceeded';
const USAGE_LIMIT_TEXT = /\b(?:hit|reached) your usage limit\b/i;

export function isUsageLimitMessage(message: string | undefined): boolean {
  return message !== undefined && USAGE_LIMIT_TEXT.test(message);
}

interface RateWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

/** Codex window length → the bridge's window names (`limitLabel`, run cards). */
function windowKind(minutes: number | undefined): string {
  if (minutes === 300) return 'five_hour';
  if (minutes === 10_080) return 'seven_day';
  return minutes ? `${minutes}_minutes` : 'window';
}

/**
 * A `rate_limit` event from Codex's rate-limit snapshot (`account/rateLimits/read`
 * result or `account/rateLimits/updated` params). Blocked: the window that
 * ran out — the one reopening last when several did — names the limit and
 * the reset. Undefined when the snapshot has no window to report.
 */
export function codexRateLimitEvent(
  snapshot: unknown,
  opts: { blocked: boolean; message?: string; at: number },
): RateLimitEvent | undefined {
  const bucket = codexBucket(snapshot);
  const windows: NonNullable<RateLimitEvent['windows']> = [];
  for (const window of [bucket?.primary, bucket?.secondary]) {
    if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) continue;
    const minutes = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : undefined;
    windows.push({
      kind: windowKind(minutes),
      usedPercent: window.usedPercent,
      ...(typeof window.resetsAt === 'number' ? { resetsAt: window.resetsAt * 1000 } : {}),
    });
  }
  if (windows.length === 0 && !opts.blocked) return undefined;
  const full = windows.filter((w) => w.usedPercent >= 100);
  const pick = (full.length > 0 ? full : windows).reduce<(typeof windows)[number] | undefined>((best, w) => {
    if (!best) return w;
    if (full.length > 0) return (w.resetsAt ?? 0) > (best.resetsAt ?? 0) ? w : best;
    return w.usedPercent > best.usedPercent ? w : best;
  }, undefined);
  const fallbackReset = opts.blocked ? retryAtFromMessage(opts.message, opts.at) : undefined;
  const resetsAt = pick?.resetsAt ?? fallbackReset;
  const limitType = pick?.kind ?? (opts.blocked ? limitTypeForReset(fallbackReset, opts.at) : undefined);
  return {
    type: 'rate_limit',
    blocked: opts.blocked,
    ...(limitType ? { limitType } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(opts.message ? { message: opts.message } : {}),
    ...(windows.length > 0 ? { windows } : {}),
    at: opts.at,
  };
}

/** The usage-limit refusal of `codex exec`, which says when only in words. */
export function codexUsageLimitFromMessage(message: string, at: number): RateLimitEvent {
  return codexRateLimitEvent(undefined, { blocked: true, message, at })!;
}

function codexBucket(snapshot: unknown):
  | { primary?: RateWindow | null; secondary?: RateWindow | null }
  | undefined {
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  const raw = snapshot as { rateLimits?: unknown; rateLimitsByLimitId?: Record<string, unknown> };
  const bucket = raw.rateLimitsByLimitId?.codex ?? raw.rateLimits;
  if (!bucket || typeof bucket !== 'object') return undefined;
  // Other limit ids (e.g. `premium`) are separate meters, not the plan windows.
  const limitId = (bucket as { limitId?: unknown }).limitId;
  if (typeof limitId === 'string' && limitId !== 'codex') return undefined;
  return bucket as { primary?: RateWindow | null; secondary?: RateWindow | null };
}

/**
 * Without a snapshot only the wording says which window it was: a reset
 * within five hours can only be the five-hour window (derived, not reported).
 */
function limitTypeForReset(resetsAt: number | undefined, at: number): string | undefined {
  if (resetsAt === undefined) return undefined;
  return resetsAt - at <= 5 * 3_600_000 ? 'five_hour' : 'seven_day';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * "…try again at 8:35 PM." (later today) or "…try again at Oct 25th, 2026
 * 8:35 PM." — Codex writes the reset in the host's local time.
 */
export function retryAtFromMessage(message: string | undefined, at: number): number | undefined {
  const m = message && /try again at\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+)?(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(message);
  if (!m) return undefined;
  let hour = Number(m[4]) % 12;
  if (m[6]!.toUpperCase() === 'PM') hour += 12;
  const minute = Number(m[5]);
  const now = new Date(at);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return undefined;
    return new Date(Number(m[3]), month, Number(m[2]), hour, minute).getTime();
  }
  const when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute).getTime();
  // A time already past means tomorrow.
  return when > at ? when : when + 86_400_000;
}
