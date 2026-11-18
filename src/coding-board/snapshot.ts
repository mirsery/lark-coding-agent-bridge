import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { MonitorBot } from '../terminal/snapshot';
import { readBuildQueue } from './build-queue';
import { createRefresher } from './cache';
import { readBuildJobs, tailLog, type BuildJob } from './jobs';
import { codingRoots, jiraKey, readConfiguredRoots, listRepoPrs, listRepos, readRepo, readSessionScopes, readWorktreeState, type RepoInfo, type RepoPr, type WorktreeState } from './sources';
import { readTasks, type CodingTask } from './store';

/**
 * Coding task board, discovered rather than registered: linked git worktrees
 * under the coding roots, build-queue jobs run in them, the viewer's PRs on
 * those branches, and the bridge sessions that started the builds. The
 * manual registry (`coding-board add/link`) only overrides titles, groups
 * extra worktrees under a task, or hides one (`--archive`).
 */
export const PHASES = ['构建中', '构建排队', '门禁失败', 'CI 失败', '编码中', 'CI 中', '待合并', '等 review', '门禁通过', '闲置', '已关闭', '已合并'] as const;
export type Phase = typeof PHASES[number];
const DONE: ReadonlySet<Phase> = new Set(['已合并', '已关闭']);

export interface BoardJob {
  id: string; label: string; cmd: string; startedAt: number;
  state: 'running' | 'waiting' | 'passed' | 'failed' | 'interrupted';
  exitCode?: number; position?: number; logTail?: string[];
}
export interface BoardSession {
  profile: string; scope: string; chatId: string; threadId?: string; chatName?: string; chatType?: string;
  running: boolean; startedAt?: number; ledger?: string;
  /** Feishu / Lark applink that opens the chat, when the profile's tenant is known. */
  chatUrl?: string;
}
export interface BoardWorktree {
  path: string; name: string; repo: string; branch?: string;
  /** No local worktree any more; only the open PR remains. */
  cleaned?: boolean;
  dirty?: number; lastCommitAt?: number; phase: Phase;
  jobs: BoardJob[]; pr?: RepoPr; sessions: BoardSession[]; activityAt?: number;
}
export interface CodingBoardTask {
  key: string; jira?: string; title: string; repo: string; phase: Phase; activityAt?: number;
  worktrees: BoardWorktree[]; ledger?: string; nextStep?: string;
}
export interface BoardQueueEntry { name: string; path: string; state: 'running' | 'waiting'; position?: number; cmd?: string; startedAt?: number; label?: string }
export interface CodingBoardSnapshot {
  observedAt: number;
  tasks: CodingBoardTask[];
  /** Every worktree merged or closed but still on disk: candidates for `worktree-clean`. */
  merged: Array<{ key: string; title: string; worktrees: string[] }>;
  queue: BoardQueueEntry[];
  counts: Partial<Record<Phase, number>>;
  /** Worktrees hidden as idle: no PR, no build, no running session, nothing uncommitted. */
  idle: number;
  /** Repositories still being scanned for the first time. */
  loading?: boolean;
  error?: string;
}

const expand = (p: string) => p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;

export function jobState(job: BuildJob, queue: { running?: string; waiting: Map<string, number> }): BoardJob['state'] {
  if (job.exitCode !== undefined) return job.exitCode === 0 ? 'passed' : 'failed';
  if (job.interrupted) return 'interrupted';
  return queue.running === job.cwd ? 'running' : 'waiting';
}

/** One worktree's phase from observed facts only; a merged PR is not "done" while a build still runs. */
export function worktreePhase(w: Pick<BoardWorktree, 'jobs' | 'pr' | 'sessions' | 'dirty'>): Phase {
  const latest = w.jobs.at(-1);
  if (w.jobs.some(j => j.state === 'running')) return '构建中';
  if (w.jobs.some(j => j.state === 'waiting')) return '构建排队';
  const busy = w.sessions.some(s => s.running) || (w.dirty ?? 0) > 0;
  if (w.pr?.state === 'merged') return busy ? '编码中' : '已合并';
  if (w.pr?.state === 'closed') return busy ? '编码中' : '已关闭';
  if (latest && (latest.state === 'failed' || latest.state === 'interrupted') && (!w.pr || latest.startedAt >= (w.pr.updatedAt ?? 0))) return '门禁失败';
  if (w.pr?.state === 'open') {
    if ((w.pr.checks?.failed ?? 0) > 0) return 'CI 失败';
    if ((w.pr.checks?.pending ?? 0) > 0) return 'CI 中';
    return w.pr.review === 'APPROVED' ? '待合并' : '等 review';
  }
  if (busy) return '编码中';
  if (latest?.state === 'passed') return '门禁通过';
  return '闲置';
}

