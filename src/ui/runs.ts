import { resolveAppPaths } from '../config/app-paths';
import { listAllProfiles } from '../runtime/profile-discovery';
import { isAlive } from '../runtime/registry';
import { readRunRecords, RUN_STALE_AFTER_MS } from '../runtime/run-registry';
import { HttpError } from './http';
import type { UiSupervisor } from './types';

/** One row of the console's tasks panel, across every profile. */
export interface RunView {
  profile: string;
  scope: string;
  /** Empty for runs with no chat (e.g. cloud-doc comment runs). */
  chatId: string;
  threadId?: string;
  /** Resolved from the hosting process's knownChats; absent when unknown —
   * the frontend falls back to showing chatId. */
  chatName?: string;
  promptPreview: string;
  startedAt: number;
  elapsedMs: number;
  /** null = unknowable (the run belongs to another process); 0 = known empty. */
  queueDepth: number | null;
  source: 'im' | 'comment';
  /** `orphan`: the record's owner pid is dead (or the record is >24h old) —
   * nothing is actually running; restarting that profile sweeps it. */
  status: 'running' | 'orphan';
}

/**
 * Every profile's in-flight runs. Profiles hosted by this process are read
 * from memory (ActiveRuns + RunRegistry + PendingQueue, via the late-bound
 * RunsMonitor); everything else is read from the profile's runs.json on disk,
 * with liveness judged by the record's owner pid.
 */
export async function listRuns(
  supervisor: UiSupervisor,
  rootDir?: string,
  now: number = Date.now(),
): Promise<RunView[]> {
  const out: RunView[] = [];
  const hosted = new Set<string>();

  for (const status of supervisor.list()) {
    hosted.add(status.profile);
    const controls = supervisor.controlsFor(status.profile);
    const monitor = controls?.runsMonitor;
    if (!monitor) continue;
    const chatNames = new Map((controls?.knownChats ?? []).map((c) => [c.id, c.name]));
    for (const snap of monitor.snapshot()) {
      const chatName = snap.chatId ? chatNames.get(snap.chatId) : undefined;
      out.push({
        profile: status.profile,
        scope: snap.scope,
        chatId: snap.chatId ?? '',
        ...(snap.threadId ? { threadId: snap.threadId } : {}),
        ...(chatName ? { chatName } : {}),
        promptPreview: snap.promptPreview,
        startedAt: snap.startedAt,
        elapsedMs: Math.max(0, now - snap.startedAt),
        queueDepth: snap.queueDepth,
        source: snap.source,
        status: 'running',
      });
    }
  }

  // Profiles this process does not host: observe their durable registry. A
  // record whose owner is alive is a real run in another daemon; a dead owner
  // (or a >24h record) is a leftover the next boot of that profile will sweep.
  const profiles = await listAllProfiles(rootDir).catch(() => []);
  for (const p of profiles) {
    if (hosted.has(p.name)) continue;
    const runsFile = resolveAppPaths({ rootDir, profile: p.name }).runsFile;
    for (const rec of await readRunRecords(runsFile)) {
      const orphan = !isAlive(rec.ownerPid) || now - rec.startedAt > RUN_STALE_AFTER_MS;
      out.push({
        profile: p.name,
        scope: rec.scope,
        chatId: rec.chatId,
        ...(rec.threadId ? { threadId: rec.threadId } : {}),
        promptPreview: rec.promptPreview,
        startedAt: rec.startedAt,
        elapsedMs: Math.max(0, now - rec.startedAt),
        queueDepth: null,
        source: 'im',
        status: orphan ? 'orphan' : 'running',
      });
    }
  }

  out.sort((a, b) => a.startedAt - b.startedAt || a.profile.localeCompare(b.profile));
  return out;
}

/**
 * Stop one run — the exact interrupt the IM `/stop` command issues. Only works
 * for profiles this process hosts; anything else is observe-only (its runs
 * live in another daemon's memory).
 */
export function stopRun(
  supervisor: UiSupervisor,
  body: { profile?: string; scope?: string },
): { ok: boolean; interrupted: boolean } {
  if (!body.profile || !body.scope) throw new HttpError(400, 'profile and scope are required');
  const monitor = supervisor.controlsFor(body.profile)?.runsMonitor;
  if (!monitor) {
    throw new HttpError(
      409,
      `profile「${body.profile}」不由本进程托管，此控制台只能观察，无法停止它的任务`,
    );
  }
  const interrupted = monitor.interrupt(body.scope);
  return { ok: interrupted, interrupted };
}
