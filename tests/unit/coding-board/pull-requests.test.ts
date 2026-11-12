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
