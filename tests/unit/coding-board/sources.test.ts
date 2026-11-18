import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { codingRoots, listRepos, parseRootsInput, profileCodingRoots, readConfiguredRoots } from '../../../src/coding-board/sources';
import { createCodingBoardReader } from '../../../src/coding-board/snapshot';

const dirs: string[] = [];
const temp = async () => { const d = await mkdtemp(join(tmpdir(), 'coding-roots-')); dirs.push(d); return d; };
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

it('lets LARK_CODING_ROOTS override the configured roots', () => {
  expect(codingRoots({ LARK_CODING_ROOTS: '/a:~/b' }, ['/saved'])).toEqual(['/a', join(homedir(), 'b')]);
  expect(codingRoots({}, ['~/workspace/antelope', '/x'])).toEqual([join(homedir(), 'workspace', 'antelope'), '/x']);
  expect(codingRoots({ LARK_CODING_ROOTS: '  ' }, ['/x'])).toEqual(['/x']);
  expect(codingRoots({}, [])).toEqual([]);
});

it('parses the settings input into absolute paths', () => {
  expect(parseRootsInput(' ~/workspace/antelope/ ， /srv/repos;relative\n/srv/repos ')).toEqual([join(homedir(), 'workspace', 'antelope'), '/srv/repos']);
  expect(parseRootsInput('')).toEqual([]);
});

it('defaults a profile to its working directory', () => {
  expect(profileCodingRoots({ workspaces: { default: '/w/claude' } })).toEqual(['/w/claude']);
  expect(profileCodingRoots({ preferences: { codingBoardRoots: [] }, workspaces: { default: '/w/claude' } })).toEqual(['/w/claude']);
  expect(profileCodingRoots({ preferences: { codingBoardRoots: ['/w/antelope'] }, workspaces: { default: '/w/claude' } })).toEqual(['/w/antelope']);
  expect(profileCodingRoots({})).toEqual([]);
});

it('accepts a root that is itself a repository, or a directory of repositories', async () => {
  const base = await temp();
  await mkdir(join(base, 'antelope', '.git'), { recursive: true });
  await mkdir(join(base, 'other', '.git'), { recursive: true });
  await mkdir(join(base, 'plain'), { recursive: true });
  await mkdir(join(base, 'linked'), { recursive: true });
  await writeFile(join(base, 'linked', '.git'), 'gitdir: elsewhere');
  expect(await listRepos([join(base, 'antelope')])).toEqual([join(base, 'antelope')]);
  expect(await listRepos([base])).toEqual([join(base, 'antelope'), join(base, 'other')]);
  expect(await listRepos([base, join(base, 'antelope')])).toEqual([join(base, 'antelope'), join(base, 'other')]);
});

const profile = (preferences: object, workspace: string) => ({
  agentKind: 'claude', accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } }, preferences, workspaces: { default: workspace },
});

it('unions every profile\'s roots from the bridge config', async () => {
  const root = await temp();
  expect(await readConfiguredRoots(root)).toEqual([]);
  await writeFile(join(root, 'config.json'), JSON.stringify({ schemaVersion: 2, profiles: {
    claude: profile({ codingBoardRoots: ['/x/antelope'] }, '/w/claude'),
    codex: profile({}, '/w/codex'),
  } }));
  expect(await readConfiguredRoots(root)).toEqual(['/x/antelope', '/w/codex']);
});

it('scans the configured roots of the bridge root it reads', async () => {
  const root = await temp();
  await writeFile(join(root, 'config.json'), JSON.stringify({ schemaVersion: 2, profiles: { claude: profile({ codingBoardRoots: ['/x/antelope'] }, '/w/claude') } }));
  const seen: string[][] = [];
  const saved = process.env.LARK_CODING_ROOTS;
  delete process.env.LARK_CODING_ROOTS;
  try {
    const read = createCodingBoardReader({ listRepos: async roots => { seen.push(roots); return []; }, readJobs: async () => [], readQueue: async () => ({ observedAt: 1, state: 'available', entries: [] }) });
    await read.settle(root);
  } finally { process.env.LARK_CODING_ROOTS = saved; }
  expect(seen[0]).toEqual(['/x/antelope']);
});
