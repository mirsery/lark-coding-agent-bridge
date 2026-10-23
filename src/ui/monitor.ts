import { quotaResetAt } from '../agent/quota';
import { resolveAppPaths } from '../config/app-paths';
import type { HostMetrics } from '../terminal/host';
import { activityLabel, type MonitorSnapshot } from '../terminal/snapshot';
import { listRuns, type RunView } from './runs';
import type { UiSupervisor } from './types';

/** Reads the fleet snapshot the terminal monitor draws; injectable so tests never probe a real CLI. */
export type MonitorReader = (rootDir: string, now: number) => Promise<MonitorSnapshot>;

/** One session on the console's status page: the tasks-panel row plus who started it and what it is doing. */
export interface MonitorRunView extends RunView {
  chatType?: 'p2p' | 'group';
  actorName?: string;
  /** The run's latest step (`处理中`, a tool name, `子任务 · …`), as the terminal shows it. */
  activity: string;
  activityAt?: number;
}

export interface MonitorQuotaWindow {
  label: string;
  usedPercent: number;
  /** The reset time as the CLI words it; `resetAt` is the parsed instant when it can be read. */
  resets?: string;
  resetAt?: number;
}

/** One bot's group: identity, account, quota and its sessions. */
export interface MonitorBotView {
  profile: string;
  name: string;
  agent: string;
  online: boolean;
  /** Its runs live in this process, so the console can stop them. */
  hosted: boolean;
  sponsor?: string;
  quota?: { windows: MonitorQuotaWindow[]; blocked?: boolean };
  /** The first account reading is still in flight. */
  quotaLoading: boolean;
  runs: MonitorRunView[];
}

export interface MonitorView {
  now: number;
  host: string;
  cores: number;
  load: number;
  metrics?: HostMetrics;
  bots: MonitorBotView[];
}

/**
 * The status page: every bot in a stable order with its Sponsor, quota and
 * sessions, plus host metrics. Bots, account and activity come from the same
 * snapshot as the terminal monitor; the runs themselves come from the tasks
 * panel (`listRuns`), which reads hosted profiles from memory and knows their
 * queue depth.
 */
export async function monitorView(
  supervisor: UiSupervisor,
  read: MonitorReader,
  rootDir?: string,
  now: number = Date.now(),
): Promise<MonitorView> {
  const [snap, runs] = await Promise.all([
    read(resolveAppPaths({ rootDir }).rootDir, now),
    listRuns(supervisor, rootDir, now),
  ]);
  const statuses = new Map(supervisor.list().map((s) => [s.profile, s]));
  const profiles = [...new Set([...snap.bots.map((b) => b.profile), ...runs.map((r) => r.profile)])];

  const bots = profiles.flatMap((profile): MonitorBotView[] => {
    const bot = snap.bots.find((b) => b.profile === profile);
    const status = statuses.get(profile);
    const own = runs.filter((r) => r.profile === profile);
    const online = Boolean(bot?.online || status);
    const agent = status?.agentKind ?? bot?.agent ?? 'unknown';
    if (!online && !own.length && agent === 'unknown') return [];
    const reading = bot?.subscription;
    return [{
      profile,
      name: status?.botName ?? bot?.name ?? profile,
      agent,
      online,
      hosted: Boolean(supervisor.controlsFor(profile)?.runsMonitor),
      ...(reading?.sponsor ? { sponsor: reading.sponsor } : {}),
      ...(reading?.quota ? {
        quota: {
          windows: reading.quota.windows.map((w) => {
            const resetAt = quotaResetAt(w.resets, now);
            return { label: w.label, usedPercent: w.usedPercent, ...(w.resets ? { resets: w.resets } : {}), ...(resetAt !== undefined ? { resetAt } : {}) };
          }),
          ...(reading.quota.blocked ? { blocked: true } : {}),
        },
      } : {}),
      quotaLoading: Boolean(reading?.loading && !reading.quota),
      runs: own.map((run): MonitorRunView => {
        // One run per session scope at a time; the durable record carries who started it.
        const record = bot?.runs.find((r) => r.scope === run.scope);
        const chatName = run.chatName ?? record?.chatName;
        return {
          ...run,
          ...(chatName ? { chatName } : {}),
          ...(record?.chatType ? { chatType: record.chatType } : {}),
          ...(record?.actorName ? { actorName: record.actorName } : {}),
          activity: activityLabel(record?.activity),
          ...(record?.activity ? { activityAt: record.activity.ts } : {}),
        };
      }).sort((a, b) => Number(a.status === 'orphan') - Number(b.status === 'orphan') || a.startedAt - b.startedAt),
    }];
  });

  return {
    now: snap.now,
    host: snap.host.replace(/\.local$/, ''),
    cores: snap.cores,
    load: snap.load,
    ...(snap.metrics ? { metrics: snap.metrics } : {}),
    bots,
  };
}
