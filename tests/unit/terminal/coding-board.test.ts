import { describe, expect, it, vi } from 'vitest';
import { renderCodingBoard, prLabel } from '../../../src/terminal/coding-board';
import { boardKey } from '../../../src/cli/commands/monitor';
import type { CodingBoardSnapshot } from '../../../src/coding-board/snapshot';
import type { MonitorSnapshot } from '../../../src/terminal/monitor';

const now = new Date(2026, 10, 18, 13, 45).getTime();
const board: CodingBoardSnapshot = {
  observedAt: now,
  counts: { 构建中: 1, '等 review': 1 },
  idle: 2,
  queue: [{ name: '8387-fields', path: '/w/8387-fields', state: 'running', cmd: 'mvnd -q install', startedAt: now - 89_000 }],
  merged: [{ key: 'ANTELOPE-8404', title: '电价', worktrees: ['/w/8404'] }],
  tasks: [
    { key: 'ANTELOPE-8387', jira: 'ANTELOPE-8387', title: 'real-status 接入 EEBUS', repo: 'antelope', phase: '构建中', activityAt: now - 60_000, nextStep: '等门禁',
      worktrees: [{ path: '/w/8387-fields', name: '8387-fields', repo: 'antelope', branch: 'feature/ANTELOPE-8387-fields', dirty: 18, phase: '构建中',
        jobs: [{ id: 'a', label: '8387', cmd: 'mvnd -q install', startedAt: now - 89_000, state: 'running', logTail: ['[INFO] Building internal-api', '[ERROR] boom'] }],
        sessions: [{ profile: 'claude', scope: 'oc_1:omt_1', chatId: 'oc_1', threadId: 'omt_1', running: true, chatType: 'p2p', chatUrl: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1' }] }] },
    { key: 'ANTELOPE-8359', jira: 'ANTELOPE-8359', title: 'OMS 账号', repo: 'antelope', phase: '等 review', activityAt: now - 2 * 86_400_000,
      worktrees: [{ path: '', name: '(worktree 已清理)', repo: 'antelope', branch: 'feature/ANTELOPE-8359', cleaned: true, phase: '等 review', jobs: [], sessions: [],
        pr: { number: 5559, title: 'x', branch: 'feature/ANTELOPE-8359', state: 'open' } }] },
  ],
};
const snap = { now, host: 'h', cores: 1, load: 0, bots: [], codingBoard: board } as MonitorSnapshot;

describe('coding board page', () => {
  it('shows the queue, grouped worktrees, merged leftovers and fits the window', () => {
    const out = renderCodingBoard(snap, 140, 40, { cursor: 0, expanded: false }, false);
    expect(out).toContain('▶ 持锁');
    expect(out).toContain('01:29');
    expect(out).toContain('› ANTELOPE-8387');
    expect(out).toContain('feature/ANTELOPE-8387-fields ±18');
    expect(out).toContain('#5559 开着');
    expect(out).toContain('已合并待清理 1：8404');
    expect(out).toContain('另有 2 个闲置 worktree');
    expect(out).not.toContain('[ERROR] boom');
    for (const line of out.split('\n')) expect([...line].length).toBeLessThanOrEqual(140);
    expect(out.split('\n').length).toBeLessThan(40);
  });

  it('expands the selected task with next step, log tail and chat', () => {
    const out = renderCodingBoard(snap, 140, 40, { cursor: 0, expanded: true }, false);
    expect(out).toContain('下一步');
    expect(out).toContain('[ERROR] boom');
    expect(out).toContain('o 打开');
  });

  it('keeps the selected task on screen in a short window', () => {
    const out = renderCodingBoard(snap, 100, 8, { cursor: 1, expanded: false }, false);
    expect(out).toContain('› ANTELOPE-8359');
    expect(out.split('\n').length).toBeLessThanOrEqual(7);
  });

  it('labels PRs without counting checks on merged ones', () => {
    const w = board.tasks[1]!.worktrees[0]!;
    expect(prLabel({ ...w, pr: { ...w.pr!, state: 'merged', checks: { passed: 5, failed: 1, pending: 0, skipped: 0 } } })).toBe('#5559 已合并');
    expect(prLabel({ ...w, pr: { ...w.pr!, checks: { passed: 3, failed: 0, pending: 2, skipped: 0 } } })).toBe('#5559 开着 3/5');
  });

  it('moves the cursor within bounds, toggles details and opens only the chat link', () => {
    const view = { cursor: 0, expanded: false };
    const open = vi.fn();
    expect(boardKey('j', view, snap, open)).toBe(true);
    expect(boardKey('\x1b[B', view, snap, open)).toBe(true);
    expect(view.cursor).toBe(1);
    expect(boardKey('k', view, snap, open)).toBe(true);
    expect(boardKey('\r', view, snap, open)).toBe(true);
    expect(view.expanded).toBe(true);
    boardKey('o', view, snap, open);
    expect(open).toHaveBeenCalledWith('https://applink.feishu.cn/client/chat/open?openChatId=oc_1');
  });
});
