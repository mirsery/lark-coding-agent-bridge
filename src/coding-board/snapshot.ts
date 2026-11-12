import { join } from 'node:path';
import { readRepoStatus, type GitRepoStatus } from '../git/status';
import { readTasks, type CodingTask } from './store';

export interface CodingBoardTask extends CodingTask {
  git: { path: string; observedAt: number; status?: GitRepoStatus; error?: string }[];
}
export interface CodingBoardSnapshot { observedAt: number; tasks: CodingBoardTask[]; error?: string }

/** Git reads are bounded by git's own timeout; no external commands mutate tasks. */
export async function readCodingBoard(rootDir: string, now = Date.now()): Promise<CodingBoardSnapshot> {
  let tasks: CodingTask[];
  try { tasks = await readTasks(join(rootDir, 'coding-board', 'tasks.json')); }
  catch { return { observedAt: now, tasks: [], error: '任务登记无法读取' }; }
  const result: CodingBoardTask[] = [];
  // Limit work to four git probes at a time.
  for (const task of tasks.filter(t => !t.archived)) {
    const git: CodingBoardTask['git'] = [];
    for (let i = 0; i < task.worktrees.length; i += 4) {
      git.push(...await Promise.all(task.worktrees.slice(i, i + 4).map(async path => {
        const status = await readRepoStatus(path).catch(() => undefined);
        return { path, observedAt: now, ...(status ? { status } : { error: '无法读取 Git 状态' }) };
      })));
    }
    result.push({ ...task, git });
  }
  return { observedAt: now, tasks: result };
}
