import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import {
  isExternalLibrary,
  isSafeSkillLibraryPath,
  isValidSkillLibraryName,
  type SkillLibraryConfig,
  type SkillLibraryOwner,
} from '../config/profile-schema';
import { log } from '../core/logger';
import { git, isSafeRef } from '../git/exec';
import { parseSkillHeader, type SkillSummary } from './store';
import { isPlausibleGitUrl } from './sync';

/**
 * Shared skill libraries: git repositories of skills that several profiles
 * (CC and Poki alike) load from one place instead of each keeping a copy.
 *
 * Each library is a read-only mirror under `skill-libraries/<name>/`. A sync is
 * fetch + detached checkout + clean, never a merge, so whatever happened to the
 * files locally the mirror always ends up exactly at the remote's commit — edits
 * belong in the library's own repository, not here.
 *
 * The bridge only indexes the mirrors (name, description, path of SKILL.md);
 * the agent reads a body when it decides the skill applies, exactly as with the
 * profile's own `knowledge/skills/`.
 *
 * A library is either the owner's own (`self`, follows its remote) or someone
 * else's (`external`). An external mirror stays at the configured `pin`: a sync
 * only fetches and records what the remote has (`refs/bridge/upstream`), so the
 * difference can be reviewed before {@link SkillLibraries.advance} moves the pin.
 * Skills of self libraries win name clashes over external ones.
 */

export interface LibrarySyncResult {
  name: string;
  ok: boolean;
  /** Short commit the mirror is at after the sync. */
  commit?: string;
  /** Full id of {@link commit} — what an external library's `pin` stores. */
  head?: string;
  /** The mirror was created or moved to a different commit. */
  changed?: boolean;
  /** External libraries: what the remote has that the pinned mirror does not. */
  pending?: LibraryPending;
  error?: string;
}

/** An external library's upstream compared with its pin, by skill directory. */
export interface LibraryPending {
  /** Short commit the remote is at. */
  upstream: string;
  /** Commits between the pin and the remote; absent when history does not connect them. */
  ahead?: number;
  added: string[];
  removed: string[];
  changed: string[];
}

/** Push URL of every mirror: not a repository, so `git push` fails with a path that says why. */
export const READ_ONLY_PUSH_URL = '/dev/null/read-only-mirror';

/** The ref an external mirror keeps the remote's latest fetched commit under. */
const UPSTREAM_REF = 'refs/bridge/upstream';

export interface LibraryStatus {
  config: SkillLibraryConfig;
  /** A mirror exists on disk. */
  present: boolean;
  commit?: string;
  /** Committer time of {@link commit}, epoch ms. */
  commitAt?: number;
  lastSyncAt?: number;
  lastError?: string;
  /** Skills found in the mirror after include / exclude, before de-duplication. */
  skills: SkillSummary[];
  /** External libraries with a fetched upstream: how far the remote is from the pin. */
  pending?: LibraryPending;
}

const FETCH_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 5_000;
export const DEFAULT_SKILL_SYNC_INTERVAL_MINUTES = 60;

export class SkillLibraries {
  readonly dir: string;
  private readonly libraries: () => readonly SkillLibraryConfig[];
  private readonly inFlight = new Map<string, Promise<LibrarySyncResult>>();
  private readonly lastSync = new Map<string, { at: number; error?: string }>();
  private timer: NodeJS.Timeout | undefined;
  private loop: Promise<unknown> | undefined;
  private tick: ((first: boolean) => Promise<void>) | undefined;
  private intervalMinutes: (() => number) | undefined;
  private stopped = false;
  private readonly fullHistory: boolean;
  private readonly keepEntry: (name: string) => boolean;
  private readonly logScope: string;

  constructor(opts: {
    dir: string;
    libraries: () => readonly SkillLibraryConfig[];
    /**
     * Fetch whole history for every library, not just external ones — the
     * knowledge libraries count what was written this week.
     */
    fullHistory?: boolean;
    /** Entries of {@link dir} that are not mirrors and must survive the start-up sweep. */
    keep?: (name: string) => boolean;
    logScope?: string;
  }) {
    this.dir = opts.dir;
    this.libraries = opts.libraries;
    this.fullHistory = opts.fullHistory ?? false;
    this.keepEntry = opts.keep ?? (() => false);
    this.logScope = opts.logScope ?? 'skills';
  }

