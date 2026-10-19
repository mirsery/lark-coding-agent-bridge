import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { KnowledgeLibraryConfig, SkillLibraryConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import { git } from '../git/exec';
import { writeFileAtomic } from '../platform/atomic-write';
import { bridgeRoot } from '../policy/owner-guard';
import { maskUrlCredentials, SkillLibraries, type LibrarySyncResult } from './libraries';
import { readWriteWindow, type WriteHookConfig, type WriteWindow } from './write-guard';

/**
 * Knowledge repositories besides the profile's own (`knowledge.libraries`) —
 * a department's shared one, typically. Three parts:
 *
 * - **Mirror** `knowledge-libraries/<name>/`: read-only, follows the remote
 *   (the same fetch + detached checkout + clean as a skill library, whole
 *   history so the panel can tell what was written this week). Its push URL
 *   leads nowhere.
 * - **Index**: title and one sentence of every Markdown file the `read`
 *   globs select, put into every run next to the skill index. Bodies stay on
 *   disk and are read on demand.
 * - **Write window**: while a configured job runs, or after the owner opened
 *   it (`/knowledge lib write`), `<name>.work/` is a normal clone the agent
 *   commits and pushes in. Its git hooks (`write-guard.ts`) refuse anything
 *   outside the window, anything but the bot's own directory on the default
 *   branch, and content that looks sensitive. Closing the window removes the
 *   clone unless it still holds unpushed work.
 */

export interface LibraryEntry {
  library: string;
  /** Absolute path of the file — handed to the agent to read. */
  path: string;
  title: string;
  summary: string;
  /**
   * `shared`: under `shared/`, the repository's reviewed conclusions.
   * `own`: under the bot's own directory. `personal`: another bot's directory
   * (a sibling of the own one). `other`: anything else the globs let in.
   */
  kind: 'shared' | 'own' | 'other' | 'personal';
}

/** A library the agent may write to right now. */
export interface LibraryWriteTarget {
  library: string;
  /** The writable clone. */
  work: string;
  self: string;
  defaultBranch: string;
  until: number;
}

export interface KnowledgeLibraryStatus {
  config: KnowledgeLibraryConfig;
  present: boolean;
  commit?: string;
  commitAt?: number;
  lastSyncAt?: number;
  lastError?: string;
  entries: number;
  window?: WriteWindow;
  /** Commits under `write.self` since Monday 00:00 (local time). */
  weekCommits?: number;
}

export const DEFAULT_LIBRARY_READ = ['**/*.md'];
/** How long a job's run keeps the window open — a weekly meeting takes up to an hour, with waits. */
export const JOB_WINDOW_MINUTES = 180;
export const DEFAULT_WINDOW_MINUTES = 120;
export const MAX_WINDOW_MINUTES = 24 * 60;

const MAX_FILES_PER_LIBRARY = 2000;
const MAX_SUMMARY_CHARS = 160;
const REPO_DOCS = new Set(['readme.md', 'contributing.md', 'changelog.md', 'license.md', 'codeowners']);
const CLONE_TIMEOUT_MS = 120_000;
const HOOKS = ['pre-commit', 'commit-msg', 'pre-push'] as const;

export class KnowledgeLibraries {
  readonly dir: string;
  private readonly libraries: () => readonly KnowledgeLibraryConfig[];
  private readonly mirrors: SkillLibraries;
  private readonly hookCommand: readonly string[];
  private readonly now: () => number;

  constructor(opts: {
    dir: string;
    libraries: () => readonly KnowledgeLibraryConfig[];
    /** Command the work clone's hooks run, before the hook name. Tests replace it. */
    hookCommand?: readonly string[];
    now?: () => number;
  }) {
    this.dir = opts.dir;
    this.libraries = opts.libraries;
    this.now = opts.now ?? Date.now;
    this.hookCommand = opts.hookCommand ?? [process.execPath, join(bridgeRoot(), 'bin', 'knowledge-hook.mjs')];
    this.mirrors = new SkillLibraries({
      dir: opts.dir,
      libraries: () => this.libraries().map(toMirrorConfig),
      fullHistory: true,
      keep: (name) => name.endsWith('.work'),
      logScope: 'knowledge-lib',
    });
  }

  mirrorDir(name: string): string {
    return join(this.dir, name);
  }

  workDir(name: string): string {
    return `${this.mirrorDir(name)}.work`;
  }

  windowFile(name: string): string {
    return `${this.mirrorDir(name)}.window.json`;
  }

  // ── mirrors ──────────────────────────────────────────────────────────────

  sync(name?: string): Promise<LibrarySyncResult[]> {
    return this.mirrors.sync(name);
  }

  /** Fetch one library, configured or not yet (`/knowledge lib add` saves only after this succeeded). */
  syncLibrary(library: KnowledgeLibraryConfig): Promise<LibrarySyncResult> {
    return this.mirrors.syncLibrary(toMirrorConfig(library));
  }

  startAutoSync(intervalMinutes: () => number): void {
    this.mirrors.startAutoSync(intervalMinutes);
  }

  reschedule(): void {
    this.mirrors.reschedule();
  }

  stop(): Promise<void> {
    return this.mirrors.stop();
  }

  /** Delete the mirror, the window and the work clone, unpushed work included. The caller drops the config entry. */
  async remove(name: string): Promise<void> {
    await rm(this.windowFile(name), { force: true });
    await rm(this.workDir(name), { recursive: true, force: true });
    await this.mirrors.remove(name);
  }

  // ── index ────────────────────────────────────────────────────────────────

  /** Every indexed file of every library: shared first, then own, other, other bots' notes. */
  async listEntries(): Promise<LibraryEntry[]> {
    const all: LibraryEntry[] = [];
    for (const library of this.libraries()) all.push(...(await this.scan(library)));
    const rank: Record<LibraryEntry['kind'], number> = { shared: 0, own: 1, other: 2, personal: 3 };
    return all
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => rank[a.entry.kind] - rank[b.entry.kind] || a.index - b.index)
      .map(({ entry }) => entry);
  }

  private async scan(library: KnowledgeLibraryConfig): Promise<LibraryEntry[]> {
    const mirror = this.mirrorDir(library.name);
    let root: string;
    try {
      root = await realpath(mirror);
    } catch {
      return [];
    }
    const globs = (library.read ?? DEFAULT_LIBRARY_READ).map(globToRegExp);
    const files: string[] = [];
    await walk(root, '', files);
    const entries: LibraryEntry[] = [];
    for (const rel of files.sort()) {
      if (entries.length >= MAX_FILES_PER_LIBRARY) break;
      const base = rel.split('/').pop()!.toLowerCase();
      if (!base.endsWith('.md') || REPO_DOCS.has(base) || !globs.some((re) => re.test(rel))) continue;
      const file = join(root, rel);
      let raw: string;
      try {
        // Real files only, and inside the mirror: the path goes to the agent.
        if (!isInside(root, await realpath(file))) continue;
        raw = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const header = parseEntryHeader(rel, raw);
      if (!header) continue;
      entries.push({ library: library.name, path: file, ...header, kind: entryKind(rel, library.write?.self) });
    }
    return entries;
  }

  // ── write window ─────────────────────────────────────────────────────────

  /**
   * Libraries writable right now. Windows that ran out are closed on the way
   * (this runs before every turn, so nothing else has to watch the clock).
   */
  async writeTargets(): Promise<LibraryWriteTarget[]> {
    const targets: LibraryWriteTarget[] = [];
    for (const library of this.libraries()) {
      const write = library.write;
      if (!write) continue;
      const window = await this.openWindowOf(library.name);
      if (!window) continue;
      const work = this.workDir(library.name);
      if (!(await isDirectory(join(work, '.git')))) continue;
      targets.push({
        library: library.name,
        work,
        self: write.self,
        defaultBranch: await defaultBranchOf(work, library),
        until: window.until,
      });
    }
    return targets;
  }

  /** The window if it is open; an expired one is closed here. */
  private async openWindowOf(name: string): Promise<WriteWindow | undefined> {
    const window = await readWriteWindow(this.windowFile(name));
    if (!window) return undefined;
    if (window.until > this.now()) return window;
    await this.closeWindow(name).catch((err: unknown) =>
      log.warn('knowledge-lib', 'window-expire-failed', { library: name, err: String(err) }),
    );
    return undefined;
  }

  /**
   * Open (or extend) the write window and make sure the work clone exists,
   * is up to date when it holds nothing of its own, and has the hooks.
   */
  async openWindow(name: string, opts: { minutes: number; reason: string }): Promise<LibraryWriteTarget> {
    const library = this.libraries().find((item) => item.name === name);
    if (!library) throw new Error(`没有叫 \`${name}\` 的知识库`);
    const write = library.write;
    if (!write) throw new Error(`\`${name}\` 没有配置 \`write.self\`（bot 在库里自己的目录），是只读库`);
    const minutes = Math.min(MAX_WINDOW_MINUTES, Math.max(1, Math.floor(opts.minutes)));
    const work = await this.ensureWorkClone(library);
    const now = this.now();
    const current = await readWriteWindow(this.windowFile(name));
    const until = Math.max(now + minutes * 60_000, current && current.until > now ? current.until : 0);
    const window: WriteWindow = { openedAt: current && current.until > now ? current.openedAt : now, until, reason: opts.reason };
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.windowFile(name), `${JSON.stringify(window, null, 2)}\n`, { mode: 0o600 });
    log.info('knowledge-lib', 'window-opened', { library: name, until, reason: opts.reason });
    return { library: name, work, self: write.self, defaultBranch: await defaultBranchOf(work, library), until };
  }

  /** Windows for the libraries that list this job. Failures are logged, never thrown: the job runs regardless. */
  async openForJob(jobId: string): Promise<string[]> {
    const opened: string[] = [];
    for (const library of this.libraries()) {
      if (!library.write?.jobs?.includes(jobId)) continue;
      try {
        await this.openWindow(library.name, { minutes: JOB_WINDOW_MINUTES, reason: `cron:${jobId}` });
        opened.push(library.name);
      } catch (err) {
        log.warn('knowledge-lib', 'job-window-failed', {
          library: library.name,
          jobId,
          err: maskUrlCredentials(err instanceof Error ? err.message : String(err)),
        });
      }
    }
    return opened;
  }

  /**
   * Close the window. The work clone goes too unless it has changes or
   * commits that never reached the remote — those wait for the next window
   * (the hooks refuse to commit or push them in between).
   */
  async closeWindow(name: string): Promise<{ keptWork: boolean }> {
    await rm(this.windowFile(name), { force: true });
    const work = this.workDir(name);
    if (!(await isDirectory(work))) return { keptWork: false };
    if (await hasUnpublishedWork(work)) {
      log.info('knowledge-lib', 'window-closed', { library: name, keptWork: true });
      return { keptWork: true };
    }
    await rm(work, { recursive: true, force: true });
    log.info('knowledge-lib', 'window-closed', { library: name, keptWork: false });
    return { keptWork: false };
  }

  private async ensureWorkClone(library: KnowledgeLibraryConfig): Promise<string> {
    const work = this.workDir(library.name);
    if (!(await isDirectory(join(work, '.git')))) {
      const scratch = `${work}.tmp-${randomBytes(4).toString('hex')}`;
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const clone = await git(
        this.dir,
        [
          '-c',
          'protocol.ext.allow=never',
          'clone',
          '-q',
          '--no-recurse-submodules',
          ...(library.ref ? ['--branch', library.ref] : []),
          '--',
          library.url,
          scratch,
        ],
        { timeoutMs: CLONE_TIMEOUT_MS },
      );
      if (!clone.ok) {
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
        throw new Error(`clone 失败：${maskUrlCredentials(firstGitError(clone.stderr) ?? 'git clone 出错')}`);
      }
      await rename(scratch, work);
    } else if (!(await hasUnpublishedWork(work))) {
      // Nothing of ours in there: start from what the remote has now.
      const branch = await defaultBranchOf(work, library);
      await git(work, ['checkout', '-q', branch]);
      const pull = await git(work, ['pull', '-q', '--ff-only'], { timeoutMs: CLONE_TIMEOUT_MS });
      if (!pull.ok) {
        log.warn('knowledge-lib', 'work-pull-failed', {
          library: library.name,
          err: maskUrlCredentials(firstGitError(pull.stderr) ?? ''),
        });
      }
    }
    await this.installHooks(library, work);
    return work;
  }

  private async installHooks(library: KnowledgeLibraryConfig, work: string): Promise<void> {
    const hooksDir = join(work, '.git', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const config: WriteHookConfig = {
      library: library.name,
      self: library.write!.self,
      windowFile: this.windowFile(library.name),
      defaultBranch: await defaultBranchOf(work, library),
    };
    const configFile = join(work, '.git', 'bridge-write.json');
    await writeFileAtomic(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    for (const hook of HOOKS) {
      const file = join(hooksDir, hook);
      const command = [...this.hookCommand, hook, configFile].map(shellQuote).join(' ');
      await writeFileAtomic(file, `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o755 });
      await chmod(file, 0o755);
    }
    // A global `core.hooksPath` would make git skip `.git/hooks` entirely.
    await git(work, ['config', 'core.hooksPath', hooksDir]);
  }

  // ── status ───────────────────────────────────────────────────────────────

  async status(): Promise<KnowledgeLibraryStatus[]> {
    const mirrorStatus = new Map((await this.mirrors.status()).map((item) => [item.config.name, item]));
    const entries = await this.listEntries();
    const monday = startOfWeek(this.now());
    return Promise.all(
      this.libraries().map(async (config) => {
        const mirror = mirrorStatus.get(config.name);
        const window = config.write ? await this.openWindowOf(config.name) : undefined;
        let weekCommits: number | undefined;
        if (mirror?.present && config.write) {
          const count = await git(this.mirrorDir(config.name), [
            'rev-list',
            '--count',
            `--since=${Math.floor(monday / 1000)}`,
            'HEAD',
            '--',
            config.write.self,
          ]);
          if (count.ok) weekCommits = Number(count.stdout.trim());
        }
        return {
          config,
          present: mirror?.present ?? false,
          ...(mirror?.commit ? { commit: mirror.commit } : {}),
          ...(mirror?.commitAt ? { commitAt: mirror.commitAt } : {}),
          ...(mirror?.lastSyncAt ? { lastSyncAt: mirror.lastSyncAt } : {}),
          ...(mirror?.lastError ? { lastError: mirror.lastError } : {}),
          entries: entries.filter((entry) => entry.library === config.name).length,
          ...(window ? { window } : {}),
          ...(weekCommits !== undefined && Number.isFinite(weekCommits) ? { weekCommits } : {}),
        };
      }),
    );
  }
}

function toMirrorConfig(library: KnowledgeLibraryConfig): SkillLibraryConfig {
  return { name: library.name, owner: 'self', url: library.url, ...(library.ref ? { ref: library.ref } : {}) };
}

/** `*` stays within one path segment, `**` spans any number of them (zero included). */
export function globToRegExp(glob: string): RegExp {
  const clean = glob.trim().replace(/^\.\/+/, '');
  let out = '';
  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i]!;
    if (char === '*' && clean[i + 1] === '*') {
      const slash = clean[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (char === '*') {
      out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

function entryKind(rel: string, self: string | undefined): LibraryEntry['kind'] {
  if (rel.startsWith('shared/')) return 'shared';
  if (self && (rel === self || rel.startsWith(`${self}/`))) return 'own';
  const parent = self?.includes('/') ? self.slice(0, self.lastIndexOf('/')) : undefined;
  if (parent && rel.startsWith(`${parent}/`)) return 'personal';
  return 'other';
}

/**
 * Title: front matter `title` / `name`, else the first heading, else the file
 * name. Summary: front matter `description`, else the first line of prose
 * (bullets of metadata — 来源、适用范围 — come before the prose in the
 * repository's template, so they are only the fallback). Undefined for a file
 * with nothing in it.
 */
export function parseEntryHeader(rel: string, raw: string): { title: string; summary: string } | undefined {
  let body = raw.replace(/^﻿/, '');
  const meta: Record<string, string> = {};
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (front) {
    for (const line of front[1]!.split(/\r?\n/)) {
      const match = /^(\w+)\s*:\s*(.*)$/.exec(line);
      if (match) meta[match[1]!.toLowerCase()] = match[2]!.trim().replace(/^["']|["']$/g, '');
    }
    body = body.slice(front[0].length);
  }
  const lines = body.split(/\r?\n/);
  const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line))?.replace(/^#{1,6}\s+/, '').trim();
  const title = meta.title || meta.name || heading || rel.split('/').pop()!.replace(/\.md$/i, '');
  let prose: string | undefined;
  let bullet: string | undefined;
  let fenced = false;
  for (const line of lines.slice(0, 80)) {
    const text = line.trim();
    if (text.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !text || text.startsWith('#') || text.startsWith('<!--') || text.startsWith('|') || text.startsWith('>')) {
      continue;
    }
    if (/^[-*+]\s+/.test(text) || /^\d+\.\s+/.test(text)) {
      bullet ??= text.replace(/^(?:[-*+]|\d+\.)\s+/, '');
      continue;
    }
    prose = text;
    break;
  }
  const summary = (meta.description || prose || bullet || '').replace(/\s+/g, ' ');
  if (!summary && !heading && !meta.title && !meta.name) return undefined;
  return {
    title: truncate(title, 120),
    summary: truncate(summary, MAX_SUMMARY_CHARS),
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function walk(root: string, rel: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES_PER_LIBRARY * 2) return;
  let entries;
  try {
    entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    // Real directories and files only: a symlink could lead anywhere on the host.
    if (entry.isDirectory()) await walk(root, child, out);
    else if (entry.isFile()) out.push(child);
  }
}

/** Changes in the working tree, or commits on any branch that no remote branch has. */
async function hasUnpublishedWork(work: string): Promise<boolean> {
  const status = await git(work, ['status', '--porcelain']);
  if (!status.ok || status.stdout.trim()) return true;
  const unpushed = await git(work, ['log', '--branches', '--not', '--remotes', '--format=%h', '-n', '1']);
  return !unpushed.ok || Boolean(unpushed.stdout.trim());
}

async function defaultBranchOf(work: string, library: KnowledgeLibraryConfig): Promise<string> {
  if (library.ref) return library.ref;
  const head = await git(work, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const name = head.ok ? head.stdout.trim().replace(/^origin\//, '') : '';
  return name || 'main';
}

function firstGitError(stderr: string): string | undefined {
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /^(fatal|error):/.test(line)) ?? lines.at(-1);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Monday 00:00 local time of the week `now` falls in. */
export function startOfWeek(now: number): number {
  const date = new Date(now);
  const day = (date.getDay() + 6) % 7;
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - day);
  return date.getTime();
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(sep);
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isDirectory(), () => false);
}
