import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret, listSecretIds } from '../../../src/config/keystore';
import {
  createDefaultProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { writeFailoverProfile, type AgentSwitchPhase } from '../../../src/runtime/agent-failover';
import { runtimeProfileConfig } from '../../../src/config/profile-store';
import { getMessageReplyMode, getRequireMentionInGroup, secretKeyForApp } from '../../../src/config/schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: vi.fn(async () => ({
    ok: true,
    botName: 'Updated Bot',
    botOpenId: 'ou-bot',
  })),
}));

const identityPolicyMocks = vi.hoisted(() => ({
  applyLarkCliIdentityPolicy: vi.fn(async () => true),
}));

vi.mock('../../../src/lark-cli/identity-policy', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lark-cli/identity-policy')>(
    '../../../src/lark-cli/identity-policy',
  );
  return {
    ...actual,
    applyLarkCliIdentityPolicy: identityPolicyMocks.applyLarkCliIdentityPolicy,
  };
});

const roots: string[] = [];

beforeEach(() => {
  identityPolicyMocks.applyLarkCliIdentityPolicy.mockReset();
  identityPolicyMocks.applyLarkCliIdentityPolicy.mockResolvedValue(true);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile-aware account and config commands', () => {
  it('lets only the owner use the legacy private config failover action without invoking the current agent', async () => {
    const h = await createHarness();
    const switchAgent = vi.fn(async () => {});
    const configureStandby = vi.fn(async () => {});
    h.controls.switchAgent = switchAgent;
    h.controls.configureStandby = configureStandby;
    h.controls.botOwnerId = 'ou-other';
    await h.command('/config agent switch claude agy');
    expect(switchAgent).not.toHaveBeenCalled();
    expect(JSON.stringify(h.channel.sent.at(-1)?.content)).toContain('仅限 bot 主人');

    h.controls.botOwnerId = 'ou-admin';
    await h.command('/config agent standby agy');
    expect(configureStandby).toHaveBeenCalledWith('agy');
    await h.command('/config agent switch claude agy');
    await vi.waitFor(() => expect(switchAgent).toHaveBeenCalledWith({ expected: 'claude', target: 'agy', interrupt: false }, expect.any(Function)));
    await vi.waitFor(() => expect(JSON.stringify(h.channel.rawClient.requests)).toContain('已切换'));
    await h.command('/config agent switch claude agy --interrupt');
    expect(switchAgent).toHaveBeenCalledTimes(1);
  });

  it('opens the private agent panel and lets the owner configure the standby from the card', async () => {
    const h = await createHarness();
    h.controls.switchAgent = vi.fn(async () => {});
    h.controls.configureStandby = vi.fn(async (standby) => {
      await writeFailoverProfile(h.controls.configPath, 'claude', (profile) => ({
        ...profile, agentFailover: { original: 'claude', preferences: {}, standby: standby ?? undefined },
      }));
    });

    expect(await h.command('/agent')).toBe(true);
    expect(JSON.stringify(h.channel.sent.at(-1)?.content)).toContain('agent.standby');
    await h.command('/agent standby agy');
    const panel = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(panel).toContain('Antigravity');
    expect(panel).toContain('群聊');
    expect(panel).toContain('agent.switch');
    expect(panel).toContain('中断任务并切换');
    expect(panel).toContain('confirm');
  });

  it('acknowledges a switch click while the runtime is still working and updates one result card', async () => {
    const h = await createHarness();
    const run = deferred<void>();
    const phase = deferred<(phase: AgentSwitchPhase) => void>();
    h.controls.configureStandby = vi.fn(async () => {});
    const switchAgent = h.controls.switchAgent = vi.fn(async (request, onPhase) => {
      phase.resolve(onPhase);
      await run.promise;
      await writeFailoverProfile(h.controls.configPath, 'claude', (profile) => ({
        ...profile, agentKind: request.target,
        agentFailover: { original: 'claude', standby: request.expected, preferences: {} },
      }));
    });
    await writeFailoverProfile(h.controls.configPath, 'claude', (profile) => ({
      ...profile, agentFailover: { original: 'claude', standby: 'agy', preferences: {} },
    }));

    await h.command('/agent switch claude agy');
    const updatePhase = await phase.promise;
    await vi.waitFor(() => expect(JSON.stringify(h.channel.sent.at(-1)?.content)).toContain('检查'));
    await h.command('/agent switch claude agy');
    expect(switchAgent).toHaveBeenCalledTimes(1);
    updatePhase('waiting');
    await vi.waitFor(() => expect(JSON.stringify(h.channel.rawClient.requests)).toContain('等待进行中的任务'));
    updatePhase('connecting');
    run.resolve();
    await vi.waitFor(() => {
      const updates = h.channel.rawClient.requests.filter((request) => request.method === 'cardkit.v1.card.update');
      expect(JSON.stringify(updates.at(-1)?.params)).toContain('已切换');
      expect(JSON.stringify(updates.at(-1)?.params)).toContain('agy claude');
      expect(new Set(updates.map((request) => (request.params as { cardId: string }).cardId)).size).toBe(1);
    });
  });

  it('shows the failure and keeps the standby available for retry after a confirmed interrupt', async () => {
    const h = await createHarness();
    h.controls.configureStandby = vi.fn(async () => {});
    const switchAgent = h.controls.switchAgent = vi.fn(async () => {
      throw new Error('备用 agent 登录过期');
    });
    await writeFailoverProfile(h.controls.configPath, 'claude', (profile) => ({
      ...profile, agentFailover: { original: 'claude', standby: 'agy', preferences: {} },
    }));

    await h.command('/agent interrupt claude agy');
    expect(switchAgent).not.toHaveBeenCalled();
    const send = vi.spyOn(h.channel, 'send');
    await h.command('/agent');
    const { messageId } = await send.mock.results[0]!.value;
    await h.command('/agent interrupt claude agy', undefined, messageId);
    await vi.waitFor(() => {
      const updates = h.channel.rawClient.requests.filter((request) => request.method === 'cardkit.v1.card.update');
      const result = JSON.stringify(updates.at(-1)?.params);
      expect(result).toContain('切换失败');
      expect(result).toContain('备用 agent 登录过期');
      expect(result).toContain('claude agy');
    });
    expect(switchAgent).toHaveBeenCalledWith({ expected: 'claude', target: 'agy', interrupt: true }, expect.any(Function));
  });

  it('saves /config submit into the active v2 profile without flattening root config', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      force_reply_in_thread: 'on',
      auto_worktree_cleanup: 'on',
      dream: 'on',
      dream_auto: 'on',
      topic_session_retention_months: '6',
      memory_pressure_gate: 'on',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.messageReply === 'text',
    );
    expect(root.schemaVersion).toBe(2);
    expect(root.activeProfile).toBe('claude');
    expect(root.profiles['codex-dev']).toBeDefined();
    expect(root.profiles.claude?.preferences).toMatchObject({
      messageReply: 'text',
      messageReplyMigrated: true,
      showToolCalls: false,
      forceReplyInThread: true,
      autoWorktreeCleanup: true,
      dream: true,
      dreamAuto: true,
      topicSessionRetentionMonths: 6,
      memoryPressureGate: true,
      maxConcurrentRuns: 7,
      runIdleTimeoutMinutes: 15,
    });
    expect(root.profiles.claude?.access.requireMentionInGroup).toBe(false);
    expect(root.profiles.claude?.larkCli.identityPreset).toBe('user-default');
    expect(root.profiles.claude?.larkCli.localUserImport).toMatchObject({
      status: 'not-needed',
      reason: 'manual-user-default',
    });
    expect(getRequireMentionInGroup(runtimeProfileConfig(root, 'claude'))).toBe(false);
    expect((root as unknown as { accounts?: unknown }).accounts).toBeUndefined();
  });

  it('switches non-admin approvals from /config, keeping the allowlist and applying it live', async () => {
    vi.useFakeTimers();
    const h = await createHarness({
      approvals: { enabled: false, allowCommands: ['lark-cli docs +fetch'], allowTools: ['mcp__tdengine-*'] },
    });

    await h.command('/config submit', { message_reply: 'text', approvals_enabled: 'on' });
    const on = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.approvals?.enabled === true && h.controls.profileConfig.approvals.enabled === true,
    );
    expect(on.profiles.claude?.approvals).toEqual({
      enabled: true,
      allowCommands: ['lark-cli docs +fetch'],
      allowTools: ['mcp__tdengine-*'],
    });
    // Gating reads the in-memory profile, so the switch needs no restart.
    expect(h.controls.profileConfig.approvals.enabled).toBe(true);

    await h.command('/config submit', { message_reply: 'text', approvals_enabled: 'off' });
    const off = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.approvals?.enabled === false && h.controls.profileConfig.approvals.enabled === false,
    );
    expect(off.profiles.claude?.approvals?.allowTools).toEqual(['mcp__tdengine-*']);
    expect(h.controls.profileConfig.approvals.enabled).toBe(false);
  });

  it('keeps approvals as they are when the submit payload omits the switch', async () => {
    vi.useFakeTimers();
    const h = await createHarness({
      approvals: { enabled: true, allowCommands: [], allowTools: [] },
    });

    await h.command('/config submit', { message_reply: 'text' });
    const root = await waitForRoot(h.rootDir, (candidate) => candidate.profiles.claude?.preferences.messageReply === 'text');
    expect(root.profiles.claude?.approvals?.enabled).toBe(true);
  });

  it('rejects a non-integer topic-session retention value', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', { topic_session_retention_months: '1.5' });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(h.channel.sent.length).toBeGreaterThan(0));

    const root = await readRoot(h.rootDir);
    expect(root.profiles.claude?.preferences.topicSessionRetentionMonths).toBeUndefined();
    expect(JSON.stringify(h.channel.sent.at(-1)?.content)).toContain('必须是非负整数');
  });

  it('persists the picked model and clears it when "default" is chosen', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', {
      model: 'claude-opus-5',
      message_reply: 'text',
    });
    const withModel = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.model === 'claude-opus-5',
    );
    expect(withModel.profiles.claude?.preferences.model).toBe('claude-opus-5');

    await h.command('/config submit', {
      model: 'default',
      message_reply: 'text',
    });
    const cleared = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.model === undefined,
    );
    expect(cleared.profiles.claude?.preferences.model).toBeUndefined();
  });

  it('keeps the current message reply mode when the config submit payload omits it', async () => {
    vi.useFakeTimers();
    const h = await createHarness({
      preferences: {
        messageReply: 'text',
        messageReplyMigrated: true,
      },
    });

    await h.command('/config submit', {
      show_tool_calls: 'show',
      max_concurrent_runs: '8',
      run_idle_timeout_minutes: '20',
      require_mention_in_group: 'yes',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.maxConcurrentRuns === 8,
    );
    expect(root.profiles.claude?.preferences.messageReply).toBe('text');
    expect(root.profiles.claude?.preferences.messageReplyMigrated).toBe(true);
    expect(getMessageReplyMode(runtimeProfileConfig(root, 'claude'))).toBe('text');
  });

  it('does not save a lark-cli identity change when applying the runtime policy fails', async () => {
    vi.useFakeTimers();
    identityPolicyMocks.applyLarkCliIdentityPolicy.mockResolvedValueOnce(false);
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(h.channel.sent.length).toBeGreaterThan(0);
    });

    const root = await readRoot(h.rootDir);
    expect(root.profiles.claude?.larkCli.identityPreset).toBe('bot-only');
    expect(root.profiles.claude?.preferences.messageReply).not.toBe('text');
    expect(appliedLarkCliIdentities()).toEqual([
      'user-default',
      'bot-only',
    ]);
    const card = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(card).toContain('保存失败');
    expect(card).toContain('lark-cli 身份策略');
    expect(card).not.toContain('偏好已保存');
  });

  it('rolls back lark-cli identity when saving config fails after applying the runtime policy', async () => {
    vi.useFakeTimers();
    const applied = deferred<boolean>();
    identityPolicyMocks.applyLarkCliIdentityPolicy
      .mockImplementationOnce(async () => applied.promise)
      .mockResolvedValue(true);
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });
    await Promise.resolve();
    await writeFile(resolveAppPaths({ rootDir: h.rootDir }).configFile, '{invalid json', 'utf8');
    applied.resolve(true);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(h.channel.sent.length).toBeGreaterThan(0);
    });

    expect(appliedLarkCliIdentities()).toEqual([
      'user-default',
      'bot-only',
    ]);
    const card = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(card).toContain('保存失败');
    expect(card).toContain('已回滚');
    expect(card).not.toContain('未做任何修改');
    expect(card).not.toContain('偏好已保存');
  });

  it('saves /account submit into the active v2 profile and profile-local keystore', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/account submit', {
      app_id: 'cli_new',
      app_secret: 'new-secret',
      tenant: 'lark',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.accounts.app.id === 'cli_new',
    );
    expect(root.schemaVersion).toBe(2);
    expect(root.profiles['codex-dev']).toBeDefined();
    expect(root.profiles.claude?.accounts.app).toMatchObject({
      id: 'cli_new',
      tenant: 'lark',
      secret: {
        source: 'exec',
        provider: 'bridge',
        id: secretKeyForApp('cli_new'),
      },
    });
    expect(root.secrets?.providers?.bridge?.command).toContain('secrets-getter');
    expect((root as unknown as { accounts?: unknown }).accounts).toBeUndefined();
    await expect(
      getSecret(secretKeyForApp('cli_new'), resolveAppPaths({ rootDir: h.rootDir, profile: 'claude' })),
    ).resolves.toBe('new-secret');
    const claudePaths = resolveAppPaths({ rootDir: h.rootDir, profile: 'claude' });
    const codexPaths = resolveAppPaths({ rootDir: h.rootDir, profile: 'codex-dev' });
    expect(claudePaths.secretsFile).not.toBe(codexPaths.secretsFile);
    await expect(
      listSecretIds(codexPaths),
    ).resolves.not.toContain(secretKeyForApp('cli_new'));
  });
});

