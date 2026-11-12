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

it('registers a CLI that accepts the gate command without breaking startup', async () => {
  const { Command } = await import('commander');
  const { registerCodingBoard } = await import('../../../src/cli/commands/coding-board');
  const program = new Command();
  expect(() => registerCodingBoard(program)).not.toThrow();
  const board = program.commands.find(c => c.name() === 'coding-board');
  expect(board?.commands.find(c => c.name() === 'gate')?.registeredArguments).toHaveLength(2);
});
