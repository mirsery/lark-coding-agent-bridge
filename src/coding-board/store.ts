import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../platform/atomic-write';

export interface GateRecord {
  id: string; worktree: string; head: string; dirty: boolean; startedAt: number;
  finishedAt?: number; exitCode?: number | null; signal?: string; endHead?: string; endDirty?: boolean;
}

export interface CodingTask {
  id: string;
  title: string;
  jira?: string;
  worktrees: string[];
  runs: { profile: string; scope: string }[];
  prs: { repository: string; number: number }[];
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  gates?: GateRecord[];
}

interface TaskFile { version: 1; tasks: CodingTask[] }

/** A malformed store is an error, never silently replaced with an empty one. */
export async function readTasks(path: string): Promise<CodingTask[]> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const file = raw as Partial<TaskFile> | null;
  if (!file || file.version !== 1 || !Array.isArray(file.tasks) || !file.tasks.every(validTask)) {
    throw new Error('Invalid coding task store');
  }
  return file.tasks;
}

function validTask(value: unknown): value is CodingTask {
  if (!value || typeof value !== 'object') return false;
  const t = value as CodingTask;
  return typeof t.id === 'string' && typeof t.title === 'string' && typeof t.createdAt === 'number'
    && typeof t.updatedAt === 'number' && typeof t.archived === 'boolean'
    && (t.jira === undefined || typeof t.jira === 'string')
    && Array.isArray(t.worktrees) && t.worktrees.every(p => typeof p === 'string')
    && Array.isArray(t.runs) && t.runs.every(r => r && typeof r.profile === 'string' && typeof r.scope === 'string')
    && Array.isArray(t.prs) && t.prs.every(p => p && typeof p.repository === 'string' && Number.isInteger(p.number) && p.number > 0)
    && (t.gates === undefined || (Array.isArray(t.gates) && t.gates.every(g => g && typeof g.id === 'string' && typeof g.worktree === 'string' && typeof g.head === 'string' && typeof g.dirty === 'boolean' && typeof g.startedAt === 'number' && (g.finishedAt === undefined || typeof g.finishedAt === 'number') && (g.exitCode === undefined || g.exitCode === null || typeof g.exitCode === 'number') && (g.signal === undefined || typeof g.signal === 'string') && (g.endHead === undefined || typeof g.endHead === 'string') && (g.endDirty === undefined || typeof g.endDirty === 'boolean'))));
}

export async function addTask(path: string, input: { title: string; jira?: string; worktrees?: string[] }): Promise<CodingTask> {
  const title = input.title.trim();
  if (!title) throw new Error('Task title is required');
  await mkdir(dirname(path), { recursive: true });
  // Lock the stable directory, because atomic replacement changes the file inode.
  const release = await lockfile.lock(dirname(path), { retries: { retries: 20, minTimeout: 25, maxTimeout: 250 } });
  try {
    const tasks = await readTasks(path);
    const now = Date.now();
    const task: CodingTask = { id: randomUUID(), title, ...(input.jira ? { jira: input.jira } : {}), worktrees: input.worktrees ?? [], runs: [], prs: [], createdAt: now, updatedAt: now, archived: false };
    await writeFileAtomic(path, `${JSON.stringify({ version: 1, tasks: [...tasks, task] }, null, 2)}\n`, { mode: 0o600 });
    return task;
  } finally { await release(); }
}

export async function updateTask(path: string, id: string, change: (task: CodingTask) => void): Promise<CodingTask> {
  await mkdir(dirname(path), { recursive: true });
  const release = await lockfile.lock(dirname(path), { retries: { retries: 20, minTimeout: 25, maxTimeout: 250 } });
  try {
    const tasks = await readTasks(path);
    const task = tasks.find(t => t.id === id);
    if (!task) throw new Error(`Task not found: ${id}`);
    change(task);
    task.updatedAt = Date.now();
    if (!validTask(task)) throw new Error('Invalid task update');
    await writeFileAtomic(path, `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`, { mode: 0o600 });
    return task;
  } finally { await release(); }
}