async function createHarness(options: {
  preferences?: RootConfig['profiles'][string]['preferences'];
  approvals?: RootConfig['profiles'][string]['approvals'];
} = {}): Promise<{
  rootDir: string;
  channel: ReturnType<typeof createFakeChannel>;
  controls: Controls;
  command(content: string, formValue?: Record<string, unknown>, messageId?: string): Promise<boolean>;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), 'bridge-profile-config-command-'));
  roots.push(rootDir);
  const workspace = join(rootDir, 'workspace');
  await mkdir(workspace, { recursive: true });
  const root = await writeRoot(rootDir, workspace, options.preferences, options.approvals);
  const profileConfig = root.profiles.claude!;
  const appPaths = resolveAppPaths({ rootDir, profile: 'claude' });
  const channel = createFakeChannel();
  const sessions = new SessionStore(appPaths.sessionsFile);
  const workspaces = new WorkspaceStore(appPaths.workspacesFile);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-admin',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: appPaths.configFile,
    cfg: runtimeProfileConfig(root, 'claude'),
    processId: 'proc-1',
  } satisfies Controls;

  return {
    rootDir,
    channel,
    controls,
    command: (content: string, formValue?: Record<string, unknown>, messageId?: string) =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: { ...message(content), ...(messageId ? { messageId } : {}) },
        scope: 'chat-1',
        chatMode: 'p2p',
        sessions,
        workspaces,
        agent: new FakeAgentAdapter(),
        activeRuns: new ActiveRuns(),
        controls,
        formValue,
        fromCardAction: true,
      }),
  };
}

