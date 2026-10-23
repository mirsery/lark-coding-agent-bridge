import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAppServerTranslator } from '../../../src/agent/codex/app-server-translator.js';
import { CodexJsonlTranslator } from '../../../src/agent/codex/jsonl.js';
import { codexRateLimitEvent, retryAtFromMessage } from '../../../src/agent/codex/rate-limit.js';
import { initialState, reduce } from '../../../src/card/run-state.js';
import type { AgentEvent } from '../../../src/agent/types.js';

/** Real codex-cli 0.163 output with the 5-hour window used up. */
const fixture = JSON.parse(readFileSync(join(__dirname, '../../fixtures/codex-usage-limit.json'), 'utf8')) as {
  appServer: { error: { params: Record<string, unknown> }; turnCompleted: { params: Record<string, unknown> }; rateLimitsRead: unknown };
  exec: unknown[];
};
const at = new Date(2026, 9, 23, 19, 30).getTime();

describe('Codex usage limit', () => {
  it('names the window that ran out and when it reopens from the rate-limit snapshot', () => {
    expect(codexRateLimitEvent(fixture.appServer.rateLimitsRead, { blocked: true, message: 'limit', at })).toEqual({
      type: 'rate_limit',
      blocked: true,
      limitType: 'five_hour',
      resetsAt: 1792758907_000,
      message: 'limit',
      windows: [
        { kind: 'five_hour', usedPercent: 100, resetsAt: 1792758907_000 },
        { kind: 'seven_day', usedPercent: 21, resetsAt: 1793326168_000 },
      ],
      at,
    });
  });

  it('takes the window reopening last when several ran out', () => {
    const both = { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 100 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 900 } } };
    expect(codexRateLimitEvent(both, { blocked: true, at })).toMatchObject({ limitType: 'seven_day', resetsAt: 900_000 });
  });

  it('reports ordinary updates without blocking and skips meters that are not the plan windows', () => {
    const update = { rateLimits: { limitId: 'codex', primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 100 }, secondary: null } };
    expect(codexRateLimitEvent(update, { blocked: false, at })).toMatchObject({ blocked: false, limitType: 'five_hour', resetsAt: 100_000 });
    expect(codexRateLimitEvent({ rateLimits: { limitId: 'premium', primary: null, secondary: null } }, { blocked: false, at })).toBeUndefined();
  });

  it('reads the reset out of the wording when there is no snapshot', () => {
    expect(retryAtFromMessage('… or try again at 8:35 PM.', at)).toBe(new Date(2026, 9, 23, 20, 35).getTime());
    // Already past today: tomorrow.
    expect(retryAtFromMessage('try again at 7:05 AM.', at)).toBe(new Date(2026, 9, 24, 7, 5).getTime());
    expect(retryAtFromMessage('try again at Oct 25th, 2026 12:10 AM.', at)).toBe(new Date(2026, 9, 25, 0, 10).getTime());
    expect(retryAtFromMessage('something else', at)).toBeUndefined();
  });

  it('pauses an exec run on the refusal instead of failing it', () => {
    const t = new CodexJsonlTranslator();
    const events = fixture.exec.flatMap((line) => t.translate(line));
    const limit = events.find((e) => e.type === 'rate_limit');
    expect(limit).toMatchObject({ type: 'rate_limit', blocked: true, message: expect.stringContaining('usage limit') });
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(events.indexOf(limit!)).toBe(events.length - 2);
    expect(events.reduce(reduce, initialState).terminal).toBe('paused');
  });

  it('marks an app-server turn the quota refused', () => {
    const t = new CodexAppServerTranslator('thr');
    t.notification('error', fixture.appServer.error.params);
    const events: AgentEvent[] = t.notification('turn/completed', fixture.appServer.turnCompleted.params);
    expect(t.usageLimit).toContain('usage limit');
    expect(events).toEqual([{ type: 'error', message: expect.stringContaining('usage limit'), terminationReason: 'failed' }]);

    const ordinary = new CodexAppServerTranslator('thr');
    ordinary.notification('turn/completed', { turn: { status: 'failed', error: { message: 'boom' } } });
    expect(ordinary.usageLimit).toBeUndefined();
  });
});
