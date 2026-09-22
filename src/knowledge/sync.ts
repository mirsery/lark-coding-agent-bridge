import { git, isGitError } from '../git/exec';
import { readRepoStatus, type GitRepoStatus } from '../git/status';
import { log } from '../core/logger';
import type { KnowledgeStore } from './store';

/**
 * Git synchronisation for the knowledge directory.
 *
 * The directory is an ordinary git repository, so "sync between machines and
 * profiles" is just commit + pull --rebase + push. Nothing here invents a
 * protocol: the point is that the same content can be reviewed as a diff and
 * edited outside the bridge.
 */

export interface SyncOutcome {
  committed: number;
  pulled: boolean;
  pushed: boolean;
  /** Non-fatal explanation, e.g. "no remote configured". */
  note?: string;
}

const SYNC_TIMEOUT_MS = 60_000;

export async function knowledgeRepoStatus(
  store: KnowledgeStore,
): Promise<GitRepoStatus | undefined> {
  return readRepoStatus(store.dir).catch(() => undefined);
}

export async function knowledgeRemoteUrl(store: KnowledgeStore): Promise<string | undefined> {
  const result = await git(store.dir, ['remote', 'get-url', 'origin']);
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

/**
 * Point the knowledge directory at a remote, creating the repository if needed
 * and taking whatever is already on the remote.
 *
 * Existing local content is preserved: the remote history is merged in with
 * `--allow-unrelated-histories`, because "I already wrote notes here and now I
 * want them on my other machine too" is the normal way into this feature.
 */
export async function bindKnowledgeRemote(
  store: KnowledgeStore,
  url: string,
): Promise<{ ok: true; note?: string } | { error: string }> {
  if (!isPlausibleGitUrl(url)) return { error: `看起来不像 git 仓库地址：${url}` };
  await store.ensure();

  const existing = await readRepoStatus(store.dir).catch(() => undefined);
  if (!existing) {
    const init = await git(store.dir, ['init', '--initial-branch=main']);
    if (!init.ok) return { error: init.stderr || 'git init 失败' };
  }

  const setUrl = await git(store.dir, ['remote', 'set-url', 'origin', url]);
  if (!setUrl.ok) {
    const add = await git(store.dir, ['remote', 'add', 'origin', url]);
    if (!add.ok) return { error: add.stderr || '设置 origin 失败' };
  }

  await commitAll(store, 'knowledge: bind remote');
  const fetch = await git(store.dir, ['fetch', 'origin'], { timeoutMs: SYNC_TIMEOUT_MS });
  if (!fetch.ok) {
    return { error: `连不上远端：${fetch.stderr || 'git fetch 失败'}` };
  }

  const remoteBranch = await defaultRemoteBranch(store);
  if (!remoteBranch) {
    // Empty remote: nothing to merge, the first push will seed it.
    return { ok: true, note: '远端还是空的，下次 sync 会把本地内容推上去。' };
  }
  const merge = await git(
    store.dir,
    ['merge', '--allow-unrelated-histories', '--no-edit', `origin/${remoteBranch}`],
    { timeoutMs: SYNC_TIMEOUT_MS },
  );
  if (!merge.ok) {
    return { error: `合并远端内容失败（可能有冲突，需要在 ${store.dir} 手动处理）：${merge.stderr}` };
  }
  return { ok: true };
}

export async function unbindKnowledgeRemote(
  store: KnowledgeStore,
): Promise<{ ok: true } | { error: string }> {
  const result = await git(store.dir, ['remote', 'remove', 'origin']);
  if (!result.ok) return { error: result.stderr || '没有配置 origin' };
  return { ok: true };
}

/** Commit local edits, take the remote's, then publish. */
export async function syncKnowledge(
  store: KnowledgeStore,
): Promise<SyncOutcome | { error: string }> {
  const status = await readRepoStatus(store.dir).catch(() => undefined);
  if (!status) return { error: '知识目录还不是 git 仓库，先用 `/knowledge bind <仓库地址>`。' };

  const committed = await commitAll(store, `knowledge: sync ${new Date().toISOString()}`);
  const remote = await knowledgeRemoteUrl(store);
  if (!remote) {
    return { committed, pulled: false, pushed: false, note: '没有配置远端，只做了本地提交。' };
  }

  const branch = status.branch ?? 'main';
  // A remote that does not have this branch yet (freshly created repo) has
  // nothing to pull; asking anyway fails with "couldn't find remote ref".
  const remoteHasBranch = await hasRemoteBranch(store, branch);
  if (remoteHasBranch) {
    const pull = await git(store.dir, ['pull', '--rebase', 'origin', branch], {
      timeoutMs: SYNC_TIMEOUT_MS,
    });
    if (!pull.ok) {
      // A rebase that stopped halfway leaves the directory mid-operation; say
      // so rather than pushing a half-merged state.
      await git(store.dir, ['rebase', '--abort']);
      return { error: `拉取失败（已回滚）：${pull.stderr || 'git pull 失败'}` };
    }
  }

  // `-u` so the branch gets an upstream on the very first push, which is what
  // makes `/knowledge` able to show ↑/↓ afterwards.
  const push = await git(store.dir, ['push', '-u', 'origin', branch], { timeoutMs: SYNC_TIMEOUT_MS });
  if (!push.ok) return { error: `推送失败：${push.stderr || 'git push 失败'}` };

  log.info('knowledge', 'synced', { committed, branch, pulled: remoteHasBranch });
  return { committed, pulled: remoteHasBranch, pushed: true };
}

/** Stage and commit everything; returns the number of files in the commit. */
async function commitAll(store: KnowledgeStore, message: string): Promise<number> {
  const add = await git(store.dir, ['add', '-A']);
  if (!add.ok) return 0;
  const staged = await git(store.dir, ['diff', '--cached', '--name-only']);
  const count = staged.ok ? staged.stdout.split('\n').filter(Boolean).length : 0;
  if (count === 0) return 0;

  // A knowledge repo is bridge-owned; identity is set locally so it works on a
  // machine with no global git identity at all.
  await git(store.dir, ['config', 'user.name', 'lark-channel-bridge']);
  await git(store.dir, ['config', 'user.email', 'bridge@localhost']);
  const commit = await git(store.dir, ['commit', '-m', message]);
  return commit.ok ? count : 0;
}

async function hasRemoteBranch(store: KnowledgeStore, branch: string): Promise<boolean> {
  const heads = await git(store.dir, ['ls-remote', '--heads', 'origin', branch], {
    timeoutMs: SYNC_TIMEOUT_MS,
  });
  return heads.ok && heads.stdout.trim().length > 0;
}

async function defaultRemoteBranch(store: KnowledgeStore): Promise<string | undefined> {
  const heads = await git(store.dir, ['ls-remote', '--heads', 'origin'], {
    timeoutMs: SYNC_TIMEOUT_MS,
  });
  if (!heads.ok || !heads.stdout.trim()) return undefined;
  const names = heads.stdout
    .split('\n')
    .map((line) => line.split('refs/heads/')[1]?.trim())
    .filter((name): name is string => Boolean(name));
  return names.includes('main') ? 'main' : names[0];
}

export function isPlausibleGitUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.startsWith('-')) return false;
  return (
    /^https?:\/\/\S+$/.test(trimmed) ||
    /^git@[^:]+:\S+$/.test(trimmed) ||
    /^ssh:\/\/\S+$/.test(trimmed) ||
    trimmed.startsWith('/')
  );
}

export { isGitError };
