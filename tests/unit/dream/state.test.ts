import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DreamStateStore, type DreamRun } from '../../../src/dream/state.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function file(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dream-state-'));
  dirs.push(dir);
  return join(dir, 'dream-state.json');
}

function run(id: string, status: DreamRun['status']): DreamRun {
  return { id, status, actorId: 'ou_a', startedAt: 1, sessions: 0, scopes: 0, exchanges: 0, memoryItems: 0, skillItems: 0, rejected: 0, deferred: [], targets: [] };
}

describe('DreamStateStore', () => {
  it('persists sessions, cursors, runs and published hashes with 0600', async () => {
    const path = await file();
    const store = new DreamStateStore(path);
    await store.load();
    store.noteSession({ agentId: 'claude', handle: 'h1', scopeId: 'oc_1', cwd: '/w', at: 10 });
    store.noteSession({ agentId: 'claude', handle: 'h1', scopeId: 'oc_1', cwd: '/w', at: 20 });
    store.advance('claude:h1', 3, 'abc', 30);
    store.addRun(run('r1', 'running'));
    store.saveTarget('r1', { repo: 'knowledge', label: '知识库', branch: 'dream/r1', phase: 'committed', items: 2 });
    store.saveTarget('r1', { repo: 'knowledge', label: '知识库', branch: 'dream/r1', phase: 'pr-created', items: 2, prUrl: 'u' });
    store.markPublished(['x', 'x', 'y']);
    await store.flush();

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const again = new DreamStateStore(path);
    await again.load(99, { readOnly: true });
    expect(again.session('claude:h1')).toMatchObject({ firstSeenAt: 10, lastSeenAt: 20, consumed: 3, consumedHash: 'abc', consumedAt: 30 });
    expect(again.run('r1')).toMatchObject({ status: 'running', targets: [{ phase: 'pr-created', prUrl: 'u' }] });
    expect(again.isPublished('y')).toBe(true);
  });

  it('closes a run cut off by a restart as failed, unless loaded read-only', async () => {
    const path = await file();
    const store = new DreamStateStore(path);
    await store.load();
    store.addRun(run('r1', 'running'));
    store.addRun(run('r2', 'succeeded'));
    await store.flush();

    const viewer = new DreamStateStore(path);
    await viewer.load(50, { readOnly: true });
    await viewer.flush();
    expect(JSON.parse(await readFile(path, 'utf8')).runs[0].status).toBe('running');

    const restarted = new DreamStateStore(path);
    await restarted.load(50);
    await restarted.flush();
    expect(restarted.run('r1')).toMatchObject({ status: 'failed', endedAt: 50 });
    expect(restarted.run('r2')?.status).toBe('succeeded');
    expect(JSON.parse(await readFile(path, 'utf8')).runs[0].status).toBe('failed');
  });

  it('drops malformed records and survives a corrupt file', async () => {
    const path = await file();
    await writeFile(path, JSON.stringify({
      sessions: {
        'claude:ok': { agentId: 'claude', handle: 'ok', scopeId: 'oc', consumed: 2 },
        'claude:wrong-key': { agentId: 'claude', handle: 'other', scopeId: 'oc' },
        'nope:x': { agentId: 'nope', handle: 'x', scopeId: 'oc' },
      },
      runs: [{ id: 'bad' }],
    }));
    const store = new DreamStateStore(path);
    await store.load();
    expect(store.sessions().map((s) => s.key)).toEqual(['claude:ok']);
    expect(store.runs()).toEqual([]);

    await writeFile(path, '{not json');
    const corrupt = new DreamStateStore(path);
    await corrupt.load();
    expect(corrupt.sessions()).toEqual([]);
  });
});
