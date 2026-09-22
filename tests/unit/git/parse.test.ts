import { describe, expect, it } from 'vitest';
import { isSafeRef } from '../../../src/git/exec';
import { describeDiffTarget, parseDiffTarget, previewPatch } from '../../../src/git/diff';
import { checksLabel, parsePrArg, reviewLabel, rollupChecks } from '../../../src/git/pr';
import { describeRepoStatus, isDirty, parsePorcelainV2 } from '../../../src/git/status';
import { defaultWorktreePath, matchWorktree, parseWorktreeList } from '../../../src/git/worktree';

describe('ref safety', () => {
  it('accepts ordinary revisions', () => {
    for (const ref of ['main', 'feat/x-1', 'HEAD~2', 'origin/main', 'v1.2.3', 'main...HEAD']) {
      expect(isSafeRef(ref), ref).toBe(true);
    }
  });

  it('rejects anything git could read as a flag or shell noise', () => {
    for (const ref of ['-f', '--exec=rm -rf /', '', 'a b', 'a;b', '$(id)', '`id`', 'a'.repeat(201)]) {
      expect(isSafeRef(ref), ref).toBe(false);
    }
  });
});

describe('porcelain v2 status', () => {
  const sample = [
    '# branch.oid 1a2b3c4d5e6f7890',
    '# branch.head feat/scheduler',
    '# branch.upstream origin/feat/scheduler',
    '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 aaa bbb src/staged.ts',
    '1 .M N... 100644 100644 100644 aaa bbb src/unstaged.ts',
    '1 MM N... 100644 100644 100644 aaa bbb src/both.ts',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts',
    '? src/new.ts',
  ].join('\n');

  it('reads branch, upstream divergence and dirty counts', () => {
    const parsed = parsePorcelainV2(sample);
    expect(parsed).toMatchObject({
      branch: 'feat/scheduler',
      head: '1a2b3c4d',
      detached: false,
      upstream: { name: 'origin/feat/scheduler', ahead: 2, behind: 1 },
    });
    expect(parsed.dirty).toEqual({ staged: 2, unstaged: 2, untracked: 1, conflicted: 1 });
  });

  it('handles a detached head and an empty repository', () => {
    const detached = parsePorcelainV2('# branch.oid 1a2b3c4d\n# branch.head (detached)\n');
    expect(detached.detached).toBe(true);
    expect(detached.branch).toBeUndefined();

    const fresh = parsePorcelainV2('# branch.oid (initial)\n# branch.head main\n');
    expect(fresh.head).toBeUndefined();
    expect(fresh.branch).toBe('main');
  });

  it('describes a clean tracked branch and a dirty one', () => {
    const clean = {
      root: '/repo',
      branch: 'main',
      head: 'abc12345',
      detached: false,
      dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
      upstream: { name: 'origin/main', ahead: 0, behind: 0 },
      linkedWorktree: false,
    };
    expect(describeRepoStatus(clean)).toBe('`main` · 干净');
    expect(isDirty(clean)).toBe(false);

    const dirty = {
      ...clean,
      upstream: { name: 'origin/main', ahead: 1, behind: 3 },
      dirty: { staged: 1, unstaged: 2, untracked: 4, conflicted: 0 },
      linkedWorktree: true,
    };
    expect(describeRepoStatus(dirty)).toBe('`main` · ↑1 ↓3 · 已暂存 1 / 未暂存 2 / 未跟踪 4 · worktree');
    expect(isDirty(dirty)).toBe(true);
  });

  it('calls out a branch with no upstream', () => {
    expect(
      describeRepoStatus({
        root: '/repo',
        branch: 'feat/x',
        head: 'abc12345',
        detached: false,
        dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
        linkedWorktree: false,
      }),
    ).toBe('`feat/x` · 无上游 · 干净');
  });
});

describe('diff targets', () => {
  it('maps arguments to targets', () => {
    expect(parseDiffTarget('')).toEqual({ kind: 'worktree' });
    expect(parseDiffTarget('staged')).toEqual({ kind: 'staged' });
    expect(parseDiffTarget('--cached')).toEqual({ kind: 'staged' });
    expect(parseDiffTarget('main')).toEqual({ kind: 'ref', ref: 'main' });
    expect(parseDiffTarget('--exec=boom')).toMatchObject({ error: expect.any(String) });
  });

  it('labels each target', () => {
    expect(describeDiffTarget({ kind: 'worktree' })).toBe('未提交的改动');
    expect(describeDiffTarget({ kind: 'staged' })).toBe('已暂存的改动');
    expect(describeDiffTarget({ kind: 'ref', ref: 'main' })).toContain('main');
  });
});

