import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCapability, codexCapability } from '../../../src/agent/capability.js';
import type { AgentSessionProbe } from '../../../src/agent/session-probe.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { startRunFlow, type StartRunFlowInput } from '../../../src/bot/run-flow.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { SMART_SESSION_DEFAULTS } from '../../../src/config/schema.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import type { PendingRotation } from '../../../src/session/smart-session.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];
const HOUR = 60 * 60_000;
const NOW = 1000;

describe('会话智能压缩 — run-flow rotation', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('starts fresh, archives the old conversation and hands off when idle with a large context', async () => {
    const h = await harnessWithActiveSession('claude');
    const probed: string[] = [];
    const run = await start(h, {
      probe: async (handle) => {
        probed.push(handle);
        return { lastActivityAt: NOW - 2 * HOUR, contextTokens: 400_000, lastUserText: '查一下 T20 的版本' };
      },
    });

    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('expected run');
    expect(probed).toEqual(['sess-old']);
    expect(run.rotated).toMatchObject({ reason: 'idle-large', idleMinutes: 120, contextTokens: 400_000 });
    expect(run.resumeFrom).toBeUndefined();
    expect(h.agent.runOptions[1]?.sessionId).toBeUndefined();
    expect(h.agent.runOptions[1]?.prompt).toMatch(/^<session_handoff>/);
    expect(h.agent.runOptions[1]?.prompt).toContain('查一下 T20 的版本');
    expect(h.agent.runOptions[1]?.prompt).toContain('hello');
    expect(h.catalog.activeFor(identity(h, run))).toBeUndefined();
  });

  it('runs a resumed conversation at its /effort level and drops it when the conversation rotates', async () => {
    for (const agentKind of ['claude', 'codex'] as const) {
      const warm = await harnessWithActiveSession(agentKind);
      warm.sessions.setEffort('chat-1', 'xhigh');
      const kept = await start(warm, { probe: async () => ({ lastActivityAt: NOW - 60_000, contextTokens: 20_000 }) });
      expect(kept.ok && kept.effortSource).toBe('session');
      expect(warm.agent.runOptions[1]?.effort).toBe('xhigh');

      const cold = await harnessWithActiveSession(agentKind);
      cold.sessions.setEffort('chat-1', 'xhigh');
      const rotated = await start(cold, {
        probe: async () => ({ lastActivityAt: NOW - 2 * HOUR, contextTokens: 400_000 }),
      });
      expect(rotated.ok && rotated.rotated).toBeTruthy();
      expect(rotated.ok && rotated.effortSource).toBeUndefined();
      expect(cold.agent.runOptions[1]?.effort).not.toBe('xhigh');
      expect(cold.sessions.getEffort('chat-1')).toBeUndefined();
    }
  });

  it('runs a light turn at low and a job at its own level, over /effort', async () => {
    const h = await harnessWithActiveSession('claude');
    h.sessions.setEffort('chat-1', 'max');
    const light = await start(h, undefined, { lightTurn: true });
    expect(light.ok && light.effort).toBe('low');
    expect(light.ok && light.effortSource).toBe('light');
    expect(h.agent.runOptions[1]?.effort).toBe('low');
    if (light.ok) await collect(light.execution.subscribe());

    const job = await start(h, undefined, { jobEffort: 'medium' });
    expect(job.ok && job.effortSource).toBe('job');
    expect(h.agent.runOptions[2]?.effort).toBe('medium');
  });

  it('keeps resuming a recent conversation', async () => {
    const h = await harnessWithActiveSession('claude');
    const run = await start(h, {
      probe: async () => ({ lastActivityAt: NOW - 10 * 60_000, contextTokens: 900_000 }),
    });

    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('expected run');
    expect(run.rotated).toBeUndefined();
    expect(run.resumeFrom).toBe('sess-old');
    expect(h.agent.runOptions[1]?.sessionId).toBe('sess-old');
    expect(h.agent.runOptions[1]?.prompt).toBe('hello');
  });

  it('keeps an idle conversation whose context is small, until the hard idle limit', async () => {
    const small = await harnessWithActiveSession('claude');
    const kept = await start(small, { probe: async () => ({ lastActivityAt: NOW - 3 * HOUR, contextTokens: 40_000 }) });
    expect(kept.ok && kept.rotated).toBeFalsy();

    const old = await harnessWithActiveSession('claude');
    const rotated = await start(old, { probe: async () => ({ lastActivityAt: NOW - 9 * HOUR, contextTokens: 40_000 }) });
    expect(rotated.ok && rotated.rotated?.reason).toBe('idle-long');
  });

  it('applies a close the agent asked for, with its summary in the hand-off', async () => {
    const h = await harnessWithActiveSession('codex');
    const run = await start(h, {
      pending: { summary: '排查完 ALF021024080047 的校准问题' },
      probe: async () => ({ lastActivityAt: NOW - 15 * 60_000, contextTokens: 20_000 }),
    });

    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('expected run');
    expect(run.rotated?.reason).toBe('agent-done');
    expect(h.agent.runOptions[1]?.threadId).toBeUndefined();
    expect(h.agent.runOptions[1]?.prompt).toContain('排查完 ALF021024080047 的校准问题');
  });

  it('keeps the conversation for a follow-up right after an agent-requested close', async () => {
    const h = await harnessWithActiveSession('claude');
    const run = await start(h, {
      pending: { summary: '修完了' },
      probe: async () => ({ lastActivityAt: NOW - 2 * 60_000, contextTokens: 20_000 }),
    });
    expect(run.ok && run.resumeFrom).toBe('sess-old');
  });

  it('keeps a quoted conversation until the hard idle limit, then hands off with a quote hint', async () => {
    const warm = await harnessWithActiveSession('claude');
    const kept = await start(warm, {
      quoted: true,
      probe: async () => ({ lastActivityAt: NOW - 2 * HOUR, contextTokens: 400_000 }),
    });
    expect(kept.ok && kept.resumeFrom).toBe('sess-old');

    const cold = await harnessWithActiveSession('claude');
    const rotated = await start(cold, {
      quoted: true,
      probe: async () => ({ lastActivityAt: NOW - 9 * HOUR, contextTokens: 400_000 }),
    });
    expect(rotated.ok && rotated.rotated?.reason).toBe('idle-long');
    expect(cold.agent.runOptions[1]?.prompt).toContain('quoted_messages');
  });

  it('hands off the last answer and the task ledger it announced', async () => {
    const h = await harnessWithActiveSession('claude');
    const run = await start(h, {
      probe: async () => ({
        lastActivityAt: NOW - 9 * HOUR,
        contextTokens: 40_000,
        lastAnswerText: '第一阶段做完，下一步跑门禁。',
        ledgerText: '开工。\n📒 任务台账：~/.lark-channel/tasks/big-job.md',
      }),
    });
    expect(run.ok && run.rotated?.ledger).toBe('~/.lark-channel/tasks/big-job.md');
    const prompt = h.agent.runOptions[1]?.prompt ?? '';
    expect(prompt).toContain('第一阶段做完，下一步跑门禁。');
    expect(prompt).toContain('~/.lark-channel/tasks/big-job.md');
  });

  it('sends a knowledge stub to a resumed conversation that still holds the block', async () => {
    const config = await mkdtemp(join(tmpdir(), 'claude-config-'));
    const project = join(config, 'projects', '-elsewhere');
    await mkdir(project, { recursive: true });
    const full = '<bridge_knowledge>\n{"version":"abc123","profileMemory":["m"]}\n</bridge_knowledge>';
    const stub = '<bridge_knowledge>\n{"unchangedSince":"abc123"}\n</bridge_knowledge>';
    await writeFile(
      join(project, 'sess-old.jsonl'),
      `${JSON.stringify({ type: 'user', message: { content: `${full}\n\n<user_input>x</user_input>` } })}\n`,
    );
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    cleanups.push(async () => {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      await rm(config, { recursive: true, force: true });
    });
    const knowledge = { version: 'abc123', full, stub };
    const prompt = `${full}\n\nhello`;

    const resumed = await harnessWithActiveSession('claude');
    await start(resumed, { probe: async () => ({ lastActivityAt: NOW - 60_000 }) }, { knowledge, prompt });
    expect(resumed.agent.runOptions[1]?.prompt).toBe(`${stub}\n\nhello`);

    const changed = await harnessWithActiveSession('claude');
    await start(changed, undefined, { knowledge: { ...knowledge, version: 'def456' }, prompt });
    expect(changed.agent.runOptions[1]?.prompt).toBe(prompt);

    const rotated = await harnessWithActiveSession('claude');
    await start(rotated, { probe: async () => ({ lastActivityAt: NOW - 9 * HOUR }) }, { knowledge, prompt });
    expect(rotated.agent.runOptions[1]?.prompt).toContain(full);

    const codex = await harnessWithActiveSession('codex');
    await start(codex, undefined, { knowledge, prompt });
    expect(codex.agent.runOptions[1]?.prompt).toBe(prompt);
  });

  it('never probes or rotates without the rotation option', async () => {
    const h = await harnessWithActiveSession('claude');
    const run = await start(h, undefined);
    expect(run.ok && run.resumeFrom).toBe('sess-old');
  });

  it.each(['claude', 'codex'] as const)('forwards the compaction window to %s', async (agentKind) => {
    const h = await harnessWithActiveSession(agentKind);
    await start(h, { probe: async () => undefined }, { compactWindowTokens: 300_000 });
    expect(h.agent.runOptions[1]?.compactWindowTokens).toBe(300_000);
  });
});

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function harnessWithActiveSession(agentKind: 'claude' | 'codex'): Promise<Harness> {
  const h = await createHarness(agentKind);
  const first = await start(h, undefined);
  if (!first.ok) throw new Error('expected initial run');
  await collect(first.execution.subscribe());
  h.catalog.upsertActive({
    ...identity(h, first),
    ...(agentKind === 'codex' ? { threadId: 'sess-old' } : { sessionId: 'sess-old' }),
    now: NOW,
  });
  return h;
}

