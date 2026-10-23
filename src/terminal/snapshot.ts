import { loadRootConfig } from '../config/profile-store';
import { createSubscriptionReader, type MonitorSubscription } from './subscription';
import { createHostSampler, type HostMetrics } from './host';
import { open, readdir } from 'node:fs/promises';
import { cpus, hostname, loadavg } from 'node:os';
import { join } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import { isAlive, readAndPrune, type ProcessEntry } from '../runtime/registry';
import { readRunRecords, RUN_STALE_AFTER_MS, type RunRecord } from '../runtime/run-registry';

/**
 * The fleet snapshot behind the terminal monitor and the web console's status
 * page: bots, their subscription, their runs with latest activity, and host
 * metrics. Data only — rendering lives with each consumer.
 */
export interface Activity { ts: number; event: string; phase: string; tool?: string; traceId?: string; runId?: string; scope?: string }
export interface MonitorBot { profile: string; name: string; agent: string; pid?: number; online: boolean; subscription?: MonitorSubscription; activity?: Activity; runs: Array<RunRecord & { orphan: boolean; activity?: Activity }> }
export interface MonitorSnapshot { now: number; host: string; cores: number; load: number; bots: MonitorBot[]; metrics?: HostMetrics }

/** What a run is doing right now, in words both the terminal and the console show. */
export function activityLabel(a?: Activity): string {
  if (a?.event === 'tool-in-flight') return a.tool ?? '工具执行';
  if (a?.event === 'subagent-activity') return a.tool ? `子任务 · ${a.tool}` : '子任务';
  return '处理中';
}

/** Bounded log read: never load a growing multi-gigabyte log into memory. */
interface LogCache { name: string; size: number; mtime: number; events: Activity[] }
async function recentActivity(dir: string, cache: Map<string, LogCache>): Promise<Activity[]> {
  try {
    const names = (await readdir(dir)).filter(n => /^bridge-\d{8}\.jsonl$/.test(n)).sort();
    const name = names.at(-1);
    if (!name) return [];
    const file = await open(join(dir, name), 'r');
    try {
      const info = await file.stat();
      const size = info.size;
      const cached = cache.get(dir);
      if (cached?.name === name && cached.size === size && cached.mtime === info.mtimeMs) return cached.events;
      const start = Math.max(0, size - 256 * 1024);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      if (start) lines.shift();
      const out: Activity[] = [];
      for (const line of lines) {
        try {
          const r = JSON.parse(line) as Record<string, unknown>;
          const ts = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
          if (!Number.isFinite(ts) || typeof r.event !== 'string' || typeof r.phase !== 'string') continue;
          out.push({ ts, event: r.event, phase: r.phase,
            tool: typeof r.tool === 'string' ? r.tool : undefined,
            traceId: typeof r.traceId === 'string' ? r.traceId : undefined,
            runId: typeof r.runId === 'string' ? r.runId : undefined,
            scope: typeof r.scope === 'string' ? r.scope : undefined });
        } catch { /* partial writes and malformed lines are skipped */ }
      }
      cache.set(dir, { name, size, mtime: info.mtimeMs, events: out });
      return out;
    } finally { await file.close(); }
  } catch { return []; }
}

export function createMonitorReader(intervalMs = 10_000) {
  const cache = new Map<string, LogCache>();
  const readSubscription = createSubscriptionReader();
  const sampleHost = createHostSampler(intervalMs);
  return async (rootDir: string, profile?: string, now = Date.now(), waitForSubscription = false): Promise<MonitorSnapshot> => {
  const root = await loadRootConfig(join(rootDir, 'config.json')).catch(() => undefined);
  const entries = readAndPrune(join(rootDir, 'registry', 'processes.json'));
  let dirs: string[] = [];
  try { dirs = (await readdir(join(rootDir, 'profiles'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); } catch { /* no profiles yet */ }
  const names = [...new Set([...dirs, ...entries.map(e => e.profileName)])].filter(n => !profile || n === profile).sort();
  const bots = await Promise.all(names.map(async name => {
    const paths = resolveAppPaths({ rootDir, profile: name });
    const records = await readRunRecords(paths.runsFile);
    const events = await recentActivity(paths.logsDir, cache);
    const entry: ProcessEntry | undefined = entries.find(e => e.profileName === name && isAlive(e.pid));
    const config = root?.profiles[name];
    const subscription = config ? await readSubscription(name, config, paths.profileDir, now, waitForSubscription) : undefined;
    const activity = events.at(-1);
    return { profile: name, name: entry?.botName ?? name, agent: entry?.agentKind ?? config?.agentKind ?? 'unknown', pid: entry?.pid,
      online: Boolean(entry), activity, subscription,
      runs: records.map(rec => {
        const trace = events.find(e => e.runId === rec.runId)?.traceId;
        const activity = events.filter(e => e.ts >= rec.startedAt && (e.runId === rec.runId || (trace && e.traceId === trace) || (!e.traceId && !e.runId && e.scope === rec.scope))).at(-1);
        return { ...rec, orphan: !isAlive(rec.ownerPid) || now - rec.startedAt > RUN_STALE_AFTER_MS, activity };
      }).sort((a, b) => Number(a.orphan) - Number(b.orphan) || a.startedAt - b.startedAt) };
  }));
  const metrics = await sampleHost(now);
  return { now, host: hostname(), cores: cpus().length, load: loadavg()[0] ?? 0, bots, metrics };
  };
}
export async function readMonitor(rootDir: string, profile?: string, now = Date.now()): Promise<MonitorSnapshot> {
  return createMonitorReader()(rootDir, profile, now, true);
}