const rank = (p: Phase) => PHASES.indexOf(p);

async function ledgerInfo(path: string): Promise<{ title?: string; nextStep?: string }> {
  try {
    const text = await readFile(expand(path), 'utf8');
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    const next = /^##\s*下一步\s*\n+([\s\S]*?)(?:\n##\s|$)/m.exec(text)?.[1]?.split('\n').map(l => l.replace(/^[-*\d.\s]+/, '').trim()).find(Boolean);
    return { ...(title ? { title } : {}), ...(next ? { nextStep: next.slice(0, 160) } : {}) };
  } catch { return {}; }
}

export interface CodingBoardReaderOptions {
  roots?: string[];
  listRepos?: (roots: string[]) => Promise<string[]>;
  readRepo?: (path: string) => Promise<RepoInfo>;
  readWorktree?: (path: string) => Promise<WorktreeState | undefined>;
  listPrs?: (slug: string) => Promise<RepoPr[]>;
  readJobs?: (now: number) => Promise<BuildJob[]>;
  readQueue?: (now: number) => ReturnType<typeof readBuildQueue>;
}

export function createCodingBoardReader(opts: CodingBoardReaderOptions = {}) {
  // Saved roots are re-read with each repository scan, so `coding-board roots` applies without a restart.
  const repos = createRefresher(async (rootDir: string) => (opts.listRepos ?? listRepos)(opts.roots ?? codingRoots(process.env, await readConfiguredRoots(rootDir))), 60_000, 1);
  const repoInfo = createRefresher(path => (opts.readRepo ?? readRepo)(path), 30_000);
  const trees = createRefresher(path => (opts.readWorktree ?? readWorktreeState)(path), 10_000);
  const prs = createRefresher(slug => (opts.listPrs ?? listRepoPrs)(slug), 60_000, 2);
  const readJobs = opts.readJobs ?? ((now: number) => readBuildJobs(now));
  const readQueue = opts.readQueue ?? ((now: number) => readBuildQueue(now));

  const read = async (rootDir: string, now = Date.now(), bots: MonitorBot[] = [], tenants: Record<string, string | undefined> = {}): Promise<CodingBoardSnapshot> => {
    let registry: CodingTask[] = [];
    let error: string | undefined;
    try { registry = await readTasks(join(rootDir, 'coding-board', 'tasks.json')); }
    catch { error = '任务登记文件无法读取，已忽略手工登记'; }

    const [jobs, queueSnap, scopes] = await Promise.all([readJobs(now), readQueue(now), readSessionScopes(rootDir)]);
    const running = queueSnap.entries.find(e => e.state === 'running')?.path;
    const waiting = new Map(queueSnap.entries.filter(e => e.state === 'waiting').map(e => [e.path, e.position ?? 0]));
    const repoList = repos.get(rootDir, now);
    const infos = (repoList ?? []).map(p => repoInfo.get(p, now)).filter((r): r is RepoInfo => Boolean(r));
    const loading = !repoList || infos.length < (repoList?.length ?? 0);

    // Running bridge runs by scope, plus every known scope's chat metadata.
    const runs = new Map<string, { profile: string; run: MonitorBot['runs'][number] }>();
    for (const bot of bots) for (const run of bot.runs) if (!run.orphan) runs.set(run.scope, { profile: bot.profile, run });
    const session = (profile: string, scope: string): BoardSession => {
      const live = runs.get(scope);
      const [chatId, threadId] = scope.split(':');
      const host = tenants[profile] === 'lark' ? 'applink.larksuite.com' : tenants[profile] === 'feishu' ? 'applink.feishu.cn' : undefined;
      const chatUrl = host && chatId?.startsWith('oc_') ? `https://${host}/client/chat/open?openChatId=${encodeURIComponent(chatId)}` : undefined;
      return {
        ...(chatUrl ? { chatUrl } : {}),
        profile, scope, chatId: chatId ?? scope, ...(threadId ? { threadId } : {}), running: Boolean(live),
        ...(live?.run.chatName ? { chatName: live.run.chatName } : {}), ...(live?.run.chatType ? { chatType: live.run.chatType } : {}),
        ...(live ? { startedAt: live.run.startedAt } : {}), ...(live?.run.ledger ? { ledger: live.run.ledger } : {}),
      };
    };

    const hidden = new Set(registry.filter(t => t.archived).flatMap(t => [t.jira, ...t.worktrees].filter((x): x is string => Boolean(x))));
    const forced = new Map<string, CodingTask>();
    for (const t of registry.filter(t => !t.archived)) for (const w of t.worktrees) forced.set(w, t);
    const titles = new Map(registry.filter(t => !t.archived && t.jira).map(t => [t.jira!, t.title]));

    const groups = new Map<string, { jira?: string; repo: string; worktrees: BoardWorktree[]; title?: string }>();
    let idle = 0;
    for (const info of infos) {
      const repoName = basename(info.path);
      const repoPrs = info.slug && info.worktrees.length ? prs.get(info.slug, now) ?? [] : [];
      const branches = new Set<string>();
      for (const wt of info.worktrees) {
        if (hidden.has(wt.path)) continue;
        const state = trees.get(wt.path, now);
        const branch = state?.branch ?? wt.branch;
        if (branch) branches.add(branch);
        const pr = branch ? repoPrs.filter(p => p.branch === branch).sort((a, b) => b.number - a.number)[0] : undefined;
        const own = jobs.filter(j => j.cwd === wt.path);
        const boardJobs = own.slice(-5).map((j): BoardJob => {
          const s = jobState(j, { running, waiting });
          return { id: j.id, label: j.label, cmd: j.cmd, startedAt: j.startedAt, state: s,
            ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}), ...(s === 'waiting' && waiting.has(j.cwd) ? { position: waiting.get(j.cwd) } : {}) };
        });
        const sessionKeys = new Map<string, BoardSession>();
        for (const j of own) { const s = j.session ? scopes.get(j.session) : undefined; if (s) sessionKeys.set(s.scope, session(s.profile, s.scope)); }
        const worktree: BoardWorktree = {
          path: wt.path, name: basename(wt.path), repo: repoName, ...(branch ? { branch } : {}),
          ...(state ? { dirty: state.dirty } : {}), ...(state?.lastCommitAt ? { lastCommitAt: state.lastCommitAt } : {}),
          jobs: boardJobs, ...(pr ? { pr } : {}), sessions: [...sessionKeys.values()], phase: '闲置',
        };
        const forcedTask = forced.get(wt.path);
        const jira = forcedTask?.jira ?? jiraKey(branch, basename(wt.path));
        const key = jira ?? (forcedTask ? forcedTask.id : `${repoName}/${basename(wt.path)}`);
        if (jira && hidden.has(jira)) continue;
        const g = groups.get(key) ?? { ...(jira ? { jira } : {}), repo: repoName, worktrees: [], ...(forcedTask ? { title: forcedTask.title } : {}) };
        g.worktrees.push(worktree);
        groups.set(key, g);
      }
      // Open PRs whose worktree is already gone still need attention.
      for (const pr of repoPrs.filter(p => p.state === 'open' && !branches.has(p.branch))) {
        const jira = jiraKey(pr.branch, pr.title);
        if (jira && hidden.has(jira)) continue;
        const key = jira ?? `${repoName}#${pr.number}`;
        const g = groups.get(key) ?? { ...(jira ? { jira } : {}), repo: repoName, worktrees: [] };
        g.worktrees.push({ path: '', name: '(worktree 已清理)', repo: repoName, branch: pr.branch, cleaned: true, jobs: [], pr, sessions: [], phase: '等 review' });
        groups.set(key, g);
      }
    }

    // Runs that announced a ledger naming the task key join it even before the first build.
    for (const [scope, { profile, run }] of runs) {
      const jira = jiraKey(run.ledger ? basename(run.ledger) : undefined);
      const g = jira ? groups.get(jira) : undefined;
      if (!g) continue;
      const target = g.worktrees.find(w => !w.cleaned && !w.sessions.length) ?? g.worktrees[0];
      if (target && !g.worktrees.some(w => w.sessions.some(s => s.scope === scope))) target.sessions.push(session(profile, scope));
    }

    const tasks: CodingBoardTask[] = [];
    const merged: CodingBoardSnapshot['merged'] = [];
    for (const [key, g] of groups) {
      for (const w of g.worktrees) {
        w.phase = w.cleaned ? worktreePhase({ ...w, jobs: [], sessions: [] }) : worktreePhase(w);
        const times = [w.lastCommitAt, w.pr?.updatedAt, ...w.jobs.map(j => j.startedAt), ...w.sessions.map(s => s.startedAt)].filter((t): t is number => typeof t === 'number');
        if (times.length) w.activityAt = Math.max(...times);
      }
      const visible = g.worktrees.filter(w => w.phase !== '闲置');
      idle += g.worktrees.length - visible.length;
      if (!visible.length) continue;
      const pr = visible.map(w => w.pr).filter((p): p is RepoPr => Boolean(p)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
      const ledgerPath = visible.flatMap(w => w.sessions).find(s => s.ledger)?.ledger;
      const ledger = ledgerPath ? await ledgerInfo(ledgerPath) : {};
      const title = g.title ?? (g.jira ? titles.get(g.jira) : undefined)
        ?? pr?.title.replace(/^\s*[A-Z][A-Z0-9]+-\d+\s*[:：]\s*/, '').trim()
        ?? ledger.title ?? visible.find(w => w.branch)?.branch ?? key;
      if (visible.every(w => DONE.has(w.phase))) {
        if (visible.some(w => !w.cleaned)) merged.push({ key, title, worktrees: visible.filter(w => !w.cleaned).map(w => w.path) });
        continue;
      }
      visible.sort((a, b) => rank(a.phase) - rank(b.phase) || (b.activityAt ?? 0) - (a.activityAt ?? 0));
      const activity = visible.map(w => w.activityAt ?? 0);
      tasks.push({
        key, ...(g.jira ? { jira: g.jira } : {}), title, repo: g.repo, phase: visible[0]!.phase,
        ...(Math.max(...activity) > 0 ? { activityAt: Math.max(...activity) } : {}), worktrees: visible,
        ...(ledgerPath ? { ledger: ledgerPath } : {}), ...(ledger.nextStep ? { nextStep: ledger.nextStep } : {}),
      });
    }
    tasks.sort((a, b) => rank(a.phase) - rank(b.phase) || (b.activityAt ?? 0) - (a.activityAt ?? 0));

    // Log tails only where someone will look: running builds and the latest failure.
    for (const t of tasks) for (const w of t.worktrees) {
      const last = w.jobs.at(-1);
      const pick = w.jobs.find(j => j.state === 'running') ?? (last && (last.state === 'failed' || last.state === 'interrupted') ? last : undefined);
      const job = pick && jobs.find(j => j.id === pick.id);
      if (pick && job) pick.logTail = await tailLog(job.logFile, 12);
    }

    const counts: Partial<Record<Phase, number>> = {};
    for (const t of tasks) counts[t.phase] = (counts[t.phase] ?? 0) + 1;
    const queue: BoardQueueEntry[] = queueSnap.entries.map(e => {
      const job = [...jobs].reverse().find(j => j.cwd === e.path && j.exitCode === undefined);
      return { name: basename(e.path), path: e.path, state: e.state, ...(e.position ? { position: e.position } : {}),
        ...(job ? { cmd: job.cmd, startedAt: job.startedAt, label: job.label } : {}) };
    });
    return { observedAt: now, tasks, merged, queue, counts, idle, ...(loading ? { loading: true } : {}), ...(error ? { error } : {}) };
  };
  return Object.assign(read, {
    /** Wait for first-time probes (one-shot `--once` / `--json` output and tests). */
    async settle(rootDir: string, bots: MonitorBot[] = []): Promise<void> {
      for (let i = 0; i < 4; i++) { await read(rootDir, Date.now(), bots); await repos.settle(); await repoInfo.settle(); await trees.settle(); await prs.settle(); }
    },
  });
}
export type CodingBoardReader = ReturnType<typeof createCodingBoardReader>;
