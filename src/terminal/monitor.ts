import { createHostSampler, type HostMetrics } from './host';
import { open, readdir } from 'node:fs/promises';
import { cpus, hostname, loadavg } from 'node:os';
import { join } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import { isAlive, readAndPrune, type ProcessEntry } from '../runtime/registry';
import { readRunRecords, RUN_STALE_AFTER_MS, type RunRecord } from '../runtime/run-registry';

interface Activity { ts: number; event: string; phase: string; tool?: string; traceId?: string; runId?: string; scope?: string }
export interface MonitorBot { profile: string; name: string; agent: string; pid?: number; online: boolean; activity?: Activity; runs: Array<RunRecord & { orphan: boolean; activity?: Activity }> }
export interface MonitorSnapshot { now: number; host: string; cores: number; load: number; bots: MonitorBot[]; metrics?: HostMetrics }

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

export function createMonitorReader() {
  const cache = new Map<string, LogCache>();
  const sampleHost = createHostSampler();
  return async (rootDir: string, profile?: string, now = Date.now()): Promise<MonitorSnapshot> => {
  const entries = readAndPrune(join(rootDir, 'registry', 'processes.json'));
  let dirs: string[] = [];
  try { dirs = (await readdir(join(rootDir, 'profiles'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); } catch { /* no profiles yet */ }
  const names = [...new Set([...dirs, ...entries.map(e => e.profileName)])].filter(n => !profile || n === profile).sort();
  const bots = await Promise.all(names.map(async name => {
    const paths = resolveAppPaths({ rootDir, profile: name });
    const records = await readRunRecords(paths.runsFile);
    const events = await recentActivity(paths.logsDir, cache);
    const entry: ProcessEntry | undefined = entries.find(e => e.profileName === name && isAlive(e.pid));
    const activity = events.at(-1);
    return { profile: name, name: entry?.botName ?? name, agent: entry?.agentKind ?? 'unknown', pid: entry?.pid,
      online: Boolean(entry), activity,
      runs: records.map(rec => {
        const trace = events.find(e => e.runId === rec.runId)?.traceId;
        const activity = events.filter(e => e.ts >= rec.startedAt && (e.runId === rec.runId || (trace && e.traceId === trace) || (!e.traceId && !e.runId && e.scope === rec.scope))).at(-1);
        return { ...rec, orphan: !isAlive(rec.ownerPid) || now - rec.startedAt > RUN_STALE_AFTER_MS, activity };
      }).sort((a, b) => Number(a.orphan) - Number(b.orphan) || a.startedAt - b.startedAt) };
  }));
  return { now, host: hostname(), cores: cpus().length, load: loadavg()[0] ?? 0, bots, metrics: await sampleHost(now) };
  };
}
export async function readMonitor(rootDir: string, profile?: string, now = Date.now()): Promise<MonitorSnapshot> {
  return createMonitorReader()(rootDir, profile, now);
}

/** Remove terminal control sequences from all untrusted labels and prompts. */
export function clean(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}
function width(char: string): number { const c = char.codePointAt(0) ?? 0; return c >= 0x1100 && (c <= 0x115f || c >= 0x2e80) ? 2 : 1; }
export function fit(text: string, cells: number): string {
  let out = ''; let used = 0;
  for (const ch of clean(text)) { const w = width(ch); if (used + w > cells) break; out += ch; used += w; }
  return out + ' '.repeat(Math.max(0, cells - used));
}
function age(ms: number): string { const s = Math.floor(Math.max(0, ms) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`; }
function activityLabel(a?: Activity): string {
  if (a?.event === 'tool-in-flight') return a.tool ?? '工具执行';
  return '处理中';
}
/** Wrap by terminal cells, preserving readable task summaries in narrow windows. */
function summary(text: string, cells: number): string[] {
  const compact = clean(text).replace(/https?:\/\/[^\s]+/g, url => {
    try { const u = new URL(url); return `[${u.pathname.split('/').filter(Boolean).at(-1) ?? u.hostname}]`; } catch { return url; }
  }).trim();
  const lines: string[] = []; let row = ''; let used = 0;
  for (const ch of compact) {
    const size = width(ch);
    if (used + size > cells) {
      lines.push(row); row = ''; used = 0;
      if (lines.length === 2) { lines[1] = fit(lines[1]!, cells - 1).trimEnd() + '…'; return lines; }
    }
    row += ch; used += size;
  }
  if (row) lines.push(row);
  return lines;
}
export function renderMonitor(s: MonitorSnapshot, columns = 110, rows = 36, color = true): string {
  const w = Math.max(24, Math.min(columns - 4, 106));
  const paint = (text: string, code: number) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const line = (text = '', code = 37) => '  ' + paint(fit(text, w), code);
  const pair = (left: string, right: string, code = 37) => {
    const rightCells = Math.min(Math.floor(w / 2), [...clean(right)].reduce((n, c) => n + width(c), 0));
    return '  ' + paint(fit(left, w - rightCells - 2), code) + '  ' + paint(fit(right, rightCells), 90);
  };
  const rule = () => line('─'.repeat(w), 90);
  const online = s.bots.filter(b => b.online).length;
  const running = s.bots.flatMap(b => b.runs).filter(r => !r.orphan).length;
  const out = [line(), pair('LARK  /  CONTROL', new Date(s.now).toLocaleTimeString(), 36),
    pair(`${s.host.replace(/\.local$/, '')}  ·  ${online} bots online  ·  ${running} tasks`, 'LIVE', 90), line()];
  const m = s.metrics;
  if (m) {
    const gib = (n: number) => (n / 1024 ** 3).toFixed(1);
    const up = Math.floor(m.uptimeSeconds / 86400) + 'd ' + Math.floor(m.uptimeSeconds % 86400 / 3600) + 'h';
    const metrics = [`CPU ${m.cpuPercent === null ? '—' : m.cpuPercent.toFixed(0) + '%'}`, `RAM ${gib(m.memoryNonFree)}/${gib(m.memoryTotal)}G*`,
      `DISK ${m.disk ? gib(m.disk.available) + 'G free' : '—'}`, `UP ${up}`];
    // Small terminals use two rows instead of clipping away host metrics.
    if (w < 72) { out.push(line(metrics.slice(0, 2).join('    ')), line(metrics.slice(2).join('    '))); }
    else out.push(line(metrics.join('    ')));
  }
  out.push(line(), rule());
  let hidden = 0;
  const ordered = [...s.bots].filter(b => b.online || b.runs.length || b.agent !== 'unknown')
    .sort((a, b) => Number(b.runs.some(r => !r.orphan)) - Number(a.runs.some(r => !r.orphan)) || Number(b.online) - Number(a.online));
  const limit = Math.max(14, rows) - 4;
  for (const bot of ordered) {
    if (out.length + 5 > limit) { hidden++; continue; }
    const active = bot.runs.filter(r => !r.orphan).length;
    const state = !bot.online ? 'OFFLINE' : active ? 'WORKING' : 'IDLE';
    out.push(line(), pair(`${bot.online ? '●' : '○'} ${bot.name} / ${bot.agent}`, state, bot.online ? 36 : 90));
    let shown = 0;
    for (const run of bot.runs) {
      const lines = summary(run.promptPreview, w - 4);
      if (out.length + 1 + lines.length > limit) break;
      out.push(pair('    ' + (run.orphan ? '已中断 / 过期' : activityLabel(run.activity)), age(s.now - run.startedAt), run.orphan ? 33 : 90));
      out.push(...lines.map(text => line('    ' + text)));
      shown++;
    }
    if (!bot.runs.length) out.push(line('    等待新任务', 90));
    if (shown < bot.runs.length && out.length < limit) out.push(line(`    +${bot.runs.length - shown} more tasks`, 90));
  }
  if (!ordered.length && out.length < limit) out.push(line('等待 bot 上线', 90));
  if (hidden) out.push(line(`+${hidden} bots · enlarge window or use --profile`, 90));
  out.push(line(), rule(), line('q 退出  ·  空格暂停  ·  r 刷新' + (m ? '    *RAM 含系统缓存' : ''), 90));
  return out.join('\n');
}
