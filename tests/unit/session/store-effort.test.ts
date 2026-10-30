import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../../src/session/store';

describe('SessionStore effort override', () => {
  const dirs: string[] = [];
  const stores: SessionStore[] = [];
  const fresh = (): { store: SessionStore; path: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-effort-'));
    dirs.push(dir);
    const path = join(dir, 'sessions.json');
    const store = new SessionStore(path);
    stores.push(store);
    return { store, path };
  };
  afterEach(async () => {
    // Let queued persists land before their directory goes away.
    await Promise.all(stores.splice(0).map((store) => store.flush()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the override across turns of the same conversation', () => {
    const { store } = fresh();
    store.setEffort('oc_a', 'xhigh');
    store.set('oc_a', 'sess-1', '/w');
    store.set('oc_a', 'sess-1', '/w');
    expect(store.getEffort('oc_a')).toBe('xhigh');
    expect(store.resumeFor('oc_a', '/w')).toBe('sess-1');
  });

  it('drops the override when the conversation is cleared, keeping the idle-timeout override', () => {
    const { store } = fresh();
    store.set('oc_a', 'sess-1', '/w');
    store.setIdleTimeoutMinutes('oc_a', 15);
    store.setEffort('oc_a', 'max');
    store.clear('oc_a');
    expect(store.getEffort('oc_a')).toBeUndefined();
    expect(store.getIdleTimeoutMinutes('oc_a')).toBe(15);
  });

  it('clearEffort reports whether something was removed and keeps the session', () => {
    const { store } = fresh();
    expect(store.clearEffort('oc_a')).toBe(false);
    store.set('oc_a', 'sess-1', '/w');
    store.setEffort('oc_a', 'low');
    expect(store.clearEffort('oc_a')).toBe(true);
    expect(store.getEffort('oc_a')).toBeUndefined();
    expect(store.resumeFor('oc_a', '/w')).toBe('sess-1');
  });

  it('persists an override set before any run, and ignores unknown levels on load', async () => {
    const { store, path } = fresh();
    store.setEffort('oc_a', 'xhigh');
    store.setEffort('oc_b', 'low');
    await store.flush();
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { effort?: string }>;
    expect(raw.oc_a?.effort).toBe('xhigh');

    const reloaded = new SessionStore(path);
    await reloaded.load();
    expect(reloaded.getEffort('oc_a')).toBe('xhigh');

    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, JSON.stringify({ oc_c: { effort: 'turbo', updatedAt: 1 } }));
    const bad = new SessionStore(path);
    await bad.load();
    expect(bad.getEffort('oc_c')).toBeUndefined();
  });
});
