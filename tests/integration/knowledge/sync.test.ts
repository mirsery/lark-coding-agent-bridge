import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git, isGitError } from '../../../src/git/exec';
import { KnowledgeStore } from '../../../src/knowledge/store';
import {
  bindKnowledgeRemote,
  knowledgeRemoteUrl,
  knowledgeRepoStatus,
  syncKnowledge,
  unbindKnowledgeRemote,
} from '../../../src/knowledge/sync';

/** Real git against a local bare repository — the sync path is all git plumbing. */

let root: string;
let remote: string;

async function freshStore(name: string): Promise<KnowledgeStore> {
  const store = new KnowledgeStore(join(root, name, 'knowledge'));
  await store.ensure();
  return store;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lcb-knowledge-sync-'));
  remote = join(root, 'remote.git');
  await mkdir(remote, { recursive: true });
  const init = await git(remote, ['init', '--bare', '--initial-branch=main']);
  if (!init.ok) throw new Error(init.stderr);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

describe('knowledge sync', () => {
  it('binds an empty remote, pushes local content, and seeds a second machine', async () => {
    const laptop = await freshStore('laptop');
    await laptop.addMemory({ kind: 'profile' }, '提交信息不要带 AI 署名');
    await mkdir(join(laptop.skillsDir, 'deploy'), { recursive: true });
    await writeFile(
      join(laptop.skillsDir, 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: 发布步骤\n---\n',
    );

    const bound = await bindKnowledgeRemote(laptop, remote);
    expect(isGitError(bound)).toBe(false);
    expect(await knowledgeRemoteUrl(laptop)).toBe(remote);

    const synced = await syncKnowledge(laptop);
    if (isGitError(synced)) throw new Error(synced.error);
    expect(synced.pushed).toBe(true);

    // A second profile / machine binding the same remote gets everything.
    const desktop = await freshStore('desktop');
    const boundDesktop = await bindKnowledgeRemote(desktop, remote);
    expect(isGitError(boundDesktop)).toBe(false);
    expect(await desktop.listMemories({ kind: 'profile' })).toMatchObject([
      { text: '提交信息不要带 AI 署名' },
    ]);
    expect(await desktop.listSkills()).toMatchObject([{ name: 'deploy', description: '发布步骤' }]);
  });

  it('merges content that already existed on both sides', async () => {
    const laptop = await freshStore('laptop');
    await laptop.addMemory({ kind: 'profile' }, '来自笔记本');
    expect(isGitError(await bindKnowledgeRemote(laptop, remote))).toBe(false);
    expect(isGitError(await syncKnowledge(laptop))).toBe(false);

    const desktop = await freshStore('desktop');
    // Local notes written before binding must survive the merge.
    await desktop.addMemory({ kind: 'chat', scopeId: 'oc_desktop' }, '来自台式机');
    expect(isGitError(await bindKnowledgeRemote(desktop, remote))).toBe(false);

    expect(await desktop.listMemories({ kind: 'profile' })).toMatchObject([{ text: '来自笔记本' }]);
    expect(await desktop.listMemories({ kind: 'chat', scopeId: 'oc_desktop' })).toMatchObject([
      { text: '来自台式机' },
    ]);
  });

  it('round-trips an edit made on the other machine', async () => {
    const laptop = await freshStore('laptop');
    await bindKnowledgeRemote(laptop, remote);
    await syncKnowledge(laptop);

    const desktop = await freshStore('desktop');
    await bindKnowledgeRemote(desktop, remote);
    await desktop.addMemory({ kind: 'profile' }, '台式机加的规则');
    expect(isGitError(await syncKnowledge(desktop))).toBe(false);

    expect(await laptop.listMemories({ kind: 'profile' })).toHaveLength(0);
    const pulled = await syncKnowledge(laptop);
    if (isGitError(pulled)) throw new Error(pulled.error);
    expect(pulled.pulled).toBe(true);
    expect(await laptop.listMemories({ kind: 'profile' })).toMatchObject([
      { text: '台式机加的规则' },
    ]);
  });

  it('commits locally and says so when there is no remote', async () => {
    const store = await freshStore('solo');
    const init = await git(store.dir, ['init', '--initial-branch=main']);
    expect(init.ok).toBe(true);
    await store.addMemory({ kind: 'profile' }, '只在本地');

    const result = await syncKnowledge(store);
    if (isGitError(result)) throw new Error(result.error);
    expect(result).toMatchObject({ pushed: false, pulled: false });
    expect(result.committed).toBeGreaterThan(0);
    expect(result.note).toContain('没有配置远端');
  });

  it('refuses to sync a directory that was never bound', async () => {
    const store = await freshStore('unbound');
    expect(await syncKnowledge(store)).toMatchObject({ error: expect.stringContaining('bind') });
  });

  it('rejects an unreachable remote instead of half-binding', async () => {
    const store = await freshStore('bad');
    const result = await bindKnowledgeRemote(store, join(root, 'does-not-exist.git'));
    expect(isGitError(result)).toBe(true);
  });

  it('unbinds without losing local content', async () => {
    const store = await freshStore('laptop');
    await store.addMemory({ kind: 'profile' }, '保留我');
    await bindKnowledgeRemote(store, remote);

    expect(isGitError(await unbindKnowledgeRemote(store))).toBe(false);
    expect(await knowledgeRemoteUrl(store)).toBeUndefined();
    expect(await store.listMemories({ kind: 'profile' })).toMatchObject([{ text: '保留我' }]);
    // Still a repository, so history is intact.
    expect(await knowledgeRepoStatus(store)).toBeDefined();
  });
});