  mirrorDir(name: string): string {
    return join(this.dir, name);
  }

  /**
   * Every library's skills, self libraries before external ones and otherwise
   * in configuration order. A name already taken by an earlier library is
   * skipped — the profile's own skills are merged in front of these by
   * {@link KnowledgeStore.listSkills} with the same rule.
   */
  async listSkills(): Promise<SkillSummary[]> {
    const merged: SkillSummary[] = [];
    const taken = new Set<string>();
    for (const library of byPrecedence(this.libraries())) {
      for (const skill of await this.scan(library)) {
        if (taken.has(skill.name)) continue;
        taken.add(skill.name);
        merged.push(skill);
      }
    }
    return merged;
  }

  async status(): Promise<LibraryStatus[]> {
    return Promise.all(
      this.libraries().map(async (config) => {
        const mirror = this.mirrorDir(config.name);
        const present = await isDirectory(join(mirror, '.git'));
        const head = present ? await git(mirror, ['log', '-1', '--format=%h %ct']) : undefined;
        const [commit, seconds] = head?.ok ? head.stdout.trim().split(' ') : [];
        const last = this.lastSync.get(config.name);
        const pending = present && isExternalLibrary(config) ? await pendingChanges(mirror, config) : undefined;
        return {
          config,
          present,
          ...(commit ? { commit } : {}),
          ...(seconds ? { commitAt: Number(seconds) * 1000 } : {}),
          ...(last ? { lastSyncAt: last.at } : {}),
          ...(last?.error ? { lastError: last.error } : {}),
          skills: present ? await this.scan(config) : [],
          ...(pending ? { pending } : {}),
        };
      }),
    );
  }

  /** Pull every configured library, or just the one named. */
  async sync(name?: string): Promise<LibrarySyncResult[]> {
    const targets = this.libraries().filter((library) => !name || library.name === name);
    return Promise.all(targets.map((library) => this.syncLibrary(library)));
  }

  /**
   * Fetch one library. A self library's mirror moves to the remote's current
   * commit; an external one stays at its `pin` (or, with none yet, is pinned at
   * what was fetched — the caller saves {@link LibrarySyncResult.head}). Also
   * used for a library that is not in the configuration yet: `/skills lib add`
   * only saves the entry once this succeeded.
   */
  syncLibrary(library: SkillLibraryConfig): Promise<LibrarySyncResult> {
    // Concurrent syncs of one library share a fetch.
    const running = this.inFlight.get(library.name);
    if (running) return running;
    return this.track(library.name, this.fetchInto(library, false));
  }

  /**
   * Move an external library's mirror to the remote's current commit. The
   * caller stores the returned {@link LibrarySyncResult.head} as the new `pin`;
   * until it does, the next sync puts the mirror back at the old one.
   */
  async advance(library: SkillLibraryConfig): Promise<LibrarySyncResult> {
    // Unlike a sync, this one cannot ride along: it checks out something else.
    for (let running = this.inFlight.get(library.name); running; running = this.inFlight.get(library.name)) {
      await running;
    }
    return this.track(library.name, this.fetchInto(library, true));
  }

  private track(name: string, work: Promise<LibrarySyncResult>): Promise<LibrarySyncResult> {
    const task = work.finally(() => {
      if (this.inFlight.get(name) === task) this.inFlight.delete(name);
    });
    this.inFlight.set(name, task);
    return task;
  }

  /** Delete a library's mirror. The caller removes it from the configuration. */
  async remove(name: string): Promise<void> {
    await this.inFlight.get(name)?.catch(() => undefined);
    this.lastSync.delete(name);
    await rm(this.mirrorDir(name), { recursive: true, force: true });
  }

  /**
   * Pull everything now (start-up), then again every `intervalMinutes()`. The
   * interval is re-read each time, so changing it needs no restart; while it is
   * `0` the loop only wakes up hourly to look at the setting again.
   */
  startAutoSync(intervalMinutes: () => number): void {
    this.stopped = false;
    this.intervalMinutes = intervalMinutes;
    const tick = async (first: boolean): Promise<void> => {
      if (this.stopped) return;
      if (first) await this.sweepStale();
      const minutes = intervalMinutes();
      if (first || minutes > 0) await this.sync().catch(() => []);
      if (this.stopped) return;
      this.scheduleNext(minutes);
    };
    this.tick = tick;
    this.loop = tick(true);
  }

