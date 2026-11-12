import { join, resolve } from 'node:path';
import { resolveAppPaths } from '../../config/app-paths';
import type { WorktreeEntry } from '../../git/worktree';
import { addTask, readTasks, updateTask } from '../../coding-board/store';

const file = () => join(resolveAppPaths().rootDir, 'coding-board', 'tasks.json');
export async function boardAdd(title: string, opts: { jira?: string; worktree?: string[] }): Promise<void> {
  const task = await addTask(file(), { title, jira: opts.jira, worktrees: opts.worktree?.map(p => resolve(p)) });
  console.log(JSON.stringify(task, null, 2));
}
export async function boardList(): Promise<void> { console.log(JSON.stringify(await readTasks(file()), null, 2)); }
export async function boardLink(id: string, opts: { worktree?: string; run?: string; pr?: string; archive?: boolean; unarchive?: boolean }): Promise<void> {
  if ([opts.worktree, opts.run, opts.pr, opts.archive, opts.unarchive].filter(Boolean).length !== 1) throw new Error('Specify exactly one association or archive option');
  const task = await updateTask(file(), id, t => {
    if (opts.worktree) { const p = resolve(opts.worktree); if (!t.worktrees.includes(p)) t.worktrees.push(p); }
    if (opts.run) { const i = opts.run.indexOf(':'); if (i < 1 || i === opts.run.length - 1) throw new Error('Run must be profile:scope'); const profile = opts.run.slice(0, i), scope = opts.run.slice(i + 1); if (!t.runs.some(r => r.profile === profile && r.scope === scope)) t.runs.push({ profile, scope }); }
    if (opts.pr) { const m = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(opts.pr); if (!m) throw new Error('PR must be owner/repository#number'); const repository = m[1]!, number = Number(m[2]); if (!t.prs.some(p => p.repository === repository && p.number === number)) t.prs.push({ repository, number }); }
    if (opts.archive) t.archived = true;
    if (opts.unarchive) t.archived = false;
  });
  console.log(JSON.stringify(task, null, 2));
}

/** Discovery is advisory: never silently bind a branch to a task. */
export async function boardDiscover(repository: string): Promise<void> {
  const { listWorktrees } = await import('../../git/worktree');
  const trees = await listWorktrees(resolve(repository));
  if ('error' in trees) throw new Error(trees.error);
  const registered = await readTasks(file());
  console.log(JSON.stringify(worktreeCandidates(trees, registered.flatMap(t => t.worktrees)), null, 2));
}

export function worktreeCandidates(trees: WorktreeEntry[], registered: string[]) {
  return trees.filter(tree => !registered.includes(tree.path)).map(tree => {
    const keys = [...new Set((`${tree.branch ?? ''} ${tree.path}`.toUpperCase().match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? []))];
    return { path: tree.path, branch: tree.branch, candidates: keys, source: 'worktree name', confidence: 'unconfirmed' };
  });
}
