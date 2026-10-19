import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { loadRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { git } from '../../../src/git/exec.js';
import { KnowledgeAutoSync } from '../../../src/knowledge/auto-sync.js';
import { KnowledgeLibraries } from '../../../src/knowledge/knowledge-libraries.js';
import { SkillLibraries } from '../../../src/knowledge/libraries.js';
import { KnowledgeStore } from '../../../src/knowledge/store.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

async function createHarness(
  opts: { withKnowledge?: boolean; withLibraries?: boolean; withKnowledgeLibraries?: boolean } = {},
) {
  const tmp = await createTmpProfile('knowledge-command-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const store = new KnowledgeStore(join(tmp.profile, 'knowledge'));
  await store.ensure();

  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'], allowedUsers: ['ou-member'] },
  });
  profileConfig.workspaces.default = tmp.workspace;

  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.root, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
    ...(opts.withKnowledge === false ? {} : { knowledge: store }),
  } as unknown as Controls;

  let libraries: SkillLibraries | undefined;
  if (opts.withLibraries || opts.withKnowledgeLibraries) {
    // `/skills lib add|rm` persist through the profile (v2) config file.
    await saveRootConfig(
      { schemaVersion: 2, activeProfile: 'claude', preferences: {}, profiles: { claude: profileConfig } },
      controls.configPath,
    );
    libraries = new SkillLibraries({
      dir: join(tmp.profile, 'skill-libraries'),
      libraries: () => controls.profileConfig.skills?.libraries ?? [],
    });
    store.addSkillSource(libraries);
    controls.skillLibraries = libraries;
  }
  let knowledgeLibraries: KnowledgeLibraries | undefined;
  if (opts.withKnowledgeLibraries) {
    knowledgeLibraries = new KnowledgeLibraries({
      dir: join(tmp.profile, 'knowledge-libraries'),
      libraries: () => controls.profileConfig.knowledge?.libraries ?? [],
    });
    store.setLibrarySource(knowledgeLibraries);
    controls.knowledgeLibraries = knowledgeLibraries;
  }

  const run = (content: string, senderId = 'ou-admin'): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: {
        messageId: `om-${Math.random().toString(16).slice(2)}`,
        chatId: 'chat-1',
        chatType: 'group',
        senderId,
        senderName: 'User',
        content,
        resources: [],
        mentions: [],
        mentionedBot: false,
      } as unknown as NormalizedMessage,
      scope: 'chat-1',
      chatMode: 'group',
      sessions,
      workspaces,
      agent,
      activeRuns,
      controls,
    });

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, store, run, controls, libraries, knowledgeLibraries };
}

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as Record<string, unknown> | undefined;
  return typeof content?.markdown === 'string' ? content.markdown : '';
}

function lastCardJson(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as Record<string, unknown> | undefined;
  return JSON.stringify(content?.card ?? {});
}

