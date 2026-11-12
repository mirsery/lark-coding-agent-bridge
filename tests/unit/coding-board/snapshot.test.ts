import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { addTask, updateTask } from '../../../src/coding-board/store';
import { readCodingBoard } from '../../../src/coding-board/snapshot';

it('retains tasks after a run disappears and reports unavailable worktrees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'board-snapshot-'));
  try {
    const file = join(root, 'coding-board', 'tasks.json');
    const task = await addTask(file, { title: 'unfinished', worktrees: [join(root, 'missing')] });
    await updateTask(file, task.id, t => t.runs.push({ profile: 'example', scope: 'scope' }));
    const board = await readCodingBoard(root, 123, []);
    expect(board.tasks[0]).toMatchObject({ title: 'unfinished', runStates: [{ state: 'unknown' }], git: [{ error: '无法读取 Git 状态' }] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('preserves an explicit store error instead of pretending the board is empty', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'board-invalid-'));
  try {
    await mkdir(join(root, 'coding-board'));
    await writeFile(join(root, 'coding-board', 'tasks.json'), '{');
    expect(await readCodingBoard(root, 123)).toMatchObject({ tasks: [], error: '任务登记无法读取' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('derives phase only from observed queue or PR facts', async () => {
  const { derivePhase } = await import('../../../src/coding-board/snapshot');
  const queue = { observedAt: 1, state: 'available' as const, entries: [] };
  const pr = { repository: 'org/repo', number: 1, observedAt: 1, state: 'open' as const, checks: { passed: 0, failed: 1, pending: 0, skipped: 0 } };
  expect(derivePhase(queue, [pr], 2)).toBe('检查失败');
  expect(derivePhase(queue, [{ ...pr, state: 'unavailable' }], 2)).toBe('未知');
  expect(derivePhase({ ...queue, entries: [{ path: '/x', state: 'waiting', position: 1 }] }, [pr], 2)).toBe('构建排队');
});
