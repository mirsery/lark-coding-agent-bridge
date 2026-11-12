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
