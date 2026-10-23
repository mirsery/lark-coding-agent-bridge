import { quotaResetAt, type QuotaWindow } from '../agent/quota';
import { foreground, type MonitorTheme } from './theme';
import { catPosition, renderCat } from './dashboard';
import type { RunRecord } from '../runtime/run-registry';
import { activityLabel, type MonitorBot, type MonitorSnapshot } from './snapshot';

export { createMonitorReader, readMonitor, type Activity, type MonitorBot, type MonitorSnapshot } from './snapshot';

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
function pad2(n: number): string { return String(n).padStart(2, '0'); }
/** Wrap by terminal cells, preserving readable task summaries in narrow windows. */
function summary(text: string, cells: number, max = 2): string[] {
  const compact = clean(text).replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/https?:\/\/[^\s]+/g, url => {
    try { const u = new URL(url); return `[${u.pathname.split('/').filter(Boolean).at(-1) ?? u.hostname}]`; } catch { return url; }
  }).trim();
  const lines: string[] = []; let row = ''; let used = 0;
  for (const ch of compact) {
    const size = width(ch);
    if (used + size > cells) {
      lines.push(row); row = ''; used = 0;
      if (lines.length === max) { lines[max - 1] = fit(lines[max - 1]!, cells - 1).trimEnd() + '…'; return lines; }
    }
    row += ch; used += size;
  }
  if (row) lines.push(row);
  return lines;
}
export function renderMonitor(s: MonitorSnapshot, columns = 110, rows = 36, color = true, frame = 0, paused = false, theme: MonitorTheme = 'terminal'): string {
  // Leave the last terminal cell and row unused to avoid automatic wrap/scroll.
  const usable = Math.max(1, columns - 1);
  const indent = columns >= 40 ? '  ' : '';
  const w = Math.max(1, usable - indent.length);
  const height = Math.max(1, rows - 1);
  const paint = (text: string, code: number) => color ? `\x1b[${foreground(code, theme)}m${text}\x1b[0m` : text;
  const cells = (text: string) => [...clean(text)].reduce((n, c) => n + width(c), 0);
  const line = (text = '', code = 37, size = w) => paint(fit(text, size), code);
  const pair = (left: string, right: string, code = 37, size = w, rightCode = 90) => {
    if (size < 8) return line(left, code, size);
    const rightCells = Math.min(Math.floor(size / 2), cells(right));
    return line(left, code, size - rightCells - 2) + '  ' + line(right, rightCode, rightCells);
  };
  // 实心方块比细线有更清楚的长度和颜色区分；未知指标保持空轨道。
  const bar = (value: number | null, size: number) => {
    const filled = value === null ? 0 : Math.round(Math.max(0, Math.min(100, value)) / 100 * size);
    return paint('█'.repeat(filled), value !== null && value >= 90 ? 91 : value !== null && value >= 70 ? 93 : 92)
      + paint('░'.repeat(size - filled), 90);
  };
  const rule = () => line('─'.repeat(w), 90);
  // Snapshot order (by profile) stays put: a bot's group never jumps when it gets busy.
  const bots = s.bots.filter(b => b.online || b.runs.length || b.agent !== 'unknown');
  const online = s.bots.filter(b => b.online).length;
  const running = s.bots.flatMap(b => b.runs).filter(r => !r.orphan).length;
  const out = [pair('LARK  /  CONTROL', paused ? 'PAUSED' : new Date(s.now).toLocaleTimeString(), 35),
    line(`${s.host.replace(/\.local$/, '')}  ·  ${s.cores} cores  ·  ${online} bots online  ·  ${running} tasks`, 90)];
  const cat = catPosition(columns, rows, frame);
  if (cat) {
    for (const art of renderCat(frame, cat.direction)) out.push(line(' '.repeat(cat.column - 1 - indent.length) + art, 36));
  }
  const m = s.metrics;
  if (m) {
    const gib = (n: number) => (n / 1024 ** 3).toFixed(1);
    const speed = (n: number) => n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + 'M/s' : (n / 1024).toFixed(1) + 'K/s';
    const ram = m.memoryTotal > 0 ? m.memoryNonFree / m.memoryTotal * 100 : null;
    const disk = m.disk && m.disk.total > 0 ? m.disk.used / m.disk.total * 100 : null;
    const io = m.io;
    const percent = (n: number | null) => n === null ? '—' : n.toFixed(1) + '%';
    const half = Math.floor((w - 4) / 2);
    const barWidth = Math.max(8, Math.min(22, half - 24));
    const gauge = (label: string, value: number | null, caption: string) => line(label, 37, 6) + bar(value, barWidth) + line('  ' + caption, 37, Math.max(0, half - 6 - barWidth));
    const heading = (label: string) => line(label + '  ' + '─'.repeat(half), 35, half);
    const row = (left: string, right: string) => left + '    ' + right;
    const spark = (key: 'read' | 'write') => {
      const values = (s.networkHistory ?? []).map(sample => sample[key]);
      if (!values.length) return '─'.repeat(12);
      const max = Math.max(1, ...values);
      return values.map(value => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor(value / max * 7))]).join('').padStart(24, ' ');
    };
    if (w >= 76 && rows >= 30) {
      out.push(row(heading('◉ CPU'), heading('▥ Memory')),
        row(gauge('Total', m.cpuPercent, percent(m.cpuPercent)), gauge('Used', ram, percent(ram))),
        row(line(`Load  ${s.load.toFixed(2)}  ·  TEMP ${m.temperatureC == null ? '—' : m.temperatureC.toFixed(1) + '°C'}`, 90, half),
          line(`RAM ${gib(m.memoryNonFree)} / ${gib(m.memoryTotal)}G  ·  free ${gib(m.memoryTotal - m.memoryNonFree)}G*`, 90, half)),
        row(line('UP ' + Math.floor(m.uptimeSeconds / 86400) + 'd ' + Math.floor(m.uptimeSeconds % 86400 / 3600) + 'h', 90, half), gauge('Free', ram === null ? null : 100 - ram, percent(ram === null ? null : 100 - ram))),
        row(heading('▥ Disk'), heading('↕ Network')),
        row(gauge('Used', disk, m.disk ? gib(m.disk.used) + 'G' : '—'),
          line(io?.network ? `NET ↓ ${speed(io.network.read)} ↑ ${speed(io.network.write)}` : 'NET —', 92, half)),
        row(line(m.disk ? `DISK ${gib(m.disk.total)}G total · ${gib(m.disk.available)}G free` : 'DISK —', 90, half),
          line(io?.disk ? `IO R ${speed(io.disk.read)} W ${speed(io.disk.write)}` : 'IO —', 90, half)),
        row(line('', 90, half), line('Down ' + spark('read'), 92, half)),
        row(line('', 90, half), line('Up   ' + spark('write'), 92, half)));
    } else {
      out.push(line(`CPU ${percent(m.cpuPercent)}  RAM ${gib(m.memoryNonFree)}/${gib(m.memoryTotal)}G*  DISK ${m.disk ? gib(m.disk.available) + 'G free' : '—'}`));
      if (rows >= 24) out.push(line(`TEMP ${m.temperatureC == null ? '—' : m.temperatureC.toFixed(1) + '°C'}  ${io?.network ? 'NET ↓ ' + speed(io.network.read) + ' ↑ ' + speed(io.network.write) : 'NET —'}`));
    }
  }
  out.push(line('机器人  ' + '─'.repeat(Math.max(0, w - 8)), 35));
  const footer = [rule(), line((paused ? 'PAUSED  ·  ' : '') + 'q 退出  ·  空格暂停  ·  r 刷新' + (m ? '    *RAM 含系统缓存' : ''), 90)];
  const bodyHeight = Math.max(0, height - out.length - footer.length);

  const resetLabel = (resets: string | undefined): string => {
    const at = quotaResetAt(resets, s.now);
    if (at === undefined) return resets ?? '—';
    const date = new Date(at);
    const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    return date.toDateString() === new Date(s.now).toDateString() ? clock : `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${clock}`;
  };
  const QUOTA_WINDOWS = [['5 小时窗口', '5h'], ['本周', '周']] as const;
  /** One window as `5h ███░░  42% · 重置 21:00`, exactly `size` cells; the bar shrinks first. */
  const quotaSegment = (short: string, window: QuotaWindow | undefined, size: number): string => {
    const tail = ` ${window ? `${Math.round(window.usedPercent)}%`.padStart(4) : '   —'} · 重置 ${window ? resetLabel(window.resets) : '—'}`;
    const room = size - 3 - cells(tail);
    const barWidth = room >= 4 ? Math.min(10, room) : 0;
    return line(short, 37, Math.min(3, size)) + bar(window ? window.usedPercent : null, barWidth)
      + line(tail, window && window.usedPercent >= 90 ? 91 : 90, Math.max(0, size - 3 - barWidth));
  };
  /**
   * The bot's own lines, richest first: 0 = title, Sponsor, both quota
   * windows; 1 = title and one compact quota line; 2 = title only.
   */
  const header = (bot: MonitorBot, inner: number, level: number): string[] => {
    const active = bot.runs.filter(r => !r.orphan).length;
    const state = !bot.online ? 'OFFLINE' : active ? `WORKING · ${active} 个会话` : 'IDLE';
    const lines = [pair(`${bot.online ? '●' : '○'} ${bot.name} / ${bot.agent}`, state, bot.online ? 36 : 90, inner, active ? 92 : 90)];
    const sub = bot.subscription;
    if (!sub || level >= 2) return lines;
    const windows = QUOTA_WINDOWS.map(([label, short]) => [short, sub.quota?.windows.find(window => window.label === label)] as const);
    const sponsor = `Sponsor: ${sub.sponsor ?? (sub.loading ? '读取中…' : '—')}`;
    const hot = Boolean(sub.quota?.blocked) || windows.some(([, window]) => window && window.usedPercent >= 90);
    if (level === 1) {
      const usage = sub.quota ? windows.map(([short, window]) => `${short} ${window ? Math.round(window.usedPercent) + '%' : '—'}`).join(' · ')
        : sub.loading ? '额度读取中…' : '额度 —';
      lines.push(line(`${sub.quota?.blocked ? '额度已用尽 · ' : ''}${usage}  ·  ${sponsor}`, hot ? 91 : 90, inner));
      return lines;
    }
    lines.push(line(sponsor, 90, inner));
    if (!sub.quota && sub.loading) lines.push(line('额度读取中…', 90, inner));
    else {
      const half = Math.floor((inner - 3) / 2);
      if (half >= 31) lines.push(windows.map(([short, window], i) => quotaSegment(short, window, i ? inner - 3 - half : half)).join('   '));
      else for (const [short, window] of windows) lines.push(quotaSegment(short, window, inner));
    }
    if (sub.quota?.blocked) lines.push(line('额度已用尽', 91, inner));
    return lines;
  };
  const origin = (run: RunRecord, size: number): string => {
    if (!run.chatType && !run.actorName) return fit('来源待同步', size).trimEnd();
    const place = run.chatType === 'p2p' ? '私聊' : run.chatName || '群名待同步';
    const person = run.actorName ? '@' + run.actorName : '发起人待同步';
    const personSize = Math.min(Math.floor((size - 3) / 2), cells(person));
    return fit(place, Math.max(0, size - personSize - 3)).trimEnd() + ' · ' + fit(person, Math.max(0, personSize)).trimEnd();
  };
  type Run = MonitorBot['runs'][number];
  const session = (run: Run, inner: number, previewLines: number, withSource = true): string[] => {
    const side = inner >= 70 && withSource;
    const source = origin(run, side ? Math.min(40, Math.floor(inner / 2)) : Math.max(1, inner - 2));
    const previews = summary(run.promptPreview || '任务执行中', Math.max(1, inner - 2 - (side ? cells(source) + 2 : 0)), previewLines);
    const result = [pair('▸ ' + (run.orphan ? '已中断 / 过期' : activityLabel(run.activity)), age(s.now - run.startedAt), run.orphan ? 33 : 90, inner)];
    result.push(...previews.map((text, i) => side ? pair('  ' + text, i === 0 ? source : '', 37, inner) : line('  ' + text, 37, inner)));
    if (!side && withSource) result.push(line('  ' + source, 90, inner));
    return result;
  };
  /** Sessions in `room` lines; the first one may give up the `+N` reserve and its source row so something is always shown. */
  const sessions = (bot: MonitorBot, inner: number, room: number): { lines: string[]; shown: number } => {
    if (room < 1) return { lines: [], shown: 0 };
    if (!bot.runs.length) return { lines: [line(bot.online ? '等待新任务' : '未运行', 90, inner)], shown: 0 };
    const lines: string[] = [];
    let shown = 0;
    for (const run of bot.runs) {
      const gap = shown ? 1 : 0;
      const reserve = shown + 1 < bot.runs.length ? 1 : 0;
      const tries = [[2, reserve, true], [1, reserve, true], [1, reserve, false], [1, 0, true], [1, 0, false]] as const;
      let block: string[] | undefined;
      for (const [previewLines, keep, withSource] of shown ? tries.slice(0, 2) : tries) {
        const candidate = session(run, inner, previewLines, withSource);
        if (lines.length + gap + candidate.length + keep <= room) { block = candidate; break; }
      }
      if (!block) break;
      if (gap) lines.push(line('┈'.repeat(inner), 90, inner));
      lines.push(...block);
      shown++;
    }
    if (shown < bot.runs.length && lines.length < room) lines.push(line(`+${bot.runs.length - shown} 个会话 · 放大窗口查看`, 90, inner));
    return { lines, shown };
  };
  // Only the full header (level 0) is set off from the sessions by a rule.
  const headed = (bot: MonitorBot, inner: number, level: number) => {
    const head = header(bot, inner, level);
    return level === 0 ? [...head, line('─'.repeat(inner), 90, inner)] : head;
  };
  const naturalHeight = (bot: MonitorBot, inner: number, level: number) =>
    2 + headed(bot, inner, level).length + sessions(bot, inner, 1000).lines.length;
  // One session (status + preview), plus the `+N 个会话` note when there are more.
  const minimumHeight = (bot: MonitorBot, inner: number, level: number) =>
    2 + headed(bot, inner, level).length + (bot.runs.length ? (bot.runs.length > 1 ? 3 : 2) : 1);
  /** A bot's bordered group, exactly `outer` cells wide and at most `budget` rows (padded to it with `fill`). */
  const group = (bot: MonitorBot, outer: number, budget: number, fill: boolean): string[] => {
    const framed = outer >= 8;
    const inner = framed ? outer - 4 : outer;
    const frame = framed ? 2 : 0;
    let body: string[] = [];
    for (const level of [0, 1, 2]) {
      const head = headed(bot, inner, level);
      const rest = sessions(bot, inner, budget - frame - head.length);
      body = [...head, ...rest.lines];
      if (body.length + frame <= budget && (rest.shown || (!bot.runs.length && rest.lines.length) || level === 2)) break;
    }
    body = body.slice(0, Math.max(0, budget - frame));
    if (fill) while (body.length < budget - frame) body.push(line('', 37, inner));
    if (!framed) return body;
    const edge = bot.online ? 36 : 90;
    const border = (left: string, right: string) => paint(left + '─'.repeat(outer - 2) + right, edge);
    return [border('╭', '╮'), ...body.map(text => paint('│ ', edge) + text + paint(' │', edge)), border('╰', '╯')];
  };

  const gap = 2;
  const perRow = w >= 120 && bots.length > 1 ? Math.max(1, Math.min(bots.length, Math.floor((w + gap) / (56 + gap)))) : 1;
  const outer = Math.floor((w - (perRow - 1) * gap) / perRow);
  const inner = outer >= 8 ? outer - 4 : outer;
  let hidden = 0;
  if (perRow > 1) {
    // Side by side: each row of groups shares the height left, every column filled to the bottom.
    let used = 0;
    for (let i = 0; i < bots.length; i += perRow) {
      const rowsLeft = Math.ceil((bots.length - i) / perRow);
      const remaining = bodyHeight - used - (rowsLeft > 1 ? 1 : 0);
      const budget = rowsLeft > 1 ? Math.floor(remaining / rowsLeft) : remaining;
      const row = bots.slice(i, i + perRow);
      if (budget < Math.max(...row.map(bot => minimumHeight(bot, inner, 2)))) { hidden = bots.length - i; break; }
      const blocks = row.map(bot => group(bot, outer, budget, true));
      const groupHeight = Math.max(...blocks.map(b => b.length));
      for (let r = 0; r < groupHeight; r++) {
        out.push(blocks.map(b => { const text = b[r] ?? ''; return text + ' '.repeat(Math.max(0, outer - cells(text))); }).join(' '.repeat(gap)).trimEnd());
      }
      used += groupHeight;
    }
  } else {
    // Stacked: every bot gets its minimum first, then busy bots take what they need, in order.
    let level = [0, 1, 2].find(l => bots.reduce((n, bot) => n + minimumHeight(bot, inner, l), 0) <= bodyHeight);
    let shownBots = bots;
    if (level === undefined) {
      level = 2;
      let room = bodyHeight;
      shownBots = [];
      for (const bot of bots) {
        // Keep a row for the `+N` note, except when that would hide every bot.
        const need = minimumHeight(bot, inner, 2) + (shownBots.length ? 1 : 0);
        if (need > room) break;
        shownBots.push(bot); room -= minimumHeight(bot, inner, 2);
      }
      hidden = bots.length - shownBots.length;
    }
    const budgets = shownBots.map(bot => minimumHeight(bot, inner, level));
    let spare = bodyHeight - budgets.reduce((a, b) => a + b, 0) - (hidden ? 1 : 0);
    shownBots.forEach((bot, i) => {
      const extra = Math.max(0, Math.min(spare, naturalHeight(bot, inner, 0) - budgets[i]!));
      budgets[i]! += extra; spare -= extra;
    });
    shownBots.forEach((bot, i) => out.push(...group(bot, outer, budgets[i]!, false)));
  }
  if (!bots.length && bodyHeight) out.push(line('等待 bot 上线', 90));
  if (hidden && out.length < height - footer.length) out.push(line(`+${hidden} 个 bot 未显示 · 放大窗口或用 --profile`, 90));
  out.push(...footer);
  return out.slice(0, height).map(text => indent + text).join('\n');
}