  /**
   * Restart the wait with the interval as it is configured now, instead of
   * finishing the one that was set with the old value. A sync in progress
   * schedules its successor itself when it ends.
   */
  reschedule(): void {
    if (this.stopped || !this.timer || !this.intervalMinutes) return;
    clearTimeout(this.timer);
    this.scheduleNext(this.intervalMinutes());
  }

  private scheduleNext(minutes: number): void {
    const wait = (minutes > 0 ? minutes : DEFAULT_SKILL_SYNC_INTERVAL_MINUTES) * 60_000;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.loop = this.tick?.(false);
    }, wait);
    this.timer.unref?.();
  }

  /**
   * Stop the timer. A fetch already running gets a few seconds to finish, not
   * its whole timeout: shutdown must not hang on a slow remote, and an
   * interrupted sync is repaired by the next one (`checkout --force` + `clean`,
   * scratch directories swept on start-up).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const loop = this.loop?.catch(() => undefined);
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([
      loop,
      new Promise<void>((resolve) => {
        grace = setTimeout(resolve, STOP_GRACE_MS);
        grace.unref?.();
      }),
    ]);
    if (grace) clearTimeout(grace);
  }

  /**
   * Remove what earlier runs left behind: `<name>.tmp-*` directories of a first
   * fetch that died mid-way, and mirrors of libraries that are no longer
   * configured — the web console removes a library from the configuration while
   * a separate process may still be running this profile and pulling it.
   */
  private async sweepStale(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch {
      return;
    }
    const configured = new Set(this.libraries().map((library) => library.name));
    await Promise.all(
      entries
        .filter(
          (entry) =>
            /\.tmp-[0-9a-f]{8}$/.test(entry.name) ||
            (entry.isDirectory() &&
              isValidSkillLibraryName(entry.name) &&
              !configured.has(entry.name) &&
              !this.keepEntry(entry.name)),
        )
        .map((entry) => rm(join(this.dir, entry.name), { recursive: true, force: true }).catch(() => undefined)),
    );
  }

  private async fetchInto(library: SkillLibraryConfig, advance: boolean): Promise<LibrarySyncResult> {
    const mirror = this.mirrorDir(library.name);
    const fresh = !(await isDirectory(join(mirror, '.git')));
    // A first fetch happens in a scratch directory and is renamed into place
    // only when complete, so a failed clone never leaves a half-mirror behind
    // that a later sync would have to recognise and repair.
    const work = fresh ? `${mirror}.tmp-${randomBytes(4).toString('hex')}` : mirror;
    try {
      if (fresh) {
        await mkdir(work, { recursive: true, mode: 0o700 });
        await run(work, ['init', '-q']);
        await run(work, ['remote', 'add', 'origin', library.url]);
      } else {
        const current = await git(work, ['remote', 'get-url', 'origin']);
        if (!current.ok) await run(work, ['remote', 'add', 'origin', library.url]);
        else if (current.stdout.trim() !== library.url) await run(work, ['remote', 'set-url', 'origin', library.url]);
      }
      // A mirror never pushes: whatever someone commits in it would be thrown
      // away by the next sync anyway, and must not reach the remote first.
      await run(work, ['config', 'remote.origin.pushurl', READ_ONLY_PUSH_URL]);
      const before = fresh ? undefined : await headCommit(work);
      const external = isExternalLibrary(library);
      // A self mirror only ever needs the tip. An external one keeps history so
      // the card can say how many commits the remote is ahead of the pin, and
      // so the pinned commit is still there after the remote moved on;
      // knowledge mirrors keep it to tell what was written this week.
      const depth =
        external || this.fullHistory
          ? (await git(work, ['rev-parse', '--is-shallow-repository'])).stdout.trim() === 'true'
            ? ['--unshallow']
            : []
          : ['--depth', '1'];
      await fetch(work, [...depth, 'origin', library.ref ?? 'HEAD']);
      let target = 'FETCH_HEAD';
      if (external) {
        await run(work, ['update-ref', UPSTREAM_REF, 'FETCH_HEAD']);
        if (library.pin && !advance) {
          target = library.pin;
          if (!(await hasCommit(work, target))) {
            // Not on the followed branch any more (force-pushed away, or the
            // ref changed): ask for the commit itself.
            await fetch(work, ['origin', target]).catch(() => {
              throw new Error(`固定的提交 ${target.slice(0, 7)} 在远端已经找不到了，用 update 切到上游最新`);
            });
          }
        }
      }
      await run(work, ['-c', 'advice.detachedHead=false', 'checkout', '-q', '--force', '--detach', target]);
      await run(work, ['clean', '-q', '-f', '-d', '-x']);
      const after = await headCommit(work);
      const head = (await git(work, ['rev-parse', 'HEAD'])).stdout.trim();
      const pending = external ? await pendingChanges(work, library) : undefined;
      if (fresh) {
        await rm(mirror, { recursive: true, force: true });
        await rename(work, mirror);
      }
      this.lastSync.set(library.name, { at: Date.now() });
      const changed = fresh || before !== after;
      log.info(this.logScope, 'library-synced', {
        library: library.name,
        commit: after,
        changed,
        ...(pending ? { upstream: pending.upstream } : {}),
      });
      return {
        name: library.name,
        ok: true,
        ...(after ? { commit: after } : {}),
        ...(head ? { head } : {}),
        changed,
        ...(pending ? { pending } : {}),
      };
    } catch (err) {
      if (fresh) await rm(work, { recursive: true, force: true }).catch(() => undefined);
      const error = maskUrlCredentials(err instanceof Error ? err.message : String(err));
      this.lastSync.set(library.name, { at: Date.now(), error });
      log.warn(this.logScope, 'library-sync-failed', { library: library.name, err: error });
      return { name: library.name, ok: false, error };
    }
  }

  private async scan(library: SkillLibraryConfig): Promise<SkillSummary[]> {
    const mirror = this.mirrorDir(library.name);
    let mirrorReal: string;
    try {
      mirrorReal = await realpath(mirror);
    } catch {
      return [];
    }
    const base = library.path
      ? join(mirror, library.path)
      : (await isDirectory(join(mirror, 'skills')))
        ? join(mirror, 'skills')
        : mirror;

    // A repository that is itself one skill (SKILL.md at the base) counts as a
    // single skill named after the library.
    const candidates: Array<{ dirName: string; file: string }> = [];
    if (await isFile(join(base, 'SKILL.md'))) {
      candidates.push({ dirName: library.name, file: join(base, 'SKILL.md') });
    } else {
      let entries;
      try {
        entries = await readdir(base, { withFileTypes: true });
      } catch {
        return [];
      }
      // Real directories only: a symlinked entry could point anywhere on the host.
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
        candidates.push({ dirName: entry.name, file: join(base, entry.name, 'SKILL.md') });
      }
    }

    const skills: SkillSummary[] = [];
    for (const { dirName, file } of candidates) {
      let raw: string;
      try {
        // The index hands this path to the agent to read, so it must not lead
        // out of the mirror (a SKILL.md symlinked at ~/.ssh/… for instance).
        if (!isInside(mirrorReal, await realpath(file))) {
          log.warn('skills', 'library-skill-outside-mirror', { library: library.name, skill: dirName });
          continue;
        }
        raw = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const header = parseSkillHeader(dirName, raw);
      if (!passesFilter(library, dirName, header.name)) continue;
      skills.push({
        ...header,
        path: file,
        source: library.name,
        ...(isExternalLibrary(library) ? { external: true } : {}),
      });
    }
    return skills;
  }
}

