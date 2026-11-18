import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { git, runCapture } from '../git/exec';
import { parsePorcelainV2 } from '../git/status';
import { parseWorktreeList } from '../git/worktree';
import { countChecks } from './pull-requests';

/** Directories scanned for repositories: `LARK_CODING_ROOTS` (`:`-separated), default `~/workspace`. */
export function codingRoots(env = process.env): string[] {
  const raw = env.LARK_CODING_ROOTS?.trim();
  const list = raw ? raw.split(':').map(s => s.trim()).filter(Boolean) : [join(homedir(), 'workspace')];
  return list.map(p => p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
}

/** Main checkouts directly under each root (a `.git` directory, not a linked worktree's `.git` file). */
export async function listRepos(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    let names: string[] = [];
    try { names = (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name); }
    catch { continue; }
    for (const name of names.sort()) {
      const info = await stat(join(root, name, '.git')).catch(() => undefined);
      if (info?.isDirectory()) out.push(join(root, name));
    }
  }
  return out;
}

export interface RepoInfo {
  path: string;
  /** `owner/name` when origin is on GitHub. */
  slug?: string;
  /** Linked worktrees only; the main checkout is never a task. */
  worktrees: Array<{ path: string; branch?: string; head?: string }>;
}

export async function readRepo(path: string): Promise<RepoInfo> {
  const [list, remote] = await Promise.all([
    git(path, ['worktree', 'list', '--porcelain']),
    git(path, ['remote', 'get-url', 'origin']),
  ]);
  const entries = list.ok ? parseWorktreeList(list.stdout) : [];
  const slug = remote.ok ? /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(remote.stdout.trim())?.[1] : undefined;
  return {
    path,
    ...(slug ? { slug } : {}),
    worktrees: entries.filter(e => !e.main).map(e => ({ path: e.path, ...(e.branch ? { branch: e.branch } : {}), ...(e.head ? { head: e.head } : {}) })),
  };
}

export interface WorktreeState { dirty: number; head?: string; branch?: string; lastCommitAt?: number }

/** Two cheap git calls: porcelain status and the HEAD commit time. */
export async function readWorktreeState(path: string): Promise<WorktreeState | undefined> {
  const [status, log] = await Promise.all([
    git(path, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal', '--no-renames']),
    git(path, ['log', '-1', '--format=%ct']),
  ]);
  if (!status.ok) return undefined;
  const parsed = parsePorcelainV2(status.stdout);
  const ts = Number(log.ok ? log.stdout.trim() : NaN);
  return {
    dirty: parsed.dirty.staged + parsed.dirty.unstaged + parsed.dirty.untracked + parsed.dirty.conflicted,
    ...(parsed.head ? { head: parsed.head } : {}),
    ...(parsed.branch ? { branch: parsed.branch } : {}),
    ...(Number.isFinite(ts) && ts > 0 ? { lastCommitAt: ts * 1000 } : {}),
  };
}

export interface RepoPr {
  number: number;
  title: string;
  branch: string;
  state: 'open' | 'closed' | 'merged';
  url?: string;
  review?: string;
  updatedAt?: number;
  checks?: { passed: number; failed: number; pending: number; skipped: number };
}

/** The viewer's recent PRs in one call per repository. */
export async function listRepoPrs(slug: string): Promise<RepoPr[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) return [];
  const result = await runCapture('gh', homedir(), ['pr', 'list', '--repo', slug, '--author', '@me', '--state', 'all', '--limit', '60',
    '--json', 'number,title,headRefName,state,url,reviewDecision,updatedAt,statusCheckRollup'], { timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 });
  if (!result.ok || result.truncated) throw new Error('gh pr list failed');
  const rows = JSON.parse(result.stdout) as Array<{ number: number; title?: string; headRefName?: string; state?: string; url?: string; reviewDecision?: string; updatedAt?: string; statusCheckRollup?: Array<{ status?: string; conclusion?: string; state?: string }> }>;
  return rows.flatMap(r => {
    const state = (r.state ?? '').toLowerCase();
    if (!Number.isSafeInteger(r.number) || !r.headRefName || !['open', 'closed', 'merged'].includes(state)) return [];
    const updated = r.updatedAt ? Date.parse(r.updatedAt) : NaN;
    return [{
      number: r.number, title: r.title ?? '', branch: r.headRefName, state: state as RepoPr['state'],
      ...(r.url?.startsWith('https://github.com/') ? { url: r.url } : {}),
      ...(r.reviewDecision ? { review: r.reviewDecision } : {}),
      ...(Number.isFinite(updated) ? { updatedAt: updated } : {}),
      ...(r.statusCheckRollup?.length ? { checks: countChecks(r.statusCheckRollup) } : {}),
    }];
  });
}

/** Session scope by Claude/Codex session id, across every profile's `sessions.json`. */
export async function readSessionScopes(rootDir: string): Promise<Map<string, { profile: string; scope: string }>> {
  const out = new Map<string, { profile: string; scope: string }>();
  let profiles: string[] = [];
  try { profiles = (await readdir(join(rootDir, 'profiles'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return out; }
  for (const profile of profiles) {
    try {
      const raw = JSON.parse(await readFile(join(rootDir, 'profiles', profile, 'sessions.json'), 'utf8')) as Record<string, { sessionId?: unknown }>;
      for (const [scope, entry] of Object.entries(raw)) if (typeof entry?.sessionId === 'string') out.set(entry.sessionId, { profile, scope });
    } catch { /* missing or malformed store: no links from this profile */ }
  }
  return out;
}

/** First Jira-style key (`ABC-123`) in the given texts. Case-sensitive on purpose: `fix-409` is not a key. */
export function jiraKey(...texts: Array<string | undefined>): string | undefined {
  for (const text of texts) {
    const m = text ? /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)(?![0-9])/.exec(text) : null;
    if (m) return m[1];
  }
  return undefined;
}

export const worktreeName = (path: string) => basename(path);
