import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ startRunFlow: vi.fn(), recordRunSessionEvent: vi.fn() }));

vi.mock('../../../src/bot/run-flow', () => ({
  startRunFlow: mocks.startRunFlow,
  recordRunSessionEvent: mocks.recordRunSessionEvent,
}));

const { runScheduledJob, jobScopeId } = await import('../../../src/scheduler/runner');
const { createDefaultProfileConfig } = await import('../../../src/config/profile-schema');
import type { AgentEvent } from '../../../src/agent/types';
import type { ScheduledJob } from '../../../src/scheduler/types';

const OWNER = 'ou_owner';

const sent: Array<{ chatId: string; payload: Record<string, unknown>; opts?: unknown }> = [];

const profileConfig = createDefaultProfileConfig({
  agentKind: 'claude',
  accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
});

function makeDeps(overrides: { clear?: () => void; setCwd?: () => void } = {}) {
  return {
    channel: {
      send: vi.fn(async (chatId: string, payload: Record<string, unknown>, opts?: unknown) => {
        sent.push({ chatId, payload, ...(opts ? { opts } : {}) });
        return { messageId: 'om_out' };
      }),
      botIdentity: { openId: 'ou_bot', name: 'bot' },
    },
    executor: {},
    sessions: { clear: overrides.clear ?? vi.fn(), getRaw: vi.fn(), resumeFor: vi.fn() },
    workspaces: { setCwd: overrides.setCwd ?? vi.fn(), cwdFor: vi.fn() },
    controls: {
      profile: 'claude',
      profileConfig,
      cfg: { accounts: profileConfig.accounts, preferences: {} },
      botOwnerId: OWNER,
      ownerRefreshState: 'ok',
    },
  } as never;
}

function job(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: 'abc123',
    prompt: '看一下昨天的日志',
    schedule: { kind: 'cron', expr: '0 9 * * *' },
    chatId: 'oc_chat',
    chatType: 'group',
    creatorId: OWNER,
    session: 'fresh',
    enabled: true,
    createdAt: 0,
    ...overrides,
  };
}

/** A flow whose run emits `events` then completes. */
function flowEmitting(events: AgentEvent[]) {
  return {
    ok: true as const,
    execution: {
      runId: 'run_1',
      handle: { interrupted: false, run: { stop: vi.fn() } },
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
        },
      }),
    },
    policy: { policyFingerprint: 'fp' },
    cwdRealpath: '/repo',
  };
}

const answer: AgentEvent[] = [
  { type: 'text', delta: '昨天有两次构建失败' },
  { type: 'done', terminationReason: 'normal' },
];

beforeEach(() => {
  sent.length = 0;
  mocks.startRunFlow.mockReset();
  mocks.recordRunSessionEvent.mockReset();
});

describe('scheduled job runs', () => {
  it('runs the job and delivers the answer to its chat', async () => {
    mocks.startRunFlow.mockResolvedValue(flowEmitting(answer));
    const deps = makeDeps();

    const record = await runScheduledJob(deps, job());

    expect(record.ok).toBe(true);
    expect(record.terminal).toBe('done');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe('oc_chat');
    expect(JSON.stringify(sent[0]?.payload)).toContain('昨天有两次构建失败');
    expect(JSON.stringify(sent[0]?.payload)).toContain('abc123');
  });

  it('runs under its own scope and remembers the job’s working directory', async () => {
    mocks.startRunFlow.mockResolvedValue(flowEmitting(answer));
    const setCwd = vi.fn();
    const deps = makeDeps({ setCwd });

    await runScheduledJob(deps, job({ cwd: '/repo/service' }));

    expect(setCwd).toHaveBeenCalledWith(jobScopeId('abc123'), '/repo/service');
    expect(mocks.startRunFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: 'cron:abc123',
        scope: expect.objectContaining({ source: 'cron', actorId: OWNER, chatId: 'oc_chat' }),
      }),
    );
  });

  it('starts a fresh session by default and keeps one when asked to continue', async () => {
    mocks.startRunFlow.mockResolvedValue(flowEmitting(answer));
    const clear = vi.fn();

    await runScheduledJob(makeDeps({ clear }), job());
    expect(clear).toHaveBeenCalledWith('cron:abc123');

    clear.mockClear();
    await runScheduledJob(makeDeps({ clear }), job({ session: 'continue' }));
    expect(clear).not.toHaveBeenCalled();
  });

  it('refuses to run when the creator lost access, without starting the agent', async () => {
    const deps = makeDeps();
    // Not the owner, not on any allowlist.
    const record = await runScheduledJob(deps, job({ creatorId: 'ou_stranger' }));

    expect(record.ok).toBe(false);
    expect(record.error).toContain('创建者已无权限');
    expect(mocks.startRunFlow).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('reports a rejected run instead of delivering an empty answer', async () => {
    mocks.startRunFlow.mockResolvedValue({
      ok: false,
      rejectReason: { code: 'run-already-active', userVisible: '当前会话已有运行在执行' },
    });

    const record = await runScheduledJob(makeDeps(), job());

    expect(record.ok).toBe(false);
    expect(record.error).toContain('当前会话已有运行在执行');
    expect(sent).toHaveLength(0);
  });

  it('marks a failed agent run as failed', async () => {
    mocks.startRunFlow.mockResolvedValue(
      flowEmitting([{ type: 'error', message: 'claude exited 1', terminationReason: 'failed' }]),
    );

    const record = await runScheduledJob(makeDeps(), job());

    expect(record.ok).toBe(false);
    expect(record.terminal).toBe('error');
  });

  it('delivers into the topic it was created in, falling back to chat level', async () => {
    mocks.startRunFlow.mockResolvedValue(flowEmitting(answer));
    const deps = makeDeps();
    const topicJob = job({ threadId: 'omt_1', anchorMessageId: 'om_anchor', chatType: 'topic' });

    await runScheduledJob(deps, topicJob);
    expect(sent[0]?.opts).toEqual({ replyTo: 'om_anchor', replyInThread: true });

    // Anchor gone (recalled message): the result still has to arrive.
    sent.length = 0;
    mocks.startRunFlow.mockResolvedValue(flowEmitting(answer));
    const failingDeps = makeDeps();
    (failingDeps as { channel: { send: ReturnType<typeof vi.fn> } }).channel.send = vi
      .fn()
      .mockRejectedValueOnce(new Error('message not found'))
      .mockImplementationOnce(async (chatId: string, payload: Record<string, unknown>) => {
        sent.push({ chatId, payload });
        return { messageId: 'om_out' };
      });

    await runScheduledJob(failingDeps, topicJob);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.opts).toBeUndefined();
  });

  it('skips delivery when the agent produced nothing', async () => {
    mocks.startRunFlow.mockResolvedValue(
      flowEmitting([{ type: 'done', terminationReason: 'normal' }]),
    );

    const record = await runScheduledJob(makeDeps(), job());

    expect(record.ok).toBe(true);
    expect(sent).toHaveLength(0);
  });
});