async function writeRoot(
  rootDir: string,
  workspace: string,
  preferences: RootConfig['profiles'][string]['preferences'] = {},
  approvals?: RootConfig['profiles'][string]['approvals'],
): Promise<RootConfig> {
  const root: RootConfig = {
    schemaVersion: 2,
    activeProfile: 'claude',
    preferences: {},
    profiles: {
      claude: createDefaultProfileConfig({
        agentKind: 'claude',
        accounts: {
          app: { id: 'cli_old', secret: '${APP_SECRET}', tenant: 'feishu' },
        },
        access: { admins: ['ou-admin'] },
      }),
      'codex-dev': createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: {
          app: { id: 'cli_codex', secret: '${APP_SECRET}', tenant: 'feishu' },
        },
        codex: { binaryPath: 'codex' },
      }),
    },
  };
  root.profiles.claude!.workspaces.default = workspace;
  root.profiles.claude!.preferences = {
    ...root.profiles.claude!.preferences,
    ...preferences,
  };
  if (approvals) root.profiles.claude!.approvals = approvals;
  await writeJson(resolveAppPaths({ rootDir }).configFile, root);
  await writeFile(join(rootDir, 'active-profile'), 'claude\n', 'utf8');
  return root;
}

async function readRoot(rootDir: string): Promise<RootConfig> {
  return JSON.parse(await readFile(resolveAppPaths({ rootDir }).configFile, 'utf8')) as RootConfig;
}

async function waitForRoot(
  rootDir: string,
  predicate: (root: RootConfig) => boolean,
): Promise<RootConfig> {
  let lastRoot = await readRoot(rootDir);
  await vi.waitFor(async () => {
    lastRoot = await readRoot(rootDir);
    expect(predicate(lastRoot)).toBe(true);
  }, { timeout: 5000 });
  return lastRoot;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function appliedLarkCliIdentities(): unknown[] {
  return (
    identityPolicyMocks.applyLarkCliIdentityPolicy.mock.calls as unknown as Array<[unknown, unknown]>
  ).map((call) => call[1]);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