/** Configured interval, defaulting when the profile has no `skills` section. */
export function getSkillSyncIntervalMinutes(skills: { syncIntervalMinutes?: number } | undefined): number {
  return skills?.syncIntervalMinutes ?? DEFAULT_SKILL_SYNC_INTERVAL_MINUTES;
}

/** What someone asks to add: `/skills lib add` arguments or the web console form. */
export interface LibraryDraft {
  url: string;
  /** Absent: `self`. */
  owner?: SkillLibraryOwner;
  /** Absent or empty: derived from the URL. */
  name?: string;
  ref?: string;
  path?: string;
  include?: string[];
  exclude?: string[];
}

/**
 * Turn a draft into a library entry, or say what is wrong with it. `taken` are
 * the names already configured. Shared by the chat command and the web console
 * so both accept exactly the same libraries.
 */
export function buildLibraryConfig(
  draft: LibraryDraft,
  taken: ReadonlySet<string>,
): { library: SkillLibraryConfig } | { error: string } {
  const url = draft.url.trim();
  if (!url) return { error: '缺少 git 地址。' };
  if (!isPlausibleGitUrl(url)) return { error: `看起来不像 git 仓库地址：\`${maskUrlCredentials(url)}\`` };
  const name = draft.name?.trim() || libraryNameFromUrl(url);
  if (!isValidSkillLibraryName(name)) {
    return { error: `库名 \`${name || '(空)'}\` 不可用：字母或数字开头，只含字母、数字、\`.\`、\`_\`、\`-\`，最长 64。` };
  }
  if (taken.has(name)) return { error: `已经有叫 \`${name}\` 的库了，换个名字或先把它移除。` };
  const ref = draft.ref?.trim() || undefined;
  if (ref !== undefined && (!isSafeRef(ref) || ref.includes('..'))) return { error: `ref \`${ref}\` 不合法。` };
  const rawPath = draft.path?.trim() || undefined;
  const path = rawPath?.replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (rawPath !== undefined && !isSafeSkillLibraryPath(path ?? '')) {
    return { error: `目录 \`${rawPath}\` 不合法：要写仓库内的相对路径。` };
  }
  const list = (items: string[] | undefined) => items?.map((item) => item.trim()).filter(Boolean);
  const include = list(draft.include);
  const exclude = list(draft.exclude);
  return {
    library: {
      name,
      owner: draft.owner === 'external' ? 'external' : 'self',
      url,
      ...(ref ? { ref } : {}),
      ...(path ? { path } : {}),
      ...(include?.length ? { include } : {}),
      ...(exclude?.length ? { exclude } : {}),
    },
  };
}

