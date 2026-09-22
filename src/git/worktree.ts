import { basename, dirname, isAbsolute, join } from 'node:path';
import { git, isSafeRef } from './exec';

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  /** The main checkout is the first entry git lists and cannot be removed. */
  main: boolean;
  locked: boolean;
}

/** Parse `git worktree list --porcelain`. */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | undefined;
  const flush = (): void => {
    if (current?.path) {
      entries.push({
        path: current.path,
        ...(current.head ? { head: current.head } : {}),
        ...(current.branch ? { branch: current.branch } : {}),
        detached: current.detached ?? false,
        main: entries.length === 0,
        locked: current.locked ?? false,
      });
    }
    current = undefined;
  };

  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length).trim() };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice(5, 13);
    else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '').trim();
    } else if (line === 'detached') current.detached = true;
    else if (line.startsWith('locked')) current.locked = true;
  }
  flush();
  return entries;
}

export async function listWorktrees(cwd: string): Promise<WorktreeEntry[] | { error: string }> {
  const result = await git(cwd, ['worktree', 'list', '--porcelain']);
  if (!result.ok) return { error: result.stderr || '不是 git 仓库' };
  return parseWorktreeList(result.stdout);
}

/**
 * Where a managed worktree for `branch` goes: a `.worktrees` directory beside
 * the repository, never inside it.
 *
 * Inside the repo the new tree would show up in every `git status`, every
 * `rg`, and every agent file scan of the parent repo — the one place it must
 * not be.
 */
export function defaultWorktreePath(repoRoot: string, branch: string): string {
  const slug = branch.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
  return join(dirname(repoRoot), '.worktrees', `${basename(repoRoot)}-${slug}`);
}

export interface AddWorktreeInput {
  /** Any directory inside the repository the worktree is created from. */
  cwd: string;
  repoRoot: string;
  branch: string;
  /** Explicit destination; defaults to {@link defaultWorktreePath}. */
  path?: string;
  /** Base revision for a new branch. Defaults to the current HEAD. */
  base?: string;
}

export interface AddedWorktree {
  path: string;
  branch: string;
  /** True when the branch already existed and was checked out as-is. */
  existingBranch: boolean;
}

export async function addWorktree(
  input: AddWorktreeInput,
): Promise<AddedWorktree | { error: string }> {
  if (!isSafeRef(input.branch)) return { error: `不是合法的分支名：${input.branch}` };
  if (input.base && !isSafeRef(input.base)) return { error: `不是合法的起点：${input.base}` };
  if (input.path && !isAbsolute(input.path)) return { error: 'worktree 路径必须是绝对路径' };

  const path = input.path ?? defaultWorktreePath(input.repoRoot, input.branch);
  const existing = await git(input.cwd, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${input.branch}`,
  ]);
  const existingBranch = existing.ok;

  const args = existingBranch
    ? ['worktree', 'add', path, input.branch]
    : ['worktree', 'add', '-b', input.branch, path, ...(input.base ? [input.base] : [])];
  const result = await git(input.cwd, args, { timeoutMs: 60_000 });
  if (!result.ok) return { error: result.stderr || 'git worktree add 失败' };
  return { path, branch: input.branch, existingBranch };
}

export async function removeWorktree(
  cwd: string,
  path: string,
  opts: { force?: boolean } = {},
): Promise<{ ok: true } | { error: string }> {
  if (!isAbsolute(path)) return { error: 'worktree 路径必须是绝对路径' };
  const result = await git(cwd, [
    'worktree',
    'remove',
    ...(opts.force ? ['--force'] : []),
    path,
  ], { timeoutMs: 30_000 });
  if (!result.ok) return { error: result.stderr || 'git worktree remove 失败' };
  return { ok: true };
}

/** Resolve a `/worktree` argument that may be a branch name or an absolute path. */
export function matchWorktree(
  entries: readonly WorktreeEntry[],
  needle: string,
): WorktreeEntry | undefined {
  return (
    entries.find((entry) => entry.path === needle) ??
    entries.find((entry) => entry.branch === needle) ??
    entries.find((entry) => basename(entry.path) === needle)
  );
}
