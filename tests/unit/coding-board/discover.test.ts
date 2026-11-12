import { expect, it } from 'vitest';
import { worktreeCandidates } from '../../../src/cli/commands/coding-board';

it('only offers unregistered worktrees as unconfirmed candidates', () => {
  const base = { detached: false, main: false, locked: false };
  expect(worktreeCandidates([
    { ...base, path: '/work/one', branch: 'feature/ABC-12-fix' },
    { ...base, path: '/work/two', branch: 'feature/ABC-13' },
    { ...base, path: '/work/three', branch: 'no-key' },
  ], ['/work/two'])).toMatchObject([
    { path: '/work/one', candidates: ['ABC-12'], confidence: 'unconfirmed' },
    { path: '/work/three', candidates: [], confidence: 'unconfirmed' },
  ]);
});