describe('/memory', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('records, lists and forgets a chat note', async () => {
    const h = await createHarness();

    await expect(h.run('/memory add 这个群里 deploy 指的是 staging')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已记住（本会话）');
    const entries = await h.store.listMemories({ kind: 'chat', scopeId: 'chat-1' });
    expect(entries).toHaveLength(1);

    await expect(h.run('/memory')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('deploy');

    await expect(h.run(`/memory forget ${entries[0]!.id}`)).resolves.toBe(true);
    expect(await h.store.listMemories({ kind: 'chat', scopeId: 'chat-1' })).toHaveLength(0);
  });

  it('lets a non-admin member write chat notes but not global ones', async () => {
    const h = await createHarness();

    await expect(h.run('/memory add 本会话的约定', 'ou-member')).resolves.toBe(true);
    expect(await h.store.listMemories({ kind: 'chat', scopeId: 'chat-1' })).toHaveLength(1);

    await expect(h.run('/memory add --global 全局约定', 'ou-member')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员');
    expect(await h.store.listMemories({ kind: 'profile' })).toHaveLength(0);

    await expect(h.run('/memory add --global 全局约定')).resolves.toBe(true);
    expect(await h.store.listMemories({ kind: 'profile' })).toMatchObject([{ text: '全局约定' }]);
  });

  it('will not let a member delete a global note by guessing its id', async () => {
    const h = await createHarness();
    await h.run('/memory add --global 全局约定');
    const [global] = await h.store.listMemories({ kind: 'profile' });

    await expect(h.run(`/memory forget ${global!.id}`, 'ou-member')).resolves.toBe(true);
    expect(await h.store.listMemories({ kind: 'profile' })).toHaveLength(1);

    await expect(h.run(`/memory forget ${global!.id}`)).resolves.toBe(true);
    expect(await h.store.listMemories({ kind: 'profile' })).toHaveLength(0);
  });

  it('clears one scope at a time', async () => {
    const h = await createHarness();
    await h.run('/memory add 一');
    await h.run('/memory add 二');
    await h.run('/memory add --global 全局');

    await expect(h.run('/memory clear')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已清空 2 条');
    expect(await h.store.listMemories({ kind: 'profile' })).toHaveLength(1);
  });

  it('says so when the bridge has no knowledge store', async () => {
    const h = await createHarness({ withKnowledge: false });
    await expect(h.run('/memory')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('没有启用知识库');
  });
});

describe('/skills', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('lists skills and shows one', async () => {
    const h = await createHarness();
    await mkdir(join(h.store.skillsDir, 'deploy'), { recursive: true });
    await writeFile(
      join(h.store.skillsDir, 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: 发布步骤\n---\n\n第一步：跑测试\n',
    );

    await expect(h.run('/skills')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('发布步骤');

    await expect(h.run('/skills show deploy')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('第一步：跑测试');

    await expect(h.run('/skills show ../../etc/passwd')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('没找到 skill');
  });

  it('points at the directory when there are none', async () => {
    const h = await createHarness();
    await expect(h.run('/skills')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('SKILL.md');
  });
});

describe('/knowledge', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('reports status, binds a remote and syncs', async () => {
    const h = await createHarness();
    await h.run('/memory add 一条记忆');

    await expect(h.run('/knowledge')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('未绑定');

    const remote = join(h.tmp.root, 'remote.git');
    await mkdir(remote, { recursive: true });
    const init = await git(remote, ['init', '--bare', '--initial-branch=main']);
    expect(init.ok).toBe(true);

    await expect(h.run(`/knowledge bind ${remote}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已绑定远端');

    await expect(h.run('/knowledge sync')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已推送');

    await expect(h.run('/knowledge')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain(remote);
  });

  it('shows the auto-sync interval and the last failure, and a manual sync ends the streak', { timeout: 30_000 }, async () => {
    const h = await createHarness();
    const remote = join(h.tmp.root, 'remote.git');
    await mkdir(remote, { recursive: true });
    expect((await git(remote, ['init', '--bare', '--initial-branch=main'])).ok).toBe(true);
    await h.run(`/knowledge bind ${remote}`);
    expect(lastMarkdown(h.channel)).toContain('30 分钟自动同步');

    const dms: string[] = [];
    const auto = new KnowledgeAutoSync({
      store: h.store,
      intervalMinutes: () => 30,
      owner: () => 'ou-owner',
      send: async (_to, text) => {
        dms.push(text);
      },
    });
    h.controls.knowledgeAutoSync = auto;
    await rename(remote, `${remote}.gone`);
    await auto.tick();
    await auto.tick();
    expect(dms).toHaveLength(1);

    await h.run('/knowledge');
    const card = lastCardJson(h.channel);
    expect(card).toContain('每 30 分钟');
    expect(card).toContain('上次同步失败');
    expect(card).toContain('连续失败 2 次');
    expect(card).toContain('fatal:');

    await rename(`${remote}.gone`, remote);
    await h.run('/knowledge sync');
    expect(lastMarkdown(h.channel)).toContain('已推送');
    expect(auto.status()).toMatchObject({ failures: 0, last: { trigger: 'manual', ok: true } });
    await h.run('/knowledge');
    expect(lastCardJson(h.channel)).toContain('手动');
    // The manual success is not followed by a "recovered" DM.
    expect(dms).toHaveLength(1);
  });

  it('says auto-sync is off when the interval is 0', async () => {
    const h = await createHarness();
    h.controls.profileConfig.knowledge = { syncIntervalMinutes: 0 };
    const remote = join(h.tmp.root, 'remote.git');
    await mkdir(remote, { recursive: true });
    expect((await git(remote, ['init', '--bare', '--initial-branch=main'])).ok).toBe(true);
    await h.run(`/knowledge bind ${remote}`);
    expect(lastMarkdown(h.channel)).not.toContain('自动同步');

    await h.run('/knowledge');
    expect(lastCardJson(h.channel)).toContain('已关闭');
    await h.run('/knowledge help');
    expect(lastMarkdown(h.channel)).toContain('自动同步已关闭');
  });

  it('rejects a bogus remote and is admin-only', async () => {
    const h = await createHarness();

    await expect(h.run('/knowledge bind not-a-url')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('绑定失败');

    await expect(h.run('/knowledge sync', 'ou-member')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });
});

describe('/skills lib', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function libraryRepo(root: string, skills: Record<string, string>): Promise<string> {
    const repo = join(root, 'team-skills');
    await mkdir(repo, { recursive: true });
    await git(repo, ['init', '-q', '--initial-branch=main']);
    for (const [name, description] of Object.entries(skills)) {
      await mkdir(join(repo, 'skills', name), { recursive: true });
      await writeFile(join(repo, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`);
    }
    await git(repo, ['add', '-A']);
    const commit = await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init']);
    if (!commit.ok) throw new Error(commit.stderr);
    return repo;
  }

  it('adds a library, lists it, syncs and removes it', async () => {
    const h = await createHarness({ withLibraries: true });
    await mkdir(join(h.store.skillsDir, 'deploy'), { recursive: true });
    await writeFile(join(h.store.skillsDir, 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: 自己的\n---\n');
    const repo = await libraryRepo(h.tmp.root, { deploy: '库里的', triage: '排查流程' });

    await expect(h.run(`/skills lib add ${repo}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已添加 skill 库 `team-skills`');
    expect(lastMarkdown(h.channel)).toContain('载入 1 个 skill');
    expect(lastMarkdown(h.channel)).toContain('同名已存在');
    // Saved to the config file, not only in memory.
    const saved = await loadRootConfig(h.controls.configPath);
    expect(saved?.profiles.claude?.skills?.libraries).toEqual([{ name: 'team-skills', owner: 'self', url: repo }]);

    await expect(h.run('/skills')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('排查流程');
    expect(lastCardJson(h.channel)).toContain('team-skills');

    await expect(h.run('/skills show triage')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('排查流程');

    await expect(h.run('/skills lib')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('triage');

    await expect(h.run(`/skills lib add ${repo}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已经有叫');

    await expect(h.run('/skills lib sync')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已是最新');

    await expect(h.run('/skills lib rm team-skills')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已移除');
    expect((await loadRootConfig(h.controls.configPath))?.profiles.claude?.skills?.libraries ?? []).toEqual([]);
    expect((await h.store.listSkills()).map((skill) => skill.name)).toEqual(['deploy']);
  });

  it('pins an external library, shows upstream changes on sync and moves only on update', async () => {
    const h = await createHarness({ withLibraries: true });
    const repo = await libraryRepo(h.tmp.root, { deploy: '部门发布', triage: '排查流程' });

    await expect(h.run(`/skills lib add ${repo} dept --external`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已添加第三方 skill 库 `dept`');
    expect(lastMarkdown(h.channel)).toContain('不会自动更新');
    const pinned = (await loadRootConfig(h.controls.configPath))?.profiles.claude?.skills?.libraries[0];
    expect(pinned).toMatchObject({ name: 'dept', owner: 'external', url: repo });
    expect(pinned?.pin).toMatch(/^[0-9a-f]{40}$/);

    await mkdir(join(repo, 'skills', 'rollback'), { recursive: true });
    await writeFile(join(repo, 'skills', 'rollback', 'SKILL.md'), '---\nname: rollback\ndescription: 回滚\n---\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'add rollback']);

    await expect(h.run('/skills lib sync dept')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('领先 1 个提交');
    expect(lastMarkdown(h.channel)).toContain('新增 `rollback`');
    expect(lastMarkdown(h.channel)).toContain('/skills lib update dept');
    expect((await h.store.listSkills()).map((skill) => skill.name)).not.toContain('rollback');

    await expect(h.run('/skills lib')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('第三方库');
    expect(lastCardJson(h.channel)).toContain('领先 1 个提交');

    await expect(h.run('/skills lib update dept')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已从');
    const moved = (await loadRootConfig(h.controls.configPath))?.profiles.claude?.skills?.libraries[0];
    expect(moved?.pin).toMatch(/^[0-9a-f]{40}$/);
    expect(moved?.pin).not.toBe(pinned?.pin);
    expect((await h.store.listSkills()).map((skill) => skill.name)).toContain('rollback');

    await expect(h.run('/skills lib update dept')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已是上游最新');
  });

  it('does not save a library that cannot be fetched', async () => {
    const h = await createHarness({ withLibraries: true });

    await expect(h.run(`/skills lib add ${join(h.tmp.root, 'missing-repo')} broken`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('拉取 `broken` 失败');
    expect((await loadRootConfig(h.controls.configPath))?.profiles.claude?.skills).toBeUndefined();

    await expect(h.run('/skills lib add not-a-url')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不像 git 仓库地址');

    await expect(h.run('/skills lib add /srv/x --path ../../etc')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不合法');
  });

  it('is admin-only', async () => {
    const h = await createHarness({ withLibraries: true });
    const repo = await libraryRepo(h.tmp.root, { triage: '排查流程' });

    await expect(h.run(`/skills lib add ${repo}`, 'ou-member')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员');
    expect(h.controls.profileConfig.skills).toBeUndefined();

    // Listing what got loaded stays open to everyone.
    await expect(h.run('/skills', 'ou-member')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('Skills');
  });
});

describe('/knowledge lib', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function departmentRepo(root: string): Promise<string> {
    const repo = join(root, 'dept-kb');
    await mkdir(join(repo, 'shared', 'pitfalls'), { recursive: true });
    await mkdir(join(repo, 'bots', 'cc', 'notes'), { recursive: true });
    await git(repo, ['init', '-q', '--initial-branch=main']);
    await writeFile(join(repo, 'shared', 'pitfalls', 'a.md'), '# 公共的坑\n\n做法。\n');
    await writeFile(join(repo, 'bots', 'cc', 'notes', 'b.md'), '# 自己的笔记\n\n做法。\n');
    await git(repo, ['add', '-A']);
    const commit = await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init']);
    if (!commit.ok) throw new Error(commit.stderr);
    return repo;
  }

  it('subscribes, shows, opens a write window, binds a job and unsubscribes', async () => {
    const h = await createHarness({ withKnowledgeLibraries: true });
    const repo = await departmentRepo(h.tmp.root);

    await expect(h.run(`/knowledge lib add ${repo} dept --read shared/**,bots/*/notes/** --self bots/cc/`, 'ou-owner')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已订阅知识库 `dept`');
    expect(lastMarkdown(h.channel)).toContain('索引 2 条');
    const saved = await loadRootConfig(h.controls.configPath);
    expect(saved?.profiles.claude?.knowledge?.libraries).toEqual([
      { name: 'dept', url: repo, read: ['shared/**', 'bots/*/notes/**'], write: { self: 'bots/cc' } },
    ]);

    await expect(h.run('/knowledge', 'ou-owner')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('dept');
    expect(lastCardJson(h.channel)).toContain('写入窗口关闭');

    await expect(h.run('/knowledge lib write dept 30', 'ou-owner')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('写入窗口开到');
    expect((await h.knowledgeLibraries!.writeTargets()).map((target) => target.library)).toEqual(['dept']);
    await expect(h.run('/knowledge lib write dept off', 'ou-owner')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已关闭');
    expect(await h.knowledgeLibraries!.writeTargets()).toEqual([]);

    // Unbinding a job that is no longer scheduled still works; binding needs a real one.
    await expect(h.run('/knowledge lib write dept job nope', 'ou-owner')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('没有 id 为');

    // A skill binding needs the skill in the index, and keeps the other write settings.
    await expect(h.run('/knowledge lib write dept skill bot-weekly-meeting', 'ou-owner')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('skill 索引里没有');
    await mkdir(join(h.store.skillsDir, 'bot-weekly-meeting'), { recursive: true });
    await writeFile(
      join(h.store.skillsDir, 'bot-weekly-meeting', 'SKILL.md'),
      '---\nname: bot-weekly-meeting\ndescription: 主持机器人周会\n---\n\n正文\n',
    );
    await expect(h.run('/knowledge lib write dept skill bot-weekly-meeting', 'ou-owner')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('自动打开');
    expect((await loadRootConfig(h.controls.configPath))?.profiles.claude?.knowledge?.libraries?.[0]?.write).toEqual({
      self: 'bots/cc',
      skills: ['bot-weekly-meeting'],
    });
    await expect(h.run('/knowledge', 'ou-owner')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain('bot-weekly-meeting');
    await expect(h.run('/knowledge lib write dept skill bot-weekly-meeting', 'ou-owner')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不再打开');
    expect((await loadRootConfig(h.controls.configPath))?.profiles.claude?.knowledge?.libraries?.[0]?.write).toEqual({
      self: 'bots/cc',
    });

    await expect(h.run('/knowledge lib rm dept', 'ou-owner')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已取消订阅');
    expect((await loadRootConfig(h.controls.configPath))?.profiles.claude?.knowledge?.libraries).toBeUndefined();
    expect(await h.store.listLibraryEntries()).toEqual([]);
  });

  it('is for the bot owner only, admins included', async () => {
    const h = await createHarness({ withKnowledgeLibraries: true });
    const repo = await departmentRepo(h.tmp.root);

    await expect(h.run(`/knowledge lib add ${repo}`, 'ou-admin')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅限 bot 主人');
    expect(h.controls.profileConfig.knowledge).toBeUndefined();
  });

  it('rejects bad arguments before fetching anything', async () => {
    const h = await createHarness({ withKnowledgeLibraries: true });

    await expect(h.run('/knowledge lib add not-a-url', 'ou-owner')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不像 git 仓库地址');
    await expect(h.run('/knowledge lib add /srv/x --self ../../etc', 'ou-owner')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不合法');
    await expect(h.run('/knowledge lib add /srv/x kb.work', 'ou-owner')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不可用');
    await expect(h.run(`/knowledge lib add ${join(h.tmp.root, 'missing')} gone`, 'ou-owner')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('拉取 `gone` 失败');
  });
});
