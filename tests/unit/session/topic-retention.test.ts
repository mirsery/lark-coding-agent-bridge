import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ChatContextCursorStore } from '../../../src/bot/chat-context';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { SessionCatalog } from '../../../src/session/catalog';
import { PendingRotationStore } from '../../../src/session/rotation-store';
import { SessionStore } from '../../../src/session/store';
import {
  expireTopicSessions,
  startTopicSessionRetention,
  topicSessionExpiresAt,
} from '../../../src/session/topic-retention';

const roots: string[] = [];
const flushes: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(flushes.splice(0).map((flush) => flush()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('topic session retention', () => {
  it('expires on the calendar-month boundary and clears bridge session metadata', async () => {
    const h = await harness();
    const scope = 'oc_chat:omt_topic';
    const lastActivity = Date.UTC(2024, 0, 31, 12, 30);
    const boundary = Date.UTC(2024, 1, 29, 12, 30);
    h.sessions.set(scope, 'session-1', '/repo', lastActivity);
    h.catalog.upsertActive({
      scopeId: scope,
      agentId: 'claude',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp',
      sessionId: 'session-1',
      now: lastActivity,
    });
    h.rotations.set(scope, { summary: 'done', handle: 'session-1' }, lastActivity);
    h.cursors.advance(scope, lastActivity);

    expect(topicSessionExpiresAt(lastActivity, 1)).toBe(boundary);
    await expect(h.expire(1, boundary - 1)).resolves.toEqual([]);
    await expect(h.expire(1, boundary)).resolves.toEqual([scope]);

    expect(h.sessions.getRaw(scope)).toBeUndefined();
    expect(h.catalog.entries().filter((entry) => entry.scopeId === scope)).toEqual([]);
    expect(h.rotations.get(scope)).toBeUndefined();
    expect(h.cursors.get(scope)).toBeUndefined();
  });

  it('treats zero as never and never expires non-topic scopes', async () => {
    const h = await harness();
    const old = Date.UTC(2020, 0, 1);
    for (const scope of ['oc_chat:omt_topic', 'oc_chat', 'cron:job', 'comment:doc']) {
      h.sessions.set(scope, `session-${scope}`, '/repo', old);
    }

    await expect(h.expire(0, Date.UTC(2026, 0, 1))).resolves.toEqual([]);
    await expect(h.expire(1, Date.UTC(2026, 0, 1))).resolves.toEqual(['oc_chat:omt_topic']);
    expect(h.sessions.getRaw('oc_chat')).toBeDefined();
    expect(h.sessions.getRaw('cron:job')).toBeDefined();
    expect(h.sessions.getRaw('comment:doc')).toBeDefined();
  });

  it('fails closed when a huge configured month count is outside Date range', async () => {
    const h = await harness();
    const scope = 'oc_chat:omt_topic';
    h.sessions.set(scope, 'session-1', '/repo', Date.UTC(2020, 0, 1));
    await expect(h.expire(Number.MAX_SAFE_INTEGER, Date.UTC(2026, 0, 1))).resolves.toEqual([]);
    expect(h.sessions.getRaw(scope)).toBeDefined();
  });

  it('uses the latest accepted turn instead of only the original session event', async () => {
    const h = await harness();
    const scope = 'oc_chat:omt_topic';
    const created = Date.UTC(2024, 0, 1);
    const reused = Date.UTC(2024, 2, 15);
    h.sessions.set(scope, 'session-1', '/repo', created);
    h.catalog.upsertActive({
      scopeId: scope,
      agentId: 'claude',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp',
      sessionId: 'session-1',
      now: created,
    });
    expect(h.sessions.touch(scope, reused)).toBe(true);
    expect(h.catalog.touchScope(scope, reused)).toBe(true);

    await expect(h.expire(1, Date.UTC(2024, 3, 1))).resolves.toEqual([]);
    await expect(h.expire(1, Date.UTC(2024, 3, 15))).resolves.toEqual([scope]);
  });

  it('protects active, run-preparation, queued and lingering topic scopes', async () => {
    const h = await harness();
    const activeRuns = new ActiveRuns();
    const pending = new PendingQueue(60_000, () => {});
    const run = fakeRun();
    activeRuns.register('oc_chat:omt_active', run);
    activeRuns.reserve('oc_chat:omt_preparing');
    activeRuns.setLingering('oc_chat:omt_lingering', fakeRun(), 'idle');
    pending.push('oc_chat:omt_queued', message());
    const old = Date.UTC(2020, 0, 1);
    for (const suffix of ['active', 'preparing', 'lingering', 'queued', 'expired']) {
      h.sessions.set(`oc_chat:omt_${suffix}`, `session-${suffix}`, '/repo', old);
    }

    await expect(
      h.expire(1, Date.UTC(2026, 0, 1), (scope) => activeRuns.hasScope(scope) || pending.depth(scope) > 0),
    ).resolves.toEqual(['oc_chat:omt_expired']);
    for (const suffix of ['active', 'preparing', 'lingering', 'queued']) {
      expect(h.sessions.getRaw(`oc_chat:omt_${suffix}`)).toBeDefined();
    }
    pending.stop();
  });

  it('reads runtime retention changes on each scheduled pass and stops cleanly', async () => {
    vi.useFakeTimers();
    const h = await harness();
    const scope = 'oc_chat:omt_topic';
    const now = Date.UTC(2026, 0, 1);
    h.sessions.set(scope, 'session-1', '/repo', Date.UTC(2020, 0, 1));
    let months = 0;
    const retention = startTopicSessionRetention({
      sessions: h.sessions,
      sessionCatalog: h.catalog,
      pendingRotations: h.rotations,
      contextCursors: h.cursors,
      retentionMonths: () => months,
      isProtected: () => false,
      now: () => now,
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sessions.getRaw(scope)).toBeDefined();
    months = 1;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sessions.getRaw(scope)).toBeUndefined();
    await retention.stop();
    h.sessions.set(scope, 'session-2', '/repo', Date.UTC(2020, 0, 1));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sessions.getRaw(scope)).toBeDefined();
  });
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'topic-retention-'));
  roots.push(root);
  const sessions = new SessionStore(join(root, 'sessions.json'));
  const catalog = new SessionCatalog(join(root, 'catalog.json'));
  const rotations = new PendingRotationStore(join(root, 'rotations.json'));
  const cursors = new ChatContextCursorStore(join(root, 'cursors.json'));
  flushes.push(() => Promise.all([
    sessions.flush(),
    catalog.flush(),
    rotations.flush(),
    cursors.flush(),
  ]).then(() => undefined));
  return {
    sessions,
    catalog,
    rotations,
    cursors,
    expire: (
      retentionMonths: number,
      now: number,
      isProtected: (scope: string) => boolean = () => false,
    ) =>
      expireTopicSessions({
        sessions,
        sessionCatalog: catalog,
        pendingRotations: rotations,
        contextCursors: cursors,
        retentionMonths,
        isProtected,
        now,
      }),
  };
}

function fakeRun() {
  return {
    runId: `run-${Math.random()}`,
    events: (async function* () {})(),
    stop: async () => {},
    waitForExit: async () => true,
  };
}

function message(): NormalizedMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: 'ou_user',
    senderType: 'user',
    content: 'queued',
    messageType: 'text',
    createTime: String(Date.now()),
  } as unknown as NormalizedMessage;
}
