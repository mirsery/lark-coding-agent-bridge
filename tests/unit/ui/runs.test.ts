import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ALIVE_PID = 424242;
const DEAD_PID = 999999;

vi.mock('../../../src/runtime/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/runtime/registry')>()),
  isAlive: (pid: number) => pid === ALIVE_PID || pid === process.pid,
}));

import type { NormalizedMessage } from '@larksuite/channel';
import type { AgentRun } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { createRunsMonitor } from '../../../src/bot/runs-monitor';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';
import { RunRegistry, type RunRecord } from '../../../src/runtime/run-registry';
import { HttpError } from '../../../src/ui/http';
import { listRuns, stopRun } from '../../../src/ui/runs';
import type { UiSupervisor } from '../../../src/ui/types';

const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };

/** A fixed "now" far enough from 0 that a 25h-old record stays positive. */
const BASE = 100 * 60 * 60 * 1000;
const fakeRun = { stop: async () => {}, waitForExit: async () => true } as unknown as AgentRun;

let rootDir: string;

function diskRecord(over: Partial<RunRecord>): RunRecord {
  return {
    runId: 'run-x',
    scope: 'oc_disk',
    chatId: 'oc_disk',
    originMessageId: 'om_1',
    promptPreview: '磁盘上的任务',
    startedAt: BASE - 60_000,
    ownerPid: ALIVE_PID,
    ...over,
  };
}

async function writeRunsFile(profile: string, records: RunRecord[]): Promise<void> {
  const file = resolveAppPaths({ rootDir, profile }).runsFile;
  const map = Object.fromEntries(records.map((r) => [r.runId, r]));
  await writeFile(file, JSON.stringify(map, null, 2));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function supervisorWith(online: Map<string, any>): UiSupervisor {
  return {
    isOnline: (p) => online.has(p),
    controlsFor: (p) => online.get(p),
    channelFor: () => undefined,
    list: () =>
      [...online.keys()].map((p) => ({
        profile: p,
        agentKind: 'claude' as const,
        online: true,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      })),
    startProfile: async () => {},
    stopProfile: async () => {},
    restartProfile: async () => {},
  };
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'ui-runs-test-'));
  const configPath = join(rootDir, 'config.json');
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  await mkdir(join(rootDir, 'profiles', 'work'), { recursive: true });
  await saveRootConfig(
    createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } })),
    configPath,
  );
  const rc = (await loadRootConfig(configPath))!;
  rc.profiles.work = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { ...app, id: 'cli_work' } },
  });
  await saveRootConfig(rc, configPath);
  await writeActiveProfile(rootDir, 'claude');
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('listRuns aggregation', () => {
  it('reads a hosted profile from memory: registry fields, queue depth, chat name', async () => {
    const activeRuns = new ActiveRuns();
    const pending = new PendingQueue(60_000, () => {});
    const runs = new RunRegistry(join(rootDir, 'profiles', 'claude', 'runs.json'), process.pid);
    activeRuns.register('oc_chat_a', fakeRun, BASE - 5_000);
    runs.start({
      runId: 'run-1',
      scope: 'oc_chat_a',
      chatId: 'oc_chat_a',
      originMessageId: 'om_1',
      promptPreview: '写一份周报',
      startedAt: BASE - 30_000,
    });
    pending.block('oc_chat_a');
    pending.push('oc_chat_a', { chatId: 'oc_chat_a' } as NormalizedMessage);
    pending.push('oc_chat_a', { chatId: 'oc_chat_a' } as NormalizedMessage);

    const online = new Map([
      [
        'claude',
        {
          runsMonitor: createRunsMonitor({ activeRuns, pending, runs }),
          knownChats: [{ id: 'oc_chat_a', name: '研发群' }],
        },
      ],
    ]);
    const views = await listRuns(supervisorWith(online), rootDir, BASE);
    await runs.flush();

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      profile: 'claude',
      scope: 'oc_chat_a',
      chatId: 'oc_chat_a',
      chatName: '研发群',
      promptPreview: '写一份周报',
      startedAt: BASE - 30_000,
      elapsedMs: 30_000,
      queueDepth: 2,
      source: 'im',
      status: 'running',
    });
  });

  it('lists a comment run with source=comment and the scope as preview', async () => {
    const activeRuns = new ActiveRuns();
    const pending = new PendingQueue(60_000, () => {});
    activeRuns.register('comment:abc123', fakeRun, BASE - 12_000);

    const online = new Map([['claude', { runsMonitor: createRunsMonitor({ activeRuns, pending }) }]]);
    const views = await listRuns(supervisorWith(online), rootDir, BASE);

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      scope: 'comment:abc123',
      chatId: '',
      promptPreview: 'comment:abc123',
      elapsedMs: 12_000,
      queueDepth: 0,
      source: 'comment',
      status: 'running',
    });
    expect(views[0]?.chatName).toBeUndefined();
  });

  it('derives chatId/threadId from a topic scope when no registry record exists', async () => {
    const activeRuns = new ActiveRuns();
    const pending = new PendingQueue(60_000, () => {});
    activeRuns.register('oc_topic:omt_thread1', fakeRun, BASE - 1_000);

    const online = new Map([['claude', { runsMonitor: createRunsMonitor({ activeRuns, pending }) }]]);
    const views = await listRuns(supervisorWith(online), rootDir, BASE);

    expect(views[0]).toMatchObject({
      chatId: 'oc_topic',
      threadId: 'omt_thread1',
      source: 'im',
    });
  });

  it('reads non-hosted profiles from disk and marks dead or stale owners as orphans', async () => {
    await writeRunsFile('work', [
      diskRecord({ runId: 'live', scope: 'oc_live', chatId: 'oc_live', ownerPid: ALIVE_PID }),
      diskRecord({ runId: 'dead', scope: 'oc_dead', chatId: 'oc_dead', ownerPid: DEAD_PID }),
      diskRecord({
        runId: 'stale',
        scope: 'oc_stale',
        chatId: 'oc_stale',
        ownerPid: ALIVE_PID,
        startedAt: BASE - 25 * 60 * 60 * 1000,
      }),
    ]);

    const views = await listRuns(supervisorWith(new Map()), rootDir, BASE);
    const byScope = Object.fromEntries(views.map((v) => [v.scope, v]));

    expect(views).toHaveLength(3);
    expect(byScope.oc_live).toMatchObject({ profile: 'work', status: 'running', queueDepth: null, source: 'im' });
    expect(byScope.oc_dead).toMatchObject({ status: 'orphan' });
    expect(byScope.oc_stale).toMatchObject({ status: 'orphan' });
  });

  it('ignores the disk file of a hosted profile (memory is authoritative)', async () => {
    // Leftover record on disk for the hosted profile — must not double-report.
    await writeRunsFile('claude', [diskRecord({ runId: 'left', scope: 'oc_left', ownerPid: DEAD_PID })]);
    const activeRuns = new ActiveRuns();
    const pending = new PendingQueue(60_000, () => {});
    activeRuns.register('oc_mem', fakeRun, BASE - 2_000);

    const online = new Map([['claude', { runsMonitor: createRunsMonitor({ activeRuns, pending }) }]]);
    const views = await listRuns(supervisorWith(online), rootDir, BASE);

    expect(views.map((v) => v.scope)).toEqual(['oc_mem']);
  });

  it('merges memory and disk across profiles, oldest first', async () => {
    await writeRunsFile('work', [
      diskRecord({ runId: 'w1', scope: 'oc_w1', chatId: 'oc_w1', startedAt: BASE - 90_000 }),
    ]);
    const activeRuns = new ActiveRuns();
    const pending = new PendingQueue(60_000, () => {});
    activeRuns.register('oc_mem', fakeRun, BASE - 10_000);

    const online = new Map([['claude', { runsMonitor: createRunsMonitor({ activeRuns, pending }) }]]);
    const views = await listRuns(supervisorWith(online), rootDir, BASE);

    expect(views.map((v) => [v.profile, v.scope])).toEqual([
      ['work', 'oc_w1'],
      ['claude', 'oc_mem'],
    ]);
  });
});

