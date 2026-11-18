import type { BoardJob, BoardWorktree, CodingBoardSnapshot, CodingBoardTask, Phase } from '../coding-board/snapshot';
import { clean, fit, width } from './text';
import { foreground, type MonitorTheme } from './theme';

export interface BoardView { cursor: number; expanded: boolean; offset?: number }

/** Theme colour per phase: cyan running, yellow waiting, red failing, magenta waiting on people, gray done. */
const PHASE_COLOR: Record<Phase, number> = {
  构建中: 36, 构建排队: 93, 门禁失败: 91, 'CI 失败': 91, 编码中: 92, 'CI 中': 36, 待合并: 92, '等 review': 35, 门禁通过: 92, 闲置: 90, 已关闭: 90, 已合并: 92,
};
const PHASE_ICON: Record<Phase, string> = {
  构建中: '▶', 构建排队: '◌', 门禁失败: '✗', 'CI 失败': '✗', 编码中: '●', 'CI 中': '◐', 待合并: '✓', '等 review': '◷', 门禁通过: '✓', 闲置: '·', 已关闭: '·', 已合并: '✓',
};
const JOB_ICON: Record<BoardJob['state'], [string, number]> = { running: ['▶', 36], waiting: ['◌', 93], passed: ['✓', 92], failed: ['✗', 91], interrupted: ['!', 91] };

function clock(ts: number, now: number): string {
  const d = new Date(ts), n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}
