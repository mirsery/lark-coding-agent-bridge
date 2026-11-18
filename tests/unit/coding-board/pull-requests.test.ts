import { expect, it, vi } from 'vitest';
import { countChecks } from '../../../src/coding-board/pull-requests';
import { createRefresher } from '../../../src/coding-board/cache';

it('does not count skipped or unfinished checks as passing', () => {
  expect(countChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }, { status: 'IN_PROGRESS' }, { conclusion: 'FAILURE' }])).toEqual({ passed: 1, skipped: 1, pending: 1, failed: 1 });
});

it('never blocks a read and refreshes once per key until the TTL passes', async () => {
  let finish!: (value: string) => void;
  const load = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  const cache = createRefresher(load, 1000);
  expect(cache.get('a', 100)).toBeUndefined();
  expect(cache.get('a', 200)).toBeUndefined();
  expect(load).toHaveBeenCalledTimes(1);
  finish('v');
  await vi.waitFor(() => expect(cache.get('a')).toBe('v'));
  expect(load).toHaveBeenCalledTimes(1);
});

it('keeps the previous value when a refresh fails and bounds concurrency', async () => {
  let active = 0, max = 0, fail = false;
  const cache = createRefresher(async (key: string) => {
    active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 5)); active--;
    if (fail) throw new Error('boom');
    return key.toUpperCase();
  }, 0, 2);
  for (const k of ['a', 'b', 'c', 'd', 'e']) cache.get(k);
  await cache.settle();
  expect(max).toBeLessThanOrEqual(2);
  expect(cache.get('a')).toBe('A');
  fail = true;
  await cache.settle();
  expect(cache.get('a')).toBe('A');
});