/**
 * `/skills lib update` and the console's update button. A self library just
 * syncs. An external one moves to the remote's current commit and `savePin`
 * stores it; if saving fails the mirror goes back to the old pin, so the files
 * on disk never disagree with the configuration for longer than the attempt.
 */
export async function updateLibrary(
  libraries: SkillLibraries,
  library: SkillLibraryConfig,
  savePin: (pin: string) => Promise<void>,
): Promise<LibrarySyncResult> {
  if (!isExternalLibrary(library)) return libraries.syncLibrary(library);
  const result = await libraries.advance(library);
  if (!result.ok || !result.head || result.head === library.pin) return result;
  try {
    await savePin(result.head);
  } catch (err) {
    await libraries.syncLibrary(library).catch(() => undefined);
    return { name: library.name, ok: false, error: `保存配置失败：${err instanceof Error ? err.message : String(err)}` };
  }
  log.info('skills', 'library-pin-moved', { library: library.name, from: library.pin?.slice(0, 7), to: result.commit });
  return result;
}

/**
 * Store the commit an external library was first fetched at as its pin. `add`
 * calls this before saving; a library added with a pin already keeps it.
 */
export function withPin(library: SkillLibraryConfig, result: LibrarySyncResult): SkillLibraryConfig {
  return isExternalLibrary(library) && !library.pin && result.head ? { ...library, pin: result.head } : library;
}

/** Self libraries first, each group in configuration order: the order skills are merged in. */
export function byPrecedence<T extends Pick<SkillLibraryConfig, 'owner'>>(libraries: readonly T[]): T[] {
  return [
    ...libraries.filter((library) => !isExternalLibrary(library)),
    ...libraries.filter((library) => isExternalLibrary(library)),
  ];
}

/** Skills of a library that lost to an earlier skill of the same name in the merged index. */
export function shadowedSkills(status: LibraryStatus, merged: readonly SkillSummary[]): string[] {
  const winner = new Map(merged.map((skill) => [skill.name, skill.source]));
  return status.skills.filter((skill) => winner.get(skill.name) !== status.config.name).map((skill) => skill.name);
}

