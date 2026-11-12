import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addTask, readTasks } from '../../../src/coding-board/store';

const dirs: string[] = [];
async function path() { const dir = await mkdtemp(join(tmpdir(), 'coding-board-')); dirs.push(dir); return join(dir, 'tasks.json'); }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe('coding task store', () => {
  it('retains concurrent registrations including tasks without Jira', async () => {
    const file = await path();
    await Promise.all(Array.from({ length: 8 }, (_, i) => addTask(file, { title: `task ${i}`, ...(i ? {} : { jira: 'ABC-1' }) })));
    const tasks = await readTasks(file);
    expect(tasks).toHaveLength(8);
    expect(new Set(tasks.map(t => t.id)).size).toBe(8);
    expect(tasks.filter(t => t.jira === 'ABC-1')).toHaveLength(1);
  });
  it('refuses to overwrite damaged data', async () => {
    const file = await path();
    await writeFile(file, '{broken');
    await expect(addTask(file, { title: 'new' })).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('{broken');
  });
});
