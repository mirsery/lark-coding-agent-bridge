import { describe, expect, it, vi } from 'vitest';
import {
  CardPatchHealth,
  instrumentCardPatches,
  larkErrorCode,
  RATE_LIMIT_BROKEN_MS,
} from '../../../src/bot/card-patch-health.js';

/** Mirrors the SDK card stream: updates go out through `this.patch()`. */
class SdkLikeController {
  calls = 0;
  constructor(private readonly outcomes: Array<'ok' | 'fail' | 'limited'>) {}
  async patch(): Promise<void> {
    const outcome = this.outcomes[this.calls++] ?? 'ok';
    if (outcome === 'fail') {
      throw Object.assign(new Error('Request failed with status code 400'), {
        response: { data: { code: 230025 } },
      });
    }
    if (outcome === 'limited') {
      // What Feishu answers a card patch with when it throttles the message.
      throw Object.assign(new Error('Request failed with status code 400'), {
        response: {
          data: {
            code: 230020,
            msg: 'This operation triggers the frequency limit, ext=Update the single messages too frequently',
          },
        },
      });
    }
  }
  /** What the SDK's throttle timer does. */
  fire(): Promise<void> {
    return this.patch();
  }
}

describe('card patch health', () => {
  it('reports a stuck card once after three failed updates in a row', async () => {
    const onBroken = vi.fn();
    const health = new CardPatchHealth(onBroken);
    const ctrl = new SdkLikeController(['fail', 'fail', 'fail', 'fail']);
    expect(instrumentCardPatches(ctrl, health)).toBe(true);

    for (let i = 0; i < 4; i++) await ctrl.fire();

    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(onBroken).toHaveBeenCalledWith(230025);
    expect(health.lastFailed).toBe(true);
    expect(health.lastErrorCode).toBe(230025);
  });

  it('swallows the failure instead of letting it escape the timer', async () => {
    const health = new CardPatchHealth(() => {});
    const ctrl = new SdkLikeController(['fail']);
    instrumentCardPatches(ctrl, health);
    await expect(ctrl.fire()).resolves.toBeUndefined();
  });

  it('a successful update clears the failure state', async () => {
    const onBroken = vi.fn();
    const health = new CardPatchHealth(onBroken);
    const ctrl = new SdkLikeController(['fail', 'fail', 'ok', 'fail', 'fail']);
    instrumentCardPatches(ctrl, health);
    for (let i = 0; i < 3; i++) await ctrl.fire();
    expect(health.lastFailed).toBe(false);
    for (let i = 0; i < 2; i++) await ctrl.fire();
    expect(onBroken).not.toHaveBeenCalled();
  });

  it('tells the run when a card it reported stuck updates again', async () => {
    const onBroken = vi.fn();
    const onRecovered = vi.fn();
    const health = new CardPatchHealth(onBroken, { onRecovered });
    const ctrl = new SdkLikeController(['fail', 'fail', 'fail', 'ok', 'ok']);
    instrumentCardPatches(ctrl, health);
    for (let i = 0; i < 3; i++) await ctrl.fire();
    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(onRecovered).not.toHaveBeenCalled();

    await ctrl.fire();
    await ctrl.fire();
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(health.lastFailed).toBe(false);
  });

  describe('Feishu rate limit (230020)', () => {
    function rateLimitedCard(outcomes: Array<'ok' | 'fail' | 'limited'>) {
      let now = 1_000_000;
      const waits: number[] = [];
      const onBroken = vi.fn();
      const onRecovered = vi.fn();
      const health = new CardPatchHealth(onBroken, { onRecovered, now: () => now });
      const ctrl = new SdkLikeController(outcomes);
      instrumentCardPatches(ctrl, health, async (ms) => {
        waits.push(ms);
        now += ms;
      });
      return { ctrl, health, waits, onBroken, onRecovered, advance: (ms: number) => (now += ms) };
    }

    it('does not call a briefly throttled card stuck, and backs off before retrying', async () => {
      // The 2026-10-27 run: Feishu throttled the card for about a minute, then
      // took updates again. Retrying on every change only collected rejections.
      const card = rateLimitedCard(['limited', 'limited', 'limited', 'limited', 'ok']);
      for (let i = 0; i < 5; i++) await card.ctrl.fire();

      expect(card.onBroken).not.toHaveBeenCalled();
      expect(card.waits).toEqual([5_000, 10_000, 20_000, 30_000]);
      expect(card.health.lastFailed).toBe(false);
      expect(card.health.cooldownMs()).toBe(0);
    });

    it('waits only for what is left of the cooldown', async () => {
      const card = rateLimitedCard(['limited', 'ok']);
      await card.ctrl.fire();
      card.advance(3_000);
      await card.ctrl.fire();
      expect(card.waits).toEqual([2_000]);
    });

    it('tells the user once the card has stayed throttled too long', async () => {
      const card = rateLimitedCard(Array(12).fill('limited'));
      let fired = 0;
      while (card.onBroken.mock.calls.length === 0 && fired < 12) {
        await card.ctrl.fire();
        fired++;
      }
      expect(card.onBroken).toHaveBeenCalledWith(230020);
      expect(card.waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(RATE_LIMIT_BROKEN_MS);
    });

    it('other errors do not wait', async () => {
      const card = rateLimitedCard(['fail', 'fail', 'ok']);
      for (let i = 0; i < 3; i++) await card.ctrl.fire();
      expect(card.waits).toEqual([]);
    });
  });

  it('leaves controllers without a patch method alone', () => {
    const fake = { update: async () => {} };
    expect(instrumentCardPatches(fake, new CardPatchHealth(() => {}))).toBe(false);
    expect(fake).not.toHaveProperty('patch');
  });

  it('reads the Feishu error code off an API error', () => {
    expect(larkErrorCode({ response: { data: { code: 230099 } } })).toBe(230099);
    expect(larkErrorCode(new Error('x'))).toBeUndefined();
  });
});

describe('SDK shape the instrumentation relies on', () => {
  // instrumentCardPatches shadows `patch` on the card stream controller. That
  // only works while the SDK's throttle calls it as `this.patch()` and hands
  // the controller itself to the producer. Fail loudly on an SDK upgrade that
  // changes either, instead of silently losing stuck-card detection.
  it('@larksuite/channel card stream still patches through this.patch()', async () => {
    const { readFile } = await import('node:fs/promises');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@larksuite/channel');
    const source = await readFile(entry.replace(/index\.cjs$/, 'index.mjs'), 'utf8');
    const impl = source.slice(source.indexOf('var CardStreamControllerImpl = class'));
    const body = impl.slice(0, impl.indexOf('var CardStreamController = class'));
    expect(body).toContain('}, () => this.patch());');
    expect(body).toContain('async patch() {');
    expect(body).toContain('await producer(this);');
  });
});
