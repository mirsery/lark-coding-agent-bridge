import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createCodingBoardReader, worktreePhase, type BoardJob } from '../../../src/coding-board/snapshot';
import { readBuildJobs } from '../../../src/coding-board/jobs';
import { jiraKey } from '../../../src/coding-board/sources';
import { addTask, updateTask } from '../../../src/coding-board/store';
import type { BuildJob } from '../../../src/coding-board/jobs';
import type { RepoPr } from '../../../src/coding-board/sources';

const job = (state: BoardJob['state'], startedAt = 10): BoardJob => ({ id: `j${startedAt}`, label: 'x', cmd: 'mvnd', startedAt, state });
const pr = (over: Partial<RepoPr> = {}): RepoPr => ({ number: 1, title: 'ABC-1: 修复', branch: 'feature/ABC-1', state: 'open', updatedAt: 5, ...over });

it('derives each phase from observed facts, builds first', () => {
  expect(worktreePhase({ jobs: [job('failed'), job('running', 20)], sessions: [] })).toBe('构建中');
  expect(worktreePhase({ jobs: [job('waiting')], pr: pr({ state: 'merged' }), sessions: [] })).toBe('构建排队');
  expect(worktreePhase({ jobs: [job('passed')], pr: pr({ state: 'merged' }), sessions: [] })).toBe('已合并');
  expect(worktreePhase({ jobs: [], pr: pr({ state: 'merged' }), sessions: [], dirty: 3 })).toBe('编码中');
  expect(worktreePhase({ jobs: [job('failed', 10)], pr: pr({ updatedAt: 5 }), sessions: [] })).toBe('门禁失败');
  expect(worktreePhase({ jobs: [job('failed', 1)], pr: pr({ updatedAt: 5, checks: { passed: 1, failed: 1, pending: 0, skipped: 0 } }), sessions: [] })).toBe('CI 失败');
  expect(worktreePhase({ jobs: [], pr: pr({ checks: { passed: 1, failed: 0, pending: 2, skipped: 0 } }), sessions: [] })).toBe('CI 中');
  expect(worktreePhase({ jobs: [], pr: pr({ review: 'APPROVED' }), sessions: [] })).toBe('待合并');
  expect(worktreePhase({ jobs: [], pr: pr(), sessions: [] })).toBe('等 review');
  expect(worktreePhase({ jobs: [job('passed')], sessions: [], dirty: 0 })).toBe('门禁通过');
  expect(worktreePhase({ jobs: [], sessions: [], dirty: 0 })).toBe('闲置');
});

it('treats only case-sensitive Jira-style tokens as keys', () => {
  expect(jiraKey('feature/ANTELOPE-8387-fields')).toBe('ANTELOPE-8387');
  expect(jiraKey('fix-409-validation', 'fix/soc-setting-dedup')).toBeUndefined();
  expect(jiraKey(undefined, 'MYA-1707')).toBe('MYA-1707');
});

