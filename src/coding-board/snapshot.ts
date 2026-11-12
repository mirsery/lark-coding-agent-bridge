import { readBuildQueue, type QueueSnapshot } from './build-queue';
import { join } from 'node:path';
import { createGitReader, type BoardGit } from './git-reader';
import { readTasks, type CodingTask } from './store';
import { createPrReader, type BoardPr } from './pull-requests';
import type { MonitorBot } from '../terminal/snapshot';

export interface CodingBoardTask extends CodingTask {
  git: BoardGit[];
  phase: '构建持锁' | '构建排队' | '检查失败' | '检查中' | 'PR 已合并' | 'PR 待处理' | '未知';
  queue: QueueSnapshot;
  pullRequests: BoardPr[];
  runStates: { profile: string; scope: string; state: 'running' | 'orphan' | 'unknown' }[];
}
export interface CodingBoardSnapshot { observedAt: number; tasks: CodingBoardTask[]; error?: string }

/** Git reads are bounded by git's own timeout; no external commands mutate tasks. */
export async function readCodingBoard(rootDir: string, now = Date.now(), bots: MonitorBot[] = [], readPr = createPrReader(), readGit = createGitReader()): Promise<CodingBoardSnapshot> {
  let tasks: CodingTask[];
  try { tasks = await readTasks(join(rootDir, 'coding-board', 'tasks.json')); }
  catch { return { observedAt: now, tasks: [], error: '任务登记无法读取' }; }
  const result: CodingBoardTask[] = [];
  const queue = await readBuildQueue(now);
  // Limit work to four git probes at a time.
  for (const task of tasks.filter(t => !t.archived)) {
    const git = readGit(task.worktrees, now);
    const runStates = task.runs.map(run => {
      const match = bots.find(bot => bot.profile === run.profile)?.runs.find(r => r.scope === run.scope);
      return { ...run, state: match ? (match.orphan ? 'orphan' as const : 'running' as const) : 'unknown' as const };
    });
    const taskQueue = { ...queue, entries: queue.entries.filter(entry => task.worktrees.includes(entry.path)) };
    const pullRequests = readPr(task.prs, now);
    const phase = derivePhase(taskQueue, pullRequests, now);
    result.push({ ...task, git, runStates, queue: taskQueue, pullRequests, phase });
  }
  return { observedAt: now, tasks: result };
}

/** Labels reflect observed facts, never equate a merged PR with a completed task. */
export function derivePhase(queue: QueueSnapshot, prs: BoardPr[], now = Date.now()): CodingBoardTask['phase'] {
  const fresh = prs.filter(pr => pr.observedAt !== undefined && now - pr.observedAt <= 120_000 && now >= pr.observedAt);
  if (queue.entries.some(entry => entry.state === 'running')) return '构建持锁';
  if (queue.entries.some(entry => entry.state === 'waiting')) return '构建排队';
  if (fresh.some(pr => pr.state === 'open' && (pr.checks?.failed ?? 0) > 0)) return '检查失败';
  if (fresh.some(pr => pr.state === 'open' && (pr.checks?.pending ?? 0) > 0)) return '检查中';
  if (prs.length && fresh.length === prs.length && fresh.every(pr => pr.state === 'merged')) return 'PR 已合并';
  if (fresh.some(pr => pr.state === 'open')) return 'PR 待处理';
  return '未知';
}
