import { open, readdir } from 'node:fs/promises';
import { cpus, hostname, loadavg } from 'node:os';
import { join } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import { isAlive, readAndPrune, type ProcessEntry } from '../runtime/registry';
import { readRunRecords, RUN_STALE_AFTER_MS, type RunRecord } from '../runtime/run-registry';

interface Activity { ts: number; event: string; phase: string; tool?: string; traceId?: string; runId?: string; scope?: string }
export interface MonitorBot { profile: string; name: string; agent: string; pid?: number; online: boolean; activity?: Activity; runs: Array<RunRecord & { orphan: boolean; activity?: Activity }> }
export interface MonitorSnapshot { now: number; host: string; cores: number; load: number; bots: MonitorBot[] }

/** Bounded log read: never load a growing multi-gigabyte log into memory. */
async function recentActivity(dir: string): Promise<Activity[]> {
  try {
    const names = (await readdir(dir)).filter(n => /^bridge-\d{8}\.jsonl$/.test(n)).sort();
    const name = names.at(-1);
    if (!name) return [];
    const file = await open(join(dir, name), 'r');
    try {
      const size = (await file.stat()).size;
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
      return out;
    } finally { await file.close(); }
  } catch { return []; }
}

export async function readMonitor(rootDir: string, profile?: string, now = Date.now()): Promise<MonitorSnapshot> {
  const entries = readAndPrune(join(rootDir, 'registry', 'processes.json'));
  let dirs: string[] = [];
  try { dirs = (await readdir(join(rootDir, 'profiles'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); } catch { /* no profiles yet */ }
  const names = [...new Set([...dirs, ...entries.map(e => e.profileName)])].filter(n => !profile || n === profile).sort();
  const bots = await Promise.all(names.map(async name => {
    const paths = resolveAppPaths({ rootDir, profile: name });
    const records = await readRunRecords(paths.runsFile);
    const events = await recentActivity(paths.logsDir);
    const entry: ProcessEntry | undefined = entries.find(e => e.profileName === name && isAlive(e.pid));
    const activity = events.at(-1);
    return { profile: name, name: entry?.botName ?? name, agent: entry?.agentKind ?? 'unknown', pid: entry?.pid,
      online: Boolean(entry), activity,
      runs: records.map(rec => {
        const trace = events.find(e => e.runId === rec.runId)?.traceId;
        const activity = events.filter(e => e.ts >= rec.startedAt && (e.runId === rec.runId || (trace && e.traceId === trace) || (!e.traceId && !e.runId && e.scope === rec.scope))).at(-1);
        return { ...rec, orphan: !isAlive(rec.ownerPid) || now - rec.startedAt > RUN_STALE_AFTER_MS, activity };
      }).sort((a, b) => a.startedAt - b.startedAt) };
  }));
  return { now, host: hostname(), cores: cpus().length, load: loadavg()[0] ?? 0, bots };
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
  if (!a) return 'Awaiting telemetry';
  if (a.event === 'tool-in-flight') return `TOOL / ${a.tool ?? 'working'}`;
  if (a.event === 'tool-done') return 'ACTIVE / tool finished';
  return `${a.phase} / ${a.event}`;
}
export function renderMonitor(s: MonitorSnapshot, columns = 110, rows = 36, color = true): string {
  const w = Math.max(24, Math.min(columns - 2, 138));
  const paint = (t: string, c: number) => color ? `\x1b[${c}m${t}\x1b[0m` : t;
  const line = (t = '', c = 37) => paint(`│${fit(t, w)}│`, c);
  const online = s.bots.filter(b => b.online).length;
  const running = s.bots.flatMap(b => b.runs).filter(r => !r.orphan).length;
  const out = [paint('╭' + '─'.repeat(w) + '╮', 36), line('  L A R K   //   M I S S I O N   C O N T R O L', 36),
    line(`  ${clean(s.host)}   ${new Date(s.now).toLocaleTimeString()}   LIVE`, 90),
    line(`  ONLINE ${online}   ACTIVE ${running}   LOAD ${s.load.toFixed(2)} / ${s.cores} cores`, 35),
    paint('├' + '─'.repeat(w) + '┤', 36)];
  let hidden = 0;
  const ordered = [...s.bots].sort((a, b) => Number(b.runs.some(r => !r.orphan)) - Number(a.runs.some(r => !r.orphan)) || Number(b.online) - Number(a.online));
  for (const bot of ordered) {
    const budget = Math.max(10, rows) - 4 - out.length;
    if (budget < 5) { hidden++; continue; }
    const active = bot.runs.filter(r => !r.orphan).length;
    const state = !bot.online ? 'OFFLINE' : active ? 'WORKING' : 'READY';
    const block = [line(`  ${bot.online ? '●' : '○'} ${bot.name}  [${bot.agent}]  ${state}  PID ${bot.pid ?? '—'}`, bot.online ? 32 : 90)];
    let shown = 0;
    for (const run of bot.runs) {
      if (block.length + 3 + 3 > budget) break;
      shown++;
      block.push(line(`    ${run.orphan ? 'STALE' : '▶ RUN'} ${run.runId.slice(0, 8)}  ${age(s.now - run.startedAt)}  ${run.orphan ? 'owner exited / expired' : activityLabel(run.activity)}`, run.orphan ? 33 : 36));
      block.push(line(`      ${run.promptPreview}`));
      block.push(line(`      scope ${run.scope}`, 90));
    }
    if (shown < bot.runs.length) block.push(line(`    +${bot.runs.length - shown} more tasks · enlarge terminal or use --once`, 33));
    if (!bot.runs.length) block.push(line('    No active tasks', 90));
    block.push(line(`    LAST ${activityLabel(bot.activity)}${bot.activity ? ' · ' + age(s.now - bot.activity.ts) + ' ago' : ''}`, 90), line());
    if (out.length + block.length > Math.max(10, rows) - 4) { hidden++; continue; }
    out.push(...block);
  }
  if (!s.bots.length) out.push(line('  No bridge profiles found. Start a bot to see live tasks.', 90));
  if (hidden) out.push(line(`  +${hidden} bot(s) below fold · enlarge terminal or use --profile`, 33));
  out.push(paint('├' + '─'.repeat(w) + '┤', 36), line('  q quit   space pause   r refresh   // real activity, no estimated %', 90), paint('╰' + '─'.repeat(w) + '╯', 36));
  return out.join('\n');
}
