import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'tsup';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { KnowledgeLibraryConfig } from '../../../src/config/profile-schema';
import { git } from '../../../src/git/exec';
import { buildKnowledgeContext } from '../../../src/knowledge/inject';
import { KnowledgeLibraries, parseEntryHeader, startOfWeek } from '../../../src/knowledge/knowledge-libraries';
import { READ_ONLY_PUSH_URL } from '../../../src/knowledge/libraries';
import { KnowledgeStore } from '../../../src/knowledge/store';

/**
 * Real git against a local bare repository, and the real hook script: built
 * from source into a directory under the repository's node_modules so its
 * dependencies resolve, the way `dist/knowledge-hook.js` does.
 */

let hookDir: string;
let hookScript: string;
let root: string;
let remote: string;
let config: KnowledgeLibraryConfig[];
let now: number;
let libraries: KnowledgeLibraries;

const AUTHOR = ['-c', 'user.name=cc', '-c', 'user.email=cc@example.com'];

async function run(cwd: string, args: string[]): Promise<{ ok: boolean; stderr: string; stdout: string }> {
  return git(cwd, args, { timeoutMs: 30_000 });
}

async function must(cwd: string, args: string[]): Promise<string> {
  const result = await run(cwd, args);
  if (!result.ok) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

async function put(dir: string, rel: string, body: string): Promise<void> {
  await mkdir(join(dir, rel, '..'), { recursive: true });
  await writeFile(join(dir, rel), body);
}

/** The department repository's layout, as a bare remote. */
async function departmentRepo(): Promise<string> {
  const src = join(root, 'src');
  await mkdir(src, { recursive: true });
  await must(src, ['init', '-q', '--initial-branch=main']);
  await put(src, 'README.md', '# 部门知识库\n');
  await put(src, 'templates/knowledge-entry.md', '# <一句话标题>\n');
  await put(
    src,
    'shared/pitfalls/site-lookup.md',
    '# 站点查询不是只读的\n\n- 来源：occam\n- 适用范围：设备迁移判断\n\n## 情况\n\n查站点会顺手建一个系统站点。\n',
  );
  await put(src, 'bots/cc/notes/own.md', '---\ntitle: 自己的笔记\ndescription: CC 记下的做法\n---\n\n正文\n');
  await put(src, 'bots/occam/notes/other.md', '# 别人的笔记\n\n别的 bot 的经验。\n');
  await put(src, 'bots/occam/weekly/2026-10-19.md', '# 周报\n\n不该进索引。\n');
  await must(src, ['add', '-A']);
  await must(src, [...AUTHOR, 'commit', '-q', '-m', 'init']);
  const bare = join(root, 'remote.git');
  await must(root, ['clone', '-q', '--bare', src, bare]);
  return bare;
}

beforeAll(async () => {
  hookDir = join(process.cwd(), 'node_modules', '.cache', `lcb-knowledge-hook-${randomBytes(4).toString('hex')}`);
  await build({
    entry: { 'knowledge-hook': 'src/knowledge/write-hook-main.ts' },
    outDir: hookDir,
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    silent: true,
    config: false,
    dts: false,
    sourcemap: false,
  });
  hookScript = join(hookDir, 'knowledge-hook.js');
}, 30_000);

afterAll(async () => {
  await rm(hookDir, { recursive: true, force: true });
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lcb-knowledge-libraries-'));
  remote = await departmentRepo();
  now = Date.now();
  config = [
    {
      name: 'dept',
      url: remote,
      read: ['shared/**', 'bots/*/notes/**'],
      write: { self: 'bots/cc', jobs: ['weekly'] },
    },
  ];
  libraries = new KnowledgeLibraries({
    dir: join(root, 'knowledge-libraries'),
    libraries: () => config,
    hookCommand: [process.execPath, hookScript],
    now: () => now,
  });
});

afterEach(async () => {
  await libraries.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

// Every hooked git command starts node and a few more git processes.
describe('knowledge libraries', { timeout: 30_000 }, () => {
  it('mirrors the repository read-only and indexes what the globs select, shared first', async () => {
    const [result] = await libraries.sync();
    expect(result).toMatchObject({ name: 'dept', ok: true, changed: true });

    const entries = await libraries.listEntries();
    expect(entries.map((entry) => [entry.kind, entry.title, entry.summary])).toEqual([
      ['shared', '站点查询不是只读的', '查站点会顺手建一个系统站点。'],
      ['own', '自己的笔记', 'CC 记下的做法'],
      ['personal', '别人的笔记', '别的 bot 的经验。'],
    ]);
    expect(await readFile(entries[0]!.path, 'utf8')).toContain('系统站点');

    const mirror = libraries.mirrorDir('dept');
    expect((await must(mirror, ['config', 'remote.origin.pushurl'])).trim()).toBe(READ_ONLY_PUSH_URL);
    await put(mirror, 'shared/x.md', '# 本地改动\n');
    await must(mirror, ['add', '-A']);
    await must(mirror, [...AUTHOR, 'commit', '-q', '-m', 'local']);
    const push = await run(mirror, ['push', 'origin', 'HEAD:refs/heads/main']);
    expect(push.ok).toBe(false);
    // …and the next sync throws the local commit away.
    await libraries.sync();
    expect((await libraries.listEntries()).some((entry) => entry.title === '本地改动')).toBe(false);
  });

  it('puts the index and, only while a window is open, the write target into the knowledge block', async () => {
    await libraries.sync();
    const store = new KnowledgeStore(join(root, 'knowledge'));
    store.setLibrarySource(libraries);

    const closed = await buildKnowledgeContext({ store, scopeId: 'oc_x' });
    expect(closed?.libraryKnowledge?.map((entry) => entry.title)).toEqual(['站点查询不是只读的', '自己的笔记', '别人的笔记']);
    expect(closed?.libraryKnowledge?.[0]).toMatchObject({ library: 'dept', authoritative: true });
    expect(closed?.libraryKnowledge?.[2]).toMatchObject({ personal: true });
    expect(closed?.libraryWrite).toBeUndefined();

    await libraries.openForJob('weekly');
    const open = await buildKnowledgeContext({ store, scopeId: 'oc_x' });
    expect(open?.libraryWrite).toEqual([
      {
        library: 'dept',
        work: libraries.workDir('dept'),
        self: 'bots/cc/',
        branch: 'main',
        until: new Date(now + 180 * 60_000).toISOString(),
      },
    ]);

    // The window runs out: the next turn sees no target, and the clean clone is gone.
    now += 181 * 60_000;
    const later = await buildKnowledgeContext({ store, scopeId: 'oc_x' });
    expect(later?.libraryWrite).toBeUndefined();
    expect(await readdir(join(root, 'knowledge-libraries'))).toEqual(['dept']);
  });

  it('opens a window only for the jobs a library lists', async () => {
    expect(await libraries.openForJob('daily-report')).toEqual([]);
    expect(await libraries.writeTargets()).toEqual([]);
    expect(await libraries.openForJob('weekly')).toEqual(['dept']);
  });

  it('refuses to open a window on a read-only library', async () => {
    config = [{ name: 'ro', url: remote }];
    await expect(libraries.openWindow('ro', { minutes: 30, reason: 'owner' })).rejects.toThrow('write.self');
  });

  it('pushes the bot its own directory to the default branch while the window is open', async () => {
    const target = await libraries.openWindow('dept', { minutes: 60, reason: 'owner' });
    await put(target.work, 'bots/cc/weekly/2026-10-24.md', '# CC 周报 · 2026-10-24\n\n本周排查了设备注册问题。\n');
    await must(target.work, ['add', '-A']);
    await must(target.work, [...AUTHOR, 'commit', '-q', '-m', 'cc: 2026-10-24 周报']);
    await must(target.work, ['push', '-q', 'origin', 'main']);
    expect(await must(remote, ['log', '-1', '--format=%s', 'main'])).toContain('cc: 2026-10-24 周报');

    await libraries.sync();
    const [status] = await libraries.status();
    // The repository's first commit also touched bots/cc/ this week.
    expect(status).toMatchObject({ entries: 3, weekCommits: 2, window: { reason: 'owner' } });
    expect(startOfWeek(now)).toBeLessThanOrEqual(now);
  });

  it('refuses shared changes on the default branch but takes them on a branch', async () => {
    const target = await libraries.openWindow('dept', { minutes: 60, reason: 'owner' });
    await put(target.work, 'shared/experience/new.md', '# 新结论\n\n做法。\n');
    await must(target.work, ['add', '-A']);
    const onMain = await run(target.work, [...AUTHOR, 'commit', '-q', '-m', 'distill: 2026-10-24 周提炼']);
    expect(onMain.ok).toBe(false);
    expect(onMain.stderr).toContain('Draft PR');

    await must(target.work, ['switch', '-q', '-c', 'distill/2026-10-24']);
    await must(target.work, [...AUTHOR, 'commit', '-q', '-m', 'distill: 2026-10-24 周提炼']);
    await must(target.work, ['push', '-q', '-u', 'origin', 'distill/2026-10-24']);
    // Even a commit that skipped the commit hooks is caught on the way to main.
    const toMain = await run(target.work, ['push', 'origin', 'distill/2026-10-24:main']);
    expect(toMain.ok).toBe(false);
    expect(toMain.stderr).toContain('bots/cc/');
  });

  it('refuses sensitive content and AI attribution', async () => {
    const target = await libraries.openWindow('dept', { minutes: 60, reason: 'owner' });
    await put(target.work, 'bots/cc/notes/sn.md', '# 笔记\n\n设备 ALB002024100077 搜不到。\n');
    await must(target.work, ['add', '-A']);
    const sn = await run(target.work, [...AUTHOR, 'commit', '-q', '-m', 'cc: 笔记']);
    expect(sn.ok).toBe(false);
    expect(sn.stderr).toContain('SN');
    expect(sn.stderr).not.toContain('ALB002024100077');

    await put(target.work, 'bots/cc/notes/sn.md', '# 笔记\n\n新装机设备搜不到时先查国家字段。\n');
    await must(target.work, ['add', '-A']);
    const signed = await run(target.work, [
      ...AUTHOR,
      'commit',
      '-q',
      '-m',
      'cc: 笔记\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
    ]);
    expect(signed.ok).toBe(false);
    expect(signed.stderr).toContain('署名');
  });

  it('refuses commits and pushes once the window closed, and keeps unpushed work for the next one', async () => {
    const target = await libraries.openWindow('dept', { minutes: 60, reason: 'owner' });
    await put(target.work, 'bots/cc/notes/a.md', '# 一条\n\n做法。\n');
    await must(target.work, ['add', '-A']);
    await must(target.work, [...AUTHOR, 'commit', '-q', '-m', 'cc: 一条']);

    expect(await libraries.closeWindow('dept')).toEqual({ keptWork: true });
    const push = await run(target.work, ['push', 'origin', 'main']);
    expect(push.ok).toBe(false);
    expect(push.stderr).toContain('不开放写入');
    await put(target.work, 'bots/cc/notes/b.md', '# 两条\n\n做法。\n');
    await must(target.work, ['add', '-A']);
    expect((await run(target.work, [...AUTHOR, 'commit', '-q', '-m', 'cc: 两条'])).ok).toBe(false);

    // Reopening keeps the commit instead of resetting to the remote.
    await libraries.openWindow('dept', { minutes: 60, reason: 'owner' });
    await must(target.work, ['push', '-q', 'origin', 'main']);
    expect(await must(remote, ['log', '-1', '--format=%s', 'main'])).toContain('cc: 一条');
  });

  it('removes the mirror, the window and the work clone', async () => {
    await libraries.sync();
    await libraries.openWindow('dept', { minutes: 60, reason: 'owner' });
    await libraries.remove('dept');
    expect(await readdir(join(root, 'knowledge-libraries'))).toEqual([]);
  });
});

describe('knowledge library entry headers', () => {
  it('falls back from front matter to the heading to the file name', () => {
    expect(parseEntryHeader('a/b.md', '---\nname: n\ndescription: d\n---\n# h\n')).toEqual({ title: 'n', summary: 'd' });
    expect(parseEntryHeader('a/b.md', '# 标题\n\n- 来源：x\n')).toEqual({ title: '标题', summary: '来源：x' });
    expect(parseEntryHeader('a/b.md', '只有正文\n')).toEqual({ title: 'b', summary: '只有正文' });
    expect(parseEntryHeader('a/b.md', '\n\n')).toBeUndefined();
  });
});
