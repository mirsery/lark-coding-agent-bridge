import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git, isGitError } from '../../../src/git/exec';
import { readDiffPatch, readDiffStat } from '../../../src/git/diff';
import { isDirty, readRepoStatus } from '../../../src/git/status';
import { addWorktree, listWorktrees, removeWorktree } from '../../../src/git/worktree';

/**
 * These run real git. The bridge's whole git surface is "what does git say
 * about this directory", and a mocked git would only prove that the mock
 * matches the parser.
 */

let root: string;
let repo: string;

async function run(args: string[], cwd = repo): Promise<void> {
  const result = await git(cwd, args);
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lcb-git-'));
  repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await run(['init', '--initial-branch=main']);
  await run(['config', 'user.email', 'test@example.com']);
  await run(['config', 'user.name', 'Test']);
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  await run(['add', 'a.txt']);
  await run(['commit', '-m', 'init']);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

describe('repository status', () => {
  it('reports a clean repository', async () => {
    const status = await readRepoStatus(repo);
    expect(status).toBeDefined();
    expect(status).toMatchObject({ branch: 'main', detached: false, linkedWorktree: false });
    expect(status?.head).toHaveLength(8);
    expect(isDirty(status!)).toBe(false);
  });

  it('counts staged, unstaged and untracked work separately', async () => {
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\nfour\n');
    await writeFile(join(repo, 'b.txt'), 'new file\n');
    await run(['add', 'b.txt']);
    await writeFile(join(repo, 'c.txt'), 'untracked\n');

    const status = await readRepoStatus(repo);
    expect(status?.dirty).toEqual({ staged: 1, unstaged: 1, untracked: 1, conflicted: 0 });
    expect(isDirty(status!)).toBe(true);
  });

  it('returns undefined outside a repository', async () => {
    const plain = join(root, 'plain');
    await mkdir(plain, { recursive: true });
    await expect(readRepoStatus(plain)).resolves.toBeUndefined();
  });
});

describe('diff', () => {
  it('summarizes uncommitted work, including untracked files', async () => {
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\nfour\nfive\n');
    await writeFile(join(repo, 'c.txt'), 'untracked\n');

    const summary = await readDiffStat(repo, { kind: 'worktree' });
    if (isGitError(summary)) throw new Error(summary.error);
    expect(summary.files).toHaveLength(1);
    expect(summary.files[0]).toMatchObject({ path: 'a.txt', added: 2, removed: 1 });
    expect(summary.added).toBe(2);
    expect(summary.removed).toBe(1);
    expect(summary.untracked).toEqual(['c.txt']);
  });

  it('separates staged from unstaged', async () => {
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\nfour\n');
    await run(['add', 'a.txt']);
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\nfour\nfive\n');

    const staged = await readDiffStat(repo, { kind: 'staged' });
    if (isGitError(staged)) throw new Error(staged.error);
    expect(staged.files[0]).toMatchObject({ added: 1, removed: 1 });
    expect(staged.untracked).toEqual([]);
  });

  it('compares a branch against its merge base with another ref', async () => {
    await run(['checkout', '-b', 'feature']);
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    await run(['commit', '-am', 'feature work']);
    // A commit on main after the branch point must not show up in the diff.
    await run(['checkout', 'main']);
    await writeFile(join(repo, 'main-only.txt'), 'main\n');
    await run(['add', 'main-only.txt']);
    await run(['commit', '-m', 'main work']);
    await run(['checkout', 'feature']);

    const summary = await readDiffStat(repo, { kind: 'ref', ref: 'main' });
    if (isGitError(summary)) throw new Error(summary.error);
    expect(summary.files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('reports an unknown ref as an error rather than an empty diff', async () => {
    const summary = await readDiffStat(repo, { kind: 'ref', ref: 'no-such-branch' });
    expect(isGitError(summary)).toBe(true);
  });

  it('produces a patch and truncates it at the byte cap', async () => {
    await writeFile(join(repo, 'a.txt'), `${'x\n'.repeat(5000)}`);

    const full = await readDiffPatch(repo, { kind: 'worktree' });
    if (isGitError(full)) throw new Error(full.error);
    expect(full.patch).toContain('diff --git');
    expect(full.truncated).toBe(false);

    const capped = await readDiffPatch(repo, { kind: 'worktree' }, 512);
    if (isGitError(capped)) throw new Error(capped.error);
    expect(capped.truncated).toBe(true);
    expect(capped.patch.length).toBeLessThanOrEqual(512);
  });
});

describe('worktrees', () => {
  it('creates a worktree beside the repo, lists it and removes it', async () => {
    const created = await addWorktree({ cwd: repo, repoRoot: repo, branch: 'fix/bug-1' });
    if (isGitError(created)) throw new Error(created.error);
    expect(created.existingBranch).toBe(false);
    expect(created.path).toBe(join(root, '.worktrees', 'repo-fix-bug-1'));

    const entries = await listWorktrees(repo);
    if (isGitError(entries)) throw new Error(entries.error);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ path: expect.stringContaining('repo'), main: true });
    expect(entries[1]).toMatchObject({ branch: 'fix/bug-1', main: false });

    // The new tree is a real checkout of its own branch.
    const inside = await readRepoStatus(created.path);
    expect(inside).toMatchObject({ branch: 'fix/bug-1', linkedWorktree: true });

    const removed = await removeWorktree(repo, created.path);
    expect(isGitError(removed)).toBe(false);
    const after = await listWorktrees(repo);
    if (isGitError(after)) throw new Error(after.error);
    expect(after).toHaveLength(1);
  });

  it('checks out an existing branch instead of recreating it', async () => {
    await run(['branch', 'existing']);
    const created = await addWorktree({ cwd: repo, repoRoot: repo, branch: 'existing' });
    if (isGitError(created)) throw new Error(created.error);
    expect(created.existingBranch).toBe(true);
  });

  it('branches a new worktree from an explicit base', async () => {
    await writeFile(join(repo, 'a.txt'), 'changed\n');
    await run(['commit', '-am', 'second']);

    const created = await addWorktree({
      cwd: repo,
      repoRoot: repo,
      branch: 'from-first',
      base: 'HEAD~1',
    });
    if (isGitError(created)) throw new Error(created.error);
    const log = await git(created.path, ['log', '--oneline']);
    expect(log.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('refuses unsafe branch names and relative paths', async () => {
    await expect(
      addWorktree({ cwd: repo, repoRoot: repo, branch: '--force' }),
    ).resolves.toMatchObject({ error: expect.any(String) });
    await expect(
      addWorktree({ cwd: repo, repoRoot: repo, branch: 'ok', path: 'relative/path' }),
    ).resolves.toMatchObject({ error: expect.any(String) });
  });

  it('reports a failure to remove a dirty worktree, and honours --force', async () => {
    const created = await addWorktree({ cwd: repo, repoRoot: repo, branch: 'dirty' });
    if (isGitError(created)) throw new Error(created.error);
    await writeFile(join(created.path, 'a.txt'), 'local edit\n');

    expect(isGitError(await removeWorktree(repo, created.path))).toBe(true);
    expect(isGitError(await removeWorktree(repo, created.path, { force: true }))).toBe(false);
  });
});
