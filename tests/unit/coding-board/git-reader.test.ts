import { expect, it, vi } from 'vitest';
import { createGitReader } from '../../../src/coding-board/git-reader';

it('returns immediately and eventually probes every worktree with bounded concurrency', async () => {
  let active = 0, maximum = 0;
  const probe = vi.fn(async () => { active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 5)); active--; return undefined; });
  const read = createGitReader(probe);
  const paths = Array.from({ length: 9 }, (_, i) => `/repo/${i}`);
  expect(read(paths, 1)).toHaveLength(9);
  expect(probe.mock.calls.length).toBeLessThanOrEqual(4);
  await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(9));
  await vi.waitFor(() => expect(read(paths, 1).every(x => x.error)).toBe(true));
  expect(maximum).toBeLessThanOrEqual(4);
});