function identity(h: Harness, run: { cwdRealpath: string; policy: { policyFingerprint: string } }) {
  return {
    scopeId: 'chat-1',
    agentId: h.profileConfig.agentKind,
    cwdRealpath: run.cwdRealpath,
    policyFingerprint: run.policy.policyFingerprint,
  };
}

async function start(
  h: Harness,
  rotation:
    | {
        probe: (handle: string, cwd: string) => Promise<AgentSessionProbe | undefined>;
        pending?: PendingRotation;
        quoted?: boolean;
      }
    | undefined,
  extra: Partial<Pick<StartRunFlowInput, 'compactWindowTokens' | 'knowledge' | 'prompt' | 'lightTurn' | 'jobEffort'>> = {},
) {
  const input = {
    scopeId: 'chat-1',
    scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
    prompt: 'hello',
    attachments: [],
    access: { ok: true, reason: 'allowed-user' },
    capability:
      h.profileConfig.agentKind === 'codex'
        ? codexCapability(h.profileConfig)
        : claudeCapability(h.profileConfig),
    profileConfig: h.profileConfig,
    sessions: h.sessions,
    sessionCatalog: h.catalog,
    workspaces: h.workspaces,
    executor: h.executor,
    now: NOW,
    ...extra,
    ...(rotation
      ? {
          rotation: {
            settings: SMART_SESSION_DEFAULTS,
            probe: rotation.probe,
            ...(rotation.pending ? { pending: rotation.pending } : {}),
            ...(rotation.quoted ? { quoted: true } : {}),
          },
        }
      : {}),
  } satisfies StartRunFlowInput;
  return startRunFlow(input);
}

async function createHarness(agentKind: 'claude' | 'codex'): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  profileConfig: ProfileConfig;
}> {
  const tmp = await createTmpProfile(`smart-session-${agentKind}-test-`);
  const agent = new FakeAgentAdapter({
    id: agentKind,
    displayName: agentKind,
    events: [[{ type: 'done', terminationReason: 'normal' }]],
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind,
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    ...(agentKind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
  });
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    agent,
    executor: new RunExecutor({
      agent,
      pool: new ProcessPool(() => 10),
      activeRuns: new ActiveRuns(),
      createRunId: () => `run-${agent.runOptions.length + 1}`,
      now: () => 1000,
    }),
    sessions,
    workspaces,
    catalog,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        default: tmp.workspace,
      },
    },
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    /* drain */
  }
}