describe('patch preview', () => {
  it('keeps short patches whole', () => {
    const patch = 'diff --git a/x b/x\n+one\n-two';
    expect(previewPatch(patch)).toEqual({ text: patch, omittedLines: 0 });
  });

  it('cuts on a line boundary and reports the remainder', () => {
    const patch = Array.from({ length: 200 }, (_, i) => `+line ${i}`).join('\n');
    const preview = previewPatch(patch, { maxLines: 10 });
    expect(preview.text.split('\n')).toHaveLength(10);
    expect(preview.omittedLines).toBe(190);
    expect(preview.text.endsWith('+line 9')).toBe(true);
  });

  it('respects the character budget', () => {
    const patch = Array.from({ length: 50 }, () => '+'.padEnd(200, 'x')).join('\n');
    const preview = previewPatch(patch, { maxChars: 500 });
    expect(preview.text.length).toBeLessThanOrEqual(500);
    expect(preview.omittedLines).toBeGreaterThan(0);
  });
});

describe('worktree parsing', () => {
  const sample = [
    'worktree /repo',
    'HEAD 1111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /repo-worktrees/fix',
    'HEAD 2222222222222222',
    'branch refs/heads/fix/bug-1',
    '',
    'worktree /repo-worktrees/detached',
    'HEAD 3333333333333333',
    'detached',
    'locked',
    '',
  ].join('\n');

  it('reads every entry and marks the main checkout', () => {
    const entries = parseWorktreeList(sample);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ path: '/repo', branch: 'main', main: true });
    expect(entries[1]).toMatchObject({ path: '/repo-worktrees/fix', branch: 'fix/bug-1', main: false });
    expect(entries[2]).toMatchObject({ detached: true, locked: true, main: false });
  });

  it('matches by path, branch or directory name', () => {
    const entries = parseWorktreeList(sample);
    expect(matchWorktree(entries, '/repo-worktrees/fix')?.branch).toBe('fix/bug-1');
    expect(matchWorktree(entries, 'fix/bug-1')?.path).toBe('/repo-worktrees/fix');
    expect(matchWorktree(entries, 'detached')?.detached).toBe(true);
    expect(matchWorktree(entries, 'nope')).toBeUndefined();
  });

  it('puts a managed worktree beside the repo, never inside it', () => {
    const path = defaultWorktreePath('/home/me/code/antelope', 'fix/bug-1');
    expect(path).toBe('/home/me/code/.worktrees/antelope-fix-bug-1');
    expect(path.startsWith('/home/me/code/antelope/')).toBe(false);
  });
});

describe('pull request helpers', () => {
  it('parses a number, a #number and a PR url', () => {
    expect(parsePrArg('')).toEqual({ kind: 'current' });
    expect(parsePrArg('123')).toEqual({ kind: 'number', number: 123 });
    expect(parsePrArg('#123')).toEqual({ kind: 'number', number: 123 });
    expect(parsePrArg('https://github.com/o/r/pull/456')).toEqual({ kind: 'number', number: 456 });
    expect(parsePrArg('nonsense')).toMatchObject({ error: expect.any(String) });
  });

  it('rolls up mixed check-run and status-context shapes', () => {
    const rollup = rollupChecks([
      { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'slow', status: 'IN_PROGRESS' },
      { context: 'legacy/ci', state: 'SUCCESS' },
      { context: 'legacy/flaky', state: 'FAILURE' },
      { name: 'skipped', status: 'COMPLETED', conclusion: 'SKIPPED' },
    ]);
    expect(rollup).toMatchObject({ total: 6, passed: 3, failed: 2, pending: 1 });
    expect(rollup.failing).toEqual(['lint', 'legacy/flaky']);
  });

  it('labels the rollup with the worst state first', () => {
    expect(checksLabel({ total: 0, passed: 0, failed: 0, pending: 0, failing: [] })).toBe('无 CI');
    expect(checksLabel({ total: 3, passed: 3, failed: 0, pending: 0, failing: [] })).toContain('通过');
    expect(checksLabel({ total: 3, passed: 2, failed: 0, pending: 1, failing: [] })).toContain('进行中');
    expect(checksLabel({ total: 3, passed: 1, failed: 1, pending: 1, failing: ['lint'] })).toContain('失败');
  });

  it('labels review decisions', () => {
    expect(reviewLabel('APPROVED')).toContain('已批准');
    expect(reviewLabel('CHANGES_REQUESTED')).toContain('要求修改');
    expect(reviewLabel(undefined)).toBe('—');
  });
});
