import { log } from '../core/logger';

/** Consecutive failed updates before the user is told the card is stuck. */
export const CARD_BROKEN_THRESHOLD = 3;

/**
 * Feishu's update frequency limit. 230020 comes with "Update the single
 * messages too frequently" on a card patch; 99991400 is the app-wide limit.
 * Both have lifted on their own within about a minute every time we saw them
 * (they hit long runs even at one update per 15s heartbeat).
 */
const RATE_LIMIT_CODES = new Set([230020, 99991400]);

/** First wait after a rate-limited update; doubles per rejection after that. */
export const RATE_LIMIT_BACKOFF_MS = 5_000;
export const RATE_LIMIT_BACKOFF_MAX_MS = 30_000;

/**
 * How long a rate-limited card may stay frozen before the user is told. A
 * limit that lifts by itself is not worth a message; one that doesn't is.
 */
export const RATE_LIMIT_BROKEN_MS = 3 * 60_000;

export function isRateLimitCode(code: number | undefined): boolean {
  return code !== undefined && RATE_LIMIT_CODES.has(code);
}

export interface CardPatchHealthOptions {
  /** The card took an update again after `onBroken` had fired. */
  onRecovered?: () => void;
  threshold?: number;
  now?: () => number;
}

/**
 * Tracks whether the streamed progress card is still being updated.
 *
 * Feishu can start rejecting a card's updates mid-run (it did for a whole
 * review run: 49 rejected updates in a row). Nothing on screen shows that —
 * the card simply stops changing and looks exactly like an agent stuck in a
 * long tool call. This turns the failures into a signal: `onBroken` fires once
 * the updates have failed `threshold` times in a row, and `lastFailed` tells
 * the run at the end whether the card holds the final answer or not.
 *
 * A rate limit is different: it lifts by itself, so updates back off instead
 * of hammering it (`cooldownMs`), and the user is only told if the card stays
 * frozen past `RATE_LIMIT_BROKEN_MS`. Once the card takes an update again
 * after `onBroken`, `onRecovered` lets the run take its notice back.
 */
export class CardPatchHealth {
  consecutiveFailures = 0;
  lastFailed = false;
  lastErrorCode: number | undefined;
  private reported = false;
  private failingSince: number | undefined;
  private rateLimitedStreak = 0;
  private retryAt = 0;
  private readonly onRecovered: (() => void) | undefined;
  private readonly threshold: number;
  private readonly now: () => number;

  constructor(
    private readonly onBroken: (code: number | undefined) => void,
    options: CardPatchHealthOptions = {},
  ) {
    this.onRecovered = options.onRecovered;
    this.threshold = options.threshold ?? CARD_BROKEN_THRESHOLD;
    this.now = options.now ?? Date.now;
  }

  /** How long the next update should wait out a rate limit (0: go now). */
  cooldownMs(): number {
    return Math.max(0, this.retryAt - this.now());
  }

  success(): void {
    this.consecutiveFailures = 0;
    this.lastFailed = false;
    this.failingSince = undefined;
    this.rateLimitedStreak = 0;
    this.retryAt = 0;
    if (this.reported) {
      this.reported = false;
      log.info('card', 'patch-recovered', {});
      this.onRecovered?.();
    }
  }

  failure(err: unknown): void {
    const now = this.now();
    this.consecutiveFailures++;
    this.lastFailed = true;
    this.lastErrorCode = larkErrorCode(err);
    this.failingSince ??= now;
    const rateLimited = isRateLimitCode(this.lastErrorCode);
    if (rateLimited) {
      const backoff = Math.min(
        RATE_LIMIT_BACKOFF_MS * 2 ** this.rateLimitedStreak,
        RATE_LIMIT_BACKOFF_MAX_MS,
      );
      this.rateLimitedStreak++;
      this.retryAt = now + backoff;
    } else {
      this.rateLimitedStreak = 0;
      this.retryAt = 0;
    }
    log.warn('card', 'patch-fail', {
      code: this.lastErrorCode ?? null,
      consecutive: this.consecutiveFailures,
      ...(rateLimited ? { retryInMs: this.retryAt - now } : {}),
      message: err instanceof Error ? err.message : String(err),
    });
    const stuck = rateLimited
      ? now - this.failingSince >= RATE_LIMIT_BROKEN_MS
      : this.consecutiveFailures >= this.threshold;
    if (!this.reported && stuck) {
      this.reported = true;
      this.onBroken(this.lastErrorCode);
    }
  }
}

/**
 * Route the SDK card stream's patch results into `health`.
 *
 * The SDK (`@larksuite/channel` CardStreamControllerImpl) patches from a
 * throttle timer as `this.patch()` and lets a failure escape as an unhandled
 * rejection, so the caller never learns about it. Shadowing `patch` on the
 * controller instance catches every attempt — timer-driven and the final flush
 * alike. Failures are swallowed here on purpose: `health` now carries them,
 * and the run checks `health.lastFailed` once the stream completes.
 *
 * While `health` is cooling down from a rate limit, the attempt waits it out
 * first. The SDK reads the card to send when `patch` runs, so the update that
 * finally goes out carries everything that changed in the meantime; the
 * throttle holds further attempts until this one is done.
 *
 * Returns false when the controller doesn't have that shape (a different SDK
 * version, a test fake): the run proceeds unchanged, just without detection.
 */
export function instrumentCardPatches(
  ctrl: object,
  health: CardPatchHealth,
  sleep: (ms: number) => Promise<void> = unrefSleep,
): boolean {
  const target = ctrl as { patch?: unknown };
  const original = target.patch;
  if (typeof original !== 'function') return false;
  target.patch = async (): Promise<void> => {
    const wait = health.cooldownMs();
    if (wait > 0) await sleep(wait);
    try {
      await (original as () => Promise<void>).call(ctrl);
      health.success();
    } catch (err) {
      health.failure(err);
    }
  };
  return true;
}

export function larkErrorCode(err: unknown): number | undefined {
  const code = (err as { response?: { data?: { code?: unknown } } } | undefined)?.response?.data
    ?.code;
  return typeof code === 'number' ? code : undefined;
}

/** A cooldown must never keep the process alive on shutdown. */
function unrefSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
