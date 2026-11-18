import { spawn } from 'node:child_process';
import { TerminalTheme, type MonitorTheme } from '../../terminal/theme';
import { catPatch, conversationLabel } from '../../terminal/dashboard';
import type { MonitorSnapshot } from '../../terminal/monitor';
import { resolveAppPaths } from '../../config/app-paths';
import { createMonitorReader, renderMonitor, renderCodingBoard } from '../../terminal/monitor';

export function monitorFrame(text: string): string {
  // Overwrite in place: ED2 may archive the cleared screen in iTerm scrollback.
  // Explicit CRLF also works when raw mode disables output newline translation.
  return '\x1b[H' + text.replace(/\r?\n/g, '\x1b[K\r\n') + '\x1b[K\x1b[J';
}

/** Coding-board navigation; returns true when the view changed. `o` opens the task's chat in the Feishu / Lark client. */
export function boardKey(text: string, view: { cursor: number; expanded: boolean }, snapshot?: MonitorSnapshot, open: (url: string) => void = openUrl): boolean {
  const tasks = snapshot?.codingBoard?.tasks ?? [];
  if (text === 'j' || text === '\x1b[B') { view.cursor = Math.min(view.cursor + 1, Math.max(0, tasks.length - 1)); return true; }
  if (text === 'k' || text === '\x1b[A') { view.cursor = Math.max(0, view.cursor - 1); return true; }
  if (text === '\r' || text === '\n') { view.expanded = !view.expanded; return true; }
  if (text === 'o') {
    const sessions = tasks[view.cursor]?.worktrees.flatMap(w => w.sessions) ?? [];
    const url = (sessions.find(s => s.running && s.chatUrl) ?? sessions.find(s => s.chatUrl))?.chatUrl;
    if (url) open(url);
    return false;
  }
  return false;
}

function openUrl(url: string): void {
  if (!/^https:\/\/applink\.(feishu\.cn|larksuite\.com)\//.test(url)) return;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? undefined : 'xdg-open';
  if (!command) return;
  try { spawn(command, [url], { stdio: 'ignore', detached: true }).unref(); } catch { /* no opener available */ }
}

export async function runMonitor(opts: { profile?: string; interval?: string; once?: boolean; json?: boolean; color?: boolean; animation?: boolean; theme?: string }): Promise<void> {
  const seconds = Number(opts.interval ?? 10);
  if (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 60) throw new Error('--interval must be between 0.5 and 60 seconds');
  const requestedTheme = opts.theme ?? 'auto';
  if (!['auto', 'light', 'dark'].includes(requestedTheme)) throw new Error('--theme must be auto, light or dark');
  const terminalTheme = new TerminalTheme();
  const theme = (): MonitorTheme => requestedTheme === 'auto' ? terminalTheme.mode : requestedTheme as MonitorTheme;
  const readMonitor = createMonitorReader(seconds * 1000);
  const root = resolveAppPaths().rootDir;
  if (opts.once || opts.json || !process.stdout.isTTY || !process.stdin.isTTY) {
    const snap = await readMonitor(root, opts.profile, Date.now(), true);
    console.log(opts.json ? JSON.stringify(snap, null, 2) : renderMonitor(snap, process.stdout.columns || 110, 1000, false));
    return;
  }
  let board = false; const boardView = { cursor: 0, expanded: false };
  let paused = false; let stopped = false; let timer: NodeJS.Timeout | undefined;
  let animation: NodeJS.Timeout | undefined;
  let snapshot: MonitorSnapshot | undefined;
  let frame = 0;
  const color = opts.color !== false && !process.env.NO_COLOR;
  const draw = () => {
    if (stopped || !snapshot) return;
    process.stdout.write(monitorFrame(board ? renderCodingBoard(snapshot, process.stdout.columns, process.stdout.rows, boardView, color, theme()) : renderMonitor(snapshot, process.stdout.columns, process.stdout.rows, color, frame, paused, theme())));
  };
  const raw = process.stdin.isRaw;
  const restore = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (animation) clearInterval(animation);
    process.stdin.off('data', key); process.stdin.setRawMode(raw); process.stdin.pause();
    process.off('SIGINT', restore); process.off('SIGTERM', restore);
    process.stdout.off('resize', resize);
    process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  };
  let refreshing = false;
  const refresh = async () => {
    if (stopped || refreshing) return;
    refreshing = true;
    try {
      const snap = await readMonitor(root, opts.profile);
      snapshot = snap;
      draw();
    } finally { refreshing = false; }
  };
  const tick = async () => {
    if (color && requestedTheme === 'auto') process.stdout.write('\x1b]11;?\x07');
    try { if (!paused) await refresh(); } catch (err) { restore(); console.error((err as Error).message); }
    if (!stopped) timer = setTimeout(() => void tick(), seconds * 1000);
  };
  const key = (data: Buffer) => { const before = terminalTheme.mode; const text = terminalTheme.input(data.toString()); if (before !== terminalTheme.mode) draw(); if (text === 'q' || text === '\x03') restore(); else if (text === ' ') { paused = !paused; draw(); } else if (text === 'b') { board = !board; draw(); } else if (board && boardKey(text, boardView, snapshot)) draw(); else if (text === 'r') void refresh().catch(restore); };
  const resize = () => { draw(); };
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', key);
  process.on('SIGINT', restore); process.on('SIGTERM', restore); process.stdout.on('resize', resize);
  if (opts.animation !== false) animation = setInterval(() => {
    if (stopped || paused || !snapshot || board) return;
    frame++;
    process.stdout.write(catPatch(process.stdout.columns, process.stdout.rows, frame, color, theme(), conversationLabel(snapshot)));
  }, 500);
  await tick();
}
