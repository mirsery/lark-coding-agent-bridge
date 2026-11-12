import { expect, it, vi } from 'vitest';
import { createPrReader } from '../../../src/coding-board/pull-requests';

it('does not block the board while fetching and retains the observation time', async () => {
  let finish!: (value: any) => void;
  const query = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
  const read = createPrReader(query, 1000);
  const ref = { repository: 'owner/repo', number: 4 };
  expect(read([ref], 100)[0]?.state).toBe('loading');
  expect(read([ref], 200)[0]?.state).toBe('loading');
  expect(query).toHaveBeenCalledTimes(1);
  finish({ ...ref, state: 'open', head: 'abc', observedAt: 100 });
  await vi.waitFor(() => expect(read([ref], 300)[0]?.state).toBe('open'));
  expect(read([ref], 300)[0]?.observedAt).toBe(100);
});

it('does not count skipped or unfinished checks as passing', async () => {
  const { countChecks } = await import('../../../src/coding-board/pull-requests');
  expect(countChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }, { status: 'IN_PROGRESS' }, { conclusion: 'FAILURE' }])).toEqual({ passed: 1, skipped: 1, pending: 1, failed: 1 });
});

it('eventually reads more than four PRs without exceeding four concurrent requests', async () => {
  let active = 0, max = 0;
  const query = vi.fn(async (ref: { repository: string; number: number }, now: number) => {
    active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 5)); active--;
    return { ...ref, observedAt: now, state: 'unavailable' as const };
  });
  const read = createPrReader(query);
  const refs = Array.from({ length: 9 }, (_, i) => ({ repository: 'org/repo', number: i + 1 }));
  read(refs, 1);
  await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(9));
  expect(max).toBeLessThanOrEqual(4);
});