it('reads build-queue jobs with exit codes and interrupted runners, newest within the window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-jobs-'));
  try {
    const add = async (id: string, meta: string, files: Record<string, string>) => {
      await mkdir(join(dir, id));
      await writeFile(join(dir, id, 'meta'), meta);
      for (const [name, text] of Object.entries(files)) await writeFile(join(dir, id, name), text);
    };
    await add('20261118-110730-8387-1', 'label=8387\nsession=s1\ncwd=/w/a\nstarted=2026-11-18 11:07:30\ncmd=mvnd install\n', { rc: '1\n', pid: '99999999' });
    await add('20261118-113810-8387-2', 'label=8387\ncwd=/w/a\nstarted=2026-11-18 11:38:10\ncmd=mvnd install\n', { pid: '99999999' });
    await add('20261118-114000-8271-3', 'label=8271\ncwd=/w/b\nstarted=2026-11-18 11:40:00\ncmd=mvnd\n', { pid: String(process.pid) });
    await add('20260101-000000-old-4', 'label=old\ncwd=/w/c\nstarted=2026-01-01 00:00:00\ncmd=x\n', { rc: '0' });
    const jobs = await readBuildJobs(new Date(2026, 10, 18, 12).getTime(), 7, dir);
    expect(jobs.map(j => [j.label, j.exitCode, j.interrupted ?? false, j.session])).toEqual([
      ['8387', 1, false, 's1'], ['8387', undefined, true, undefined], ['8271', undefined, false, undefined],
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('groups worktrees by Jira key, links builds to bridge sessions, and parks merged work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'board-root-'));
  try {
    await mkdir(join(root, 'profiles', 'claude'), { recursive: true });
    await writeFile(join(root, 'profiles', 'claude', 'sessions.json'), JSON.stringify({ 'oc_1:omt_1': { sessionId: 'sess-1', cwd: '/x' } }));
    const now = new Date(2026, 10, 18, 13, 45).getTime();
    const jobs: BuildJob[] = [
      { id: '1', label: '8387', cwd: '/w/ANTELOPE-8387', cmd: 'mvnd', startedAt: now - 3 * 3600_000, exitCode: 1, logFile: '/nope' },
      { id: '2', label: '8387', cwd: '/w/ANTELOPE-8387', cmd: 'mvnd', startedAt: now - 2 * 3600_000, exitCode: 0, logFile: '/nope' },
      { id: '3', label: '8387', cwd: '/w/8387-fields', cmd: 'mvnd -q install', startedAt: now - 60_000, session: 'sess-1', logFile: '/nope' },
    ];
    const read = createCodingBoardReader({
      roots: ['/w'],
      listRepos: async () => ['/w/antelope'],
      readRepo: async path => ({ path, slug: 'org/antelope', worktrees: [
        { path: '/w/ANTELOPE-8387', branch: 'feature/ANTELOPE-8387' },
        { path: '/w/8387-fields', branch: 'feature/ANTELOPE-8387-fields' },
        { path: '/w/ANTELOPE-8404', branch: 'feature/ANTELOPE-8404' },
        { path: '/w/old-spike', branch: 'spike/old' },
      ] }),
      readWorktree: async path => ({ dirty: path.endsWith('fields') ? 18 : 0, lastCommitAt: path.endsWith('spike') ? now - 30 * 86_400_000 : now - 3600_000 }),
      listPrs: async () => [
        pr({ number: 5629, title: 'ANTELOPE-8387: real-status 接入 EEBUS', branch: 'feature/ANTELOPE-8387', state: 'merged' }),
        pr({ number: 5626, title: 'ANTELOPE-8404: 电价', branch: 'feature/ANTELOPE-8404', state: 'merged' }),
        pr({ number: 5559, title: 'ANTELOPE-8359: OMS 账号', branch: 'feature/ANTELOPE-8359', state: 'open' }),
      ],
      readJobs: async () => jobs,
      readQueue: async () => ({ observedAt: now, state: 'available', entries: [{ path: '/w/8387-fields', state: 'running' }] }),
    });
    const bots = [{ profile: 'claude', name: 'CC', agent: 'claude', online: true, runs: [{ runId: 'r', scope: 'oc_1:omt_1', chatId: 'oc_1', threadId: 'omt_1', originMessageId: 'm', promptPreview: 'p', startedAt: now - 600_000, ownerPid: 1, chatType: 'p2p' as const, orphan: false }] }];
    await read.settle(root, bots);
    const board = await read(root, now, bots);
    expect(board.tasks.map(t => [t.key, t.phase])).toEqual([['ANTELOPE-8387', '构建中'], ['ANTELOPE-8359', '等 review']]);
    const task = board.tasks[0]!;
    expect(task.title).toBe('real-status 接入 EEBUS');
    expect(task.worktrees.map(w => [w.name, w.phase, w.dirty])).toEqual([['8387-fields', '构建中', 18], ['ANTELOPE-8387', '已合并', 0]]);
    expect(task.worktrees[0]!.sessions).toMatchObject([{ profile: 'claude', chatId: 'oc_1', threadId: 'omt_1', running: true }]);
    expect(task.worktrees[1]!.jobs.map(j => j.state)).toEqual(['failed', 'passed']);
    expect(board.tasks[1]!.worktrees[0]).toMatchObject({ cleaned: true, pr: { number: 5559 } });
    expect(board.merged).toEqual([{ key: 'ANTELOPE-8404', title: '电价', worktrees: ['/w/ANTELOPE-8404'] }]);
    expect(board.idle).toBe(1);
    expect(board.queue).toMatchObject([{ name: '8387-fields', state: 'running', cmd: 'mvnd -q install' }]);
    expect(board.counts).toEqual({ 构建中: 1, '等 review': 1 });

    // The registry still overrides: archiving a key hides it.
    const file = join(root, 'coding-board', 'tasks.json');
    const t = await addTask(file, { title: '隐藏', jira: 'ANTELOPE-8359' });
    await updateTask(file, t.id, x => { x.archived = true; });
    expect((await read(root, now, bots)).tasks.map(x => x.key)).toEqual(['ANTELOPE-8387']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reports a broken registry without hiding discovered tasks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'board-invalid-'));
  try {
    await mkdir(join(root, 'coding-board'));
    await writeFile(join(root, 'coding-board', 'tasks.json'), '{');
    const read = createCodingBoardReader({ listRepos: async () => [], readJobs: async () => [], readQueue: async () => ({ observedAt: 1, state: 'available', entries: [] }) });
    await read.settle(root);
    expect(await read(root, 1)).toMatchObject({ tasks: [], error: expect.stringContaining('无法读取') });
  } finally { await rm(root, { recursive: true, force: true }); }
});