export function ago(ts: number | undefined, now: number): string {
  if (!ts) return '—';
  const m = Math.max(0, Math.floor((now - ts) / 60_000));
  return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟` : m < 1440 ? `${Math.floor(m / 60)} 小时` : `${Math.floor(m / 1440)} 天`;
}
function elapsed(ms: number): string { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }

/** Short PR summary: `#5629 已合并 5/5`, `#5559 开着`, CI counts when known. */
export function prLabel(w: BoardWorktree): string {
  const pr = w.pr;
  if (!pr) return '—';
  const state = pr.state === 'merged' ? '已合并' : pr.state === 'closed' ? '已关闭' : pr.review === 'APPROVED' ? '已批准' : pr.review === 'CHANGES_REQUESTED' ? '要修改' : '开着';
  const c = pr.state === 'open' ? pr.checks : undefined;
  const ci = c ? c.failed ? ` ✗${c.failed}` : c.pending ? ` ${c.passed}/${c.passed + c.pending}` : ` ${c.passed}/${c.passed + c.skipped}` : '';
  return `#${pr.number} ${state}${ci}`;
}

export function renderCodingBoard(s: { now: number; codingBoard?: CodingBoardSnapshot }, columns = 110, rows = 36, view: BoardView = { cursor: 0, expanded: false }, color = true, theme: MonitorTheme = 'terminal'): string {
  const usable = Math.max(1, columns - 1);
  const indent = columns >= 40 ? '  ' : '';
  const w = Math.max(1, usable - indent.length);
  const height = Math.max(1, rows - 1);
  const paint = (text: string, code: number) => color && code !== 37 ? `\x1b[${foreground(code, theme)}m${text}\x1b[0m` : text;
  const cell = (text: string, size: number, code = 37) => paint(fit(text, size), code);
  const heading = (label: string) => paint(fit(`${label}  ${'─'.repeat(Math.max(0, w))}`, w), 35);
  const board = s.codingBoard;
  const now = s.now;
  const out: string[] = [];
  const counts = board ? Object.entries(board.counts).map(([k, v]) => `${k} ${v}`).join(' · ') : '';
  out.push(heading(`编码任务  ${counts || '无进行中任务'}`));
  if (!board) { out.push(cell('读取中…', w, 90)); }
  else {
    if (board.error) out.push(cell(board.error, w, 91));
    if (board.loading) out.push(cell('首次扫描仓库中，稍后自动刷新…', w, 90));
    if (board.queue.length) {
      for (const q of board.queue) {
        const tag = q.state === 'running' ? paint('▶ 持锁', 36) : paint('◌ 排队', 93);
        const tail = q.state === 'running' ? (q.startedAt ? elapsed(now - q.startedAt) : '') : `第 ${q.position ?? '?'} 位`;
        out.push(`${tag}  ${cell(q.name, 22)}  ${cell(q.cmd ?? '', Math.max(0, w - 46))}  ${cell(tail, 10, q.state === 'running' ? 36 : 90)}`);
      }
    }
    // Column widths: name, branch, gates, PR, session; the branch column absorbs the slack.
    const nameW = w >= 140 ? 28 : 22, gateW = 14, prW = 16, sessW = 8;
    const branchW = Math.max(10, w - 4 - nameW - gateW - prW - sessW - 8);
    out.push(paint(fit(`  ${fit('JIRA / WORKTREE', nameW + 2)}  ${fit('阶段 · 分支', branchW)}  ${fit('门禁', gateW)}  ${fit('PR', prW)}  ${fit('会话', sessW)}`, w), 90));
    const cursor = Math.min(Math.max(0, view.cursor), Math.max(0, board.tasks.length - 1));
    board.tasks.forEach((task, i) => {
      const sel = i === cursor;
      const mark = sel ? paint('›', 36) : ' ';
      const right = ago(task.activityAt, now);
      out.push(`${mark} ${cell(task.key, nameW + 2, sel ? 36 : 37)}  ${paint(PHASE_ICON[task.phase] + ' ', PHASE_COLOR[task.phase])}${cell(task.phase, 9, PHASE_COLOR[task.phase])} ${cell(task.title, Math.max(0, w - nameW - 30 - 10))} ${cell(right, 10, 90)}`);
      task.worktrees.forEach((wt, j) => {
        const branch = `${wt.branch ?? '(detached)'}${wt.dirty ? ` ±${wt.dirty}` : ''}`;
        const jobs = wt.jobs.slice(-3);
        const gate = jobs.map(job => paint(JOB_ICON[job.state][0], JOB_ICON[job.state][1])).join('');
        const lastJob = jobs.at(-1);
        const gateText = lastJob ? lastJob.state === 'waiting' ? ` 第 ${lastJob.position ?? '?'} 位` : ` ${clock(lastJob.startedAt, now)}` : wt.cleaned ? '' : '—';
        const gateCells = jobs.length + [...gateText].reduce((n, ch) => n + width(ch), 0);
        const sess = wt.sessions.some(x => x.running) ? paint(fit('● 运行', sessW), 92) : cell(wt.sessions.length ? '已结束' : '—', sessW, 90);
        const tree = j === task.worktrees.length - 1 ? '└' : '├';
        out.push(`    ${cell(`${tree} ${wt.name}`, nameW)}  ${cell(branch, branchW, wt.cleaned ? 90 : 37)}  ${gate}${paint(gateText, 90)}${' '.repeat(Math.max(0, gateW - gateCells))}  ${cell(prLabel(wt), prW, wt.pr?.state === 'merged' ? 92 : wt.pr?.state === 'open' ? 35 : 90)}  ${sess}`);
      });
      if (sel && view.expanded) out.push(...detail(task));
    });
    if (!board.tasks.length && !board.loading) out.push(cell('没有进行中的编码任务', w, 90));
    if (board.merged.length) out.push(cell(`▸ 已合并待清理 ${board.merged.length}：${board.merged.map(m => m.key.replace(/^[A-Z][A-Z0-9]+-(\d+)$/, '$1').replace(/^.*\//, '')).join(' · ')}   （worktree-clean 可清理）`, w, 90));
    if (board.idle) out.push(cell(`另有 ${board.idle} 个闲置 worktree 未显示`, w, 90));
  }

  function detail(task: CodingBoardTask): string[] {
    const lines: string[] = [];
    if (task.nextStep) lines.push(`      ${paint('下一步', 35)}  ${cell(task.nextStep, Math.max(0, w - 14))}`);
    for (const wt of task.worktrees) {
      const job = wt.jobs.find(j => j.logTail?.length);
      if (!job) continue;
      lines.push(`      ${paint(`${wt.name} 构建日志`, 35)}  ${cell(job.cmd, Math.max(0, w - wt.name.length - 20), 90)}`);
      for (const row of job.logTail!.slice(-8)) lines.push(`        ${cell(row, Math.max(0, w - 8), /ERROR|FAIL/.test(row) ? 91 : /WARN/.test(row) ? 93 : 90)}`);
    }
    const chat = task.worktrees.flatMap(x => x.sessions).find(x => x.running) ?? task.worktrees.flatMap(x => x.sessions)[0];
    if (chat) lines.push(`      ${paint('会话', 35)}  ${cell(`${chat.profile} · ${chat.chatName ?? (chat.chatType === 'p2p' ? '私聊' : chat.chatId)}${chat.threadId ? ' · 话题' : ''} · ${chat.running ? '运行中' : '已结束'}${chat.chatUrl ? ' · o 打开' : ''}`, Math.max(0, w - 10))}`);
    if (!lines.length) lines.push(cell('      暂无构建日志或会话记录', w, 90));
    return lines;
  }

  const footer = paint(fit('↑↓/jk 选择 · ⏎ 展开 · o 打开话题 · b 返回 · r 刷新 · q 退出', w), 90);
  // Keep the selected task visible: scroll so its first line sits inside the window.
  const body = height - 1;
  let start = 0;
  if (board && out.length > body) {
    const marker = out.findIndex(l => clean(l).startsWith('› '));
    start = Math.max(0, Math.min(out.length - body, marker - Math.floor(body / 3)));
  }
  return [...out.slice(start, start + body), footer].map(l => indent + l).join('\n');
}
