import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runRecordedGate } from '../../../src/coding-board/gate';
import { addTask, readTasks } from '../../../src/coding-board/store';

it('records exit status and both revisions, and rejects unlinked worktrees', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-gate-'));
  try {
    const repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    await writeFile(join(repo, 'a'), 'a');
    execFileSync('git', ['-C', repo, 'add', 'a']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);
    const file = join(dir, 'board', 'tasks.json');
    const task = await addTask(file, { title: 'task', worktrees: [repo] });
    expect(await runRecordedGate(file, task.id, repo, [process.execPath, '-e', 'process.exit(7)'])).toBe(7);
    const gate = (await readTasks(file))[0]?.gates?.[0];
    expect(gate).toMatchObject({ exitCode: 7, dirty: false, endDirty: false });
    expect(gate?.endHead).toBe(gate?.head);
    await expect(runRecordedGate(file, task.id, dir, [process.execPath])).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
