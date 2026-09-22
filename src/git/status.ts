import { git } from './exec';

export interface GitDirty {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export interface GitRepoStatus {
  /** Absolute path of the working tree root. */
  root: string;
  /** Branch name, or undefined on a detached HEAD. */
  branch?: string;
  /** Short HEAD sha; undefined in a repo with no commits yet. */
  head?: string;
  detached: boolean;
  dirty: GitDirty;
  upstream?: { name: string; ahead: number; behind: number };
  /** True when `cwd` is a linked worktree rather than the main checkout. */
  linkedWorktree: boolean;
}

/**
 * Read the git state of a working directory, or `undefined` when it is not a
 * repository (or git is not installed — the bridge must stay useful either way).
 *
 * One `git status --porcelain=v2 --branch` call answers branch, upstream
 * divergence and every dirty-file count, so the common `/status` path costs a
 * single process.
 */
export async function readRepoStatus(cwd: string): Promise<GitRepoStatus | undefined> {
  const status = await git(cwd, [
    'status',
    '--porcelain=v2',
    '--branch',
    '--untracked-files=normal',
    '--no-renames',
  ]);
  if (!status.ok) return undefined;

  const root = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root.ok) return undefined;

  const parsed = parsePorcelainV2(status.stdout);
  // A linked worktree's private git dir differs from the shared common dir;
  // the main checkout's are the same path.
  const [gitDir, commonDir] = await Promise.all([
    git(cwd, ['rev-parse', '--absolute-git-dir']),
    git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  ]);

  return {
    root: root.stdout.trim(),
    ...parsed,
    linkedWorktree:
      gitDir.ok && commonDir.ok && gitDir.stdout.trim() !== commonDir.stdout.trim(),
  };
}

/** Parse `git status --porcelain=v2 --branch` output. Exported for tests. */
export function parsePorcelainV2(
  stdout: string,
): Omit<GitRepoStatus, 'root' | 'linkedWorktree'> {
  const dirty: GitDirty = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  let branch: string | undefined;
  let head: string | undefined;
  let detached = false;
  let upstreamName: string | undefined;
  let ahead = 0;
  let behind = 0;

  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim();
      // `(initial)` in a repo that has no commit yet.
      head = oid.startsWith('(') ? undefined : oid.slice(0, 8);
      continue;
    }
    if (line.startsWith('# branch.head ')) {
      const name = line.slice('# branch.head '.length).trim();
      if (name === '(detached)') detached = true;
      else branch = name;
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      upstreamName = line.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const ab = /\+(\d+)\s+-(\d+)/.exec(line);
      if (ab) {
        ahead = Number(ab[1]);
        behind = Number(ab[2]);
      }
      continue;
    }
    if (line.startsWith('? ')) {
      dirty.untracked++;
      continue;
    }
    if (line.startsWith('u ')) {
      dirty.conflicted++;
      continue;
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // Field 2 is the XY code: X is the index (staged) state, Y the worktree.
      const xy = line.split(' ')[1] ?? '..';
      if (xy[0] && xy[0] !== '.') dirty.staged++;
      if (xy[1] && xy[1] !== '.') dirty.unstaged++;
    }
  }

  return {
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
    detached,
    dirty,
    ...(upstreamName ? { upstream: { name: upstreamName, ahead, behind } } : {}),
  };
}

/** True when the working tree has anything uncommitted at all. */
export function isDirty(status: GitRepoStatus): boolean {
  const { staged, unstaged, untracked, conflicted } = status.dirty;
  return staged + unstaged + untracked + conflicted > 0;
}

/**
 * One-line summary for `/status`: branch, divergence, and what is uncommitted.
 * Deliberately terse — it shares a card with everything else about the session.
 */
export function describeRepoStatus(status: GitRepoStatus): string {
  const parts: string[] = [];
  parts.push(status.detached ? `游离 HEAD @ ${status.head ?? '?'}` : `\`${status.branch ?? '?'}\``);
  if (status.upstream) {
    const { ahead, behind } = status.upstream;
    if (ahead || behind) parts.push(`↑${ahead} ↓${behind}`);
  } else if (!status.detached) {
    parts.push('无上游');
  }
  const { staged, unstaged, untracked, conflicted } = status.dirty;
  const dirtyBits: string[] = [];
  if (conflicted) dirtyBits.push(`冲突 ${conflicted}`);
  if (staged) dirtyBits.push(`已暂存 ${staged}`);
  if (unstaged) dirtyBits.push(`未暂存 ${unstaged}`);
  if (untracked) dirtyBits.push(`未跟踪 ${untracked}`);
  parts.push(dirtyBits.length ? dirtyBits.join(' / ') : '干净');
  if (status.linkedWorktree) parts.push('worktree');
  return parts.join(' · ');
}