/**
 * `https://user:token@host/x.git` → `https://***@host/x.git`, anywhere in the
 * text. Library URLs end up in cards, logs and git's own error messages.
 */
export function maskUrlCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
}

/** Library name suggested for a URL: its last path segment without `.git`. */
export function libraryNameFromUrl(url: string): string {
  const last = url.replace(/[/\\]+$/, '').split(/[/\\:]/).pop() ?? '';
  return last.replace(/\.git$/i, '').replace(/[^\w.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
}

function passesFilter(library: SkillLibraryConfig, dirName: string, name: string): boolean {
  const matches = (list: string[] | undefined) => Boolean(list?.some((item) => item === dirName || item === name));
  if (library.include && !matches(library.include)) return false;
  return !matches(library.exclude);
}

async function run(cwd: string, args: string[], timeoutMs?: number): Promise<void> {
  const result = await git(cwd, args, timeoutMs ? { timeoutMs } : {});
  if (result.ok) return;
  if (result.timedOut) {
    throw new Error(`git ${args.find((arg) => !arg.startsWith('-') && !arg.includes('=')) ?? ''} 超时`);
  }
  // git's first `fatal:` / `error:` line names the actual problem; the lines
  // after it are generic advice ("Please make sure you have the correct…").
  const lines = result.stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  throw new Error(lines.find((line) => /^(fatal|error):/.test(line)) ?? lines.at(-1) ?? `git 退出码 ${result.code}`);
}

async function fetch(cwd: string, args: string[]): Promise<void> {
  await run(
    cwd,
    ['-c', 'protocol.ext.allow=never', 'fetch', '-q', '--no-tags', '--no-recurse-submodules', ...args],
    FETCH_TIMEOUT_MS,
  );
}

async function hasCommit(cwd: string, commit: string): Promise<boolean> {
  return (await git(cwd, ['cat-file', '-e', `${commit}^{commit}`])).ok;
}

/**
 * Skill directories that differ between the checked-out pin and the fetched
 * upstream, under the library's skill directory and within its include /
 * exclude filter (matched by directory name: the diff has no headers to read).
 */
async function pendingChanges(mirror: string, library: SkillLibraryConfig): Promise<LibraryPending | undefined> {
  const upstream = await git(mirror, ['rev-parse', '--short', '--verify', '-q', `${UPSTREAM_REF}^{commit}`]);
  if (!upstream.ok || !upstream.stdout.trim()) return undefined;
  const count = await git(mirror, ['rev-list', '--count', `HEAD..${UPSTREAM_REF}`]);
  const ahead = count.ok ? Number(count.stdout.trim()) : NaN;
  const base = library.path ?? ((await isDirectory(join(mirror, 'skills'))) ? 'skills' : '');
  const diff = await git(mirror, [
    'diff',
    '--name-status',
    '--no-renames',
    'HEAD',
    UPSTREAM_REF,
    '--',
    ...(base ? [base] : []),
  ]);
  const added = new Set<string>();
  const removed = new Set<string>();
  const changed = new Set<string>();
  if (diff.ok) {
    const prefix = base ? `${base.replace(/\/+$/, '')}/` : '';
    for (const line of diff.stdout.split('\n')) {
      const [status, file] = line.split('\t');
      if (!status || !file || !file.startsWith(prefix)) continue;
      const parts = file.slice(prefix.length).split('/');
      // A file directly in the base is the library itself being one skill.
      const skill = parts.length === 1 ? library.name : parts[0]!;
      if (skill.startsWith('.') || !passesFilter(library, skill, skill)) continue;
      const isSkillFile = parts.length === 2 && parts[1] === 'SKILL.md';
      if (isSkillFile && status === 'A') added.add(skill);
      else if (isSkillFile && status === 'D') removed.add(skill);
      else changed.add(skill);
    }
  }
  for (const skill of [...added, ...removed]) changed.delete(skill);
  return {
    upstream: upstream.stdout.trim(),
    ...(Number.isFinite(ahead) ? { ahead } : {}),
    added: [...added].sort(),
    removed: [...removed].sort(),
    changed: [...changed].sort(),
  };
}

async function headCommit(cwd: string): Promise<string | undefined> {
  const result = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isDirectory(), () => false);
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isFile(), () => false);
}
