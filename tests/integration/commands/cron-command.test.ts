import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { Scheduler } from '../../../src/scheduler/scheduler.js';
import { JobStore } from '../../../src/scheduler/store.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

interface RunOverrides {
  chatId?: string;
  senderId?: string;
  chatMode?: CommandContext['chatMode'];
}

async function createHarness(opts: { withScheduler?: boolean } = {}) {
  const tmp = await createTmpProfile('cron-command-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
  });
  profileConfig.workspaces.default = tmp.workspace;

  const store = new JobStore(join(tmp.profile, 'jobs.json'));
  const runJob = vi.fn(async () => ({ startedAt: 1, finishedAt: 2, ok: true, terminal: 'done' }));
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
  } as unknown as Controls;

  if (opts.withScheduler !== false) {
    controls.scheduler = new Scheduler({
      store,
      channel: channel as never,
      executor: {} as never,
      sessions,
      workspaces,
      controls,
      runJob,
    });
  }

  const run = (content: string, overrides: RunOverrides = {}): Promise<boolean> => {
    const chatId = overrides.chatId ?? 'chat-1';
    return tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: {
        messageId: `om-${Math.random().toString(16).slice(2)}`,
        chatId,
        chatType: 'p2p',
        senderId: overrides.senderId ?? 'ou-admin',
        senderName: 'User',
        content,
        resources: [],
        mentions: [],
        mentionedBot: false,
      } as unknown as NormalizedMessage,
      scope: chatId,
      chatMode: overrides.chatMode ?? 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      controls,
    });
  };

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), store.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, store, controls, runJob, activeRuns, run };
}

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as Record<string, unknown> | undefined;
  return typeof content?.markdown === 'string' ? content.markdown : '';
}

function lastCardJson(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as Record<string, unknown> | undefined;
  return JSON.stringify(content?.card ?? {});
}

describe('/cron', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('creates, lists, pauses, resumes and removes a job', async () => {
    const h = await createHarness();

    await expect(h.run('/cron add 0 9 * * 1-5 | 总结昨天的 CI 失败')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已创建定时任务');
    const created = h.store.list()[0]!;
    expect(created).toMatchObject({
      prompt: '总结昨天的 CI 失败',
      schedule: { kind: 'cron', expr: '0 9 * * 1-5' },
      chatId: 'chat-1',
      creatorId: 'ou-admin',
      session: 'fresh',
      enabled: true,
    });
    expect(created.nextRunAt).toBeGreaterThan(Date.now());
    expect(created.cwd).toBe(h.tmp.workspace);

    await expect(h.run('/cron list')).resolves.toBe(true);
    expect(lastCardJson(h.channel)).toContain(created.id);

    await expect(h.run(`/cron pause ${created.id}`)).resolves.toBe(true);
    expect(h.store.get(created.id)).toMatchObject({ enabled: false, nextRunAt: undefined });

    await expect(h.run(`/cron resume ${created.id}`)).resolves.toBe(true);
    expect(h.store.get(created.id)?.enabled).toBe(true);
    expect(h.store.get(created.id)?.nextRunAt).toBeGreaterThan(Date.now());

    await expect(h.run(`/cron remove ${created.id}`)).resolves.toBe(true);
    expect(h.store.get(created.id)).toBeUndefined();
  });

  it('explains itself instead of creating a job it cannot schedule', async () => {
    const h = await createHarness();

    await expect(h.run('/cron add 每天早上看看日志')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('定时任务');
    expect(h.store.list()).toHaveLength(0);

    await expect(h.run('/cron add 61 9 * * * | 越界')).resolves.toBe(true);
    expect(h.store.list()).toHaveLength(0);
  });

  it('is admin-only', async () => {
    const h = await createHarness();

    await expect(h.run('/cron add @daily | 巡检', { senderId: 'ou-stranger' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
    expect(h.store.list()).toHaveLength(0);
  });

  it('refuses to manage another chat’s job', async () => {
    const h = await createHarness();
    await h.run('/cron add @daily | 巡检');
    const created = h.store.list()[0]!;

    await expect(h.run(`/cron remove ${created.id}`, { chatId: 'chat-2' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('未找到该任务');
    expect(h.store.get(created.id)).toBeDefined();
  });

  it('triggers a manual run without waiting for it', async () => {
    const h = await createHarness();
    await h.run('/cron add @daily | 巡检');
    const created = h.store.list()[0]!;

    await expect(h.run(`/cron run ${created.id}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已触发');
    await vi.waitFor(() => expect(h.runJob).toHaveBeenCalledTimes(1));
    // A manual run must not move the schedule.
    expect(h.store.get(created.id)?.nextRunAt).toBeGreaterThan(Date.now());
  });

  it('says so when the bridge has no scheduler', async () => {
    const h = await createHarness({ withScheduler: false });

    await expect(h.run('/cron list')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('没有启用定时任务');
  });
});