describe('stopRun', () => {
  it('interrupts through the same path as the IM /stop command', () => {
    const activeRuns = new ActiveRuns();
    const pending = new PendingQueue(60_000, () => {});
    activeRuns.register('oc_chat_a', fakeRun);
    const online = new Map([['claude', { runsMonitor: createRunsMonitor({ activeRuns, pending }) }]]);

    const res = stopRun(supervisorWith(online), { profile: 'claude', scope: 'oc_chat_a' });
    expect(res).toEqual({ ok: true, interrupted: true });
    expect(activeRuns.get('oc_chat_a')).toBeUndefined();

    // Second stop: nothing left to interrupt.
    expect(stopRun(supervisorWith(online), { profile: 'claude', scope: 'oc_chat_a' })).toEqual({
      ok: false,
      interrupted: false,
    });
  });

  it('rejects a profile this process does not host with a 4xx', () => {
    expect(() => stopRun(supervisorWith(new Map()), { profile: 'work', scope: 'oc_x' })).toThrowError(
      HttpError,
    );
    try {
      stopRun(supervisorWith(new Map()), { profile: 'work', scope: 'oc_x' });
    } catch (err) {
      expect((err as HttpError).status).toBe(409);
    }
  });

  it('rejects missing parameters with 400', () => {
    try {
      stopRun(supervisorWith(new Map()), { profile: 'claude' });
      expect.unreachable();
    } catch (err) {
      expect((err as HttpError).status).toBe(400);
    }
  });
});
