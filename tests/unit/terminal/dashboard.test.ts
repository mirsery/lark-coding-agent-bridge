import { expect, it } from 'vitest';
import { catPatch, catPosition, renderCat } from '../../../src/terminal/dashboard';
import { renderMonitor } from '../../../src/terminal/monitor';

it('animates only a bounded top corner without clearing or scrolling the viewport', () => {
  expect(renderCat(0)).not.toEqual(renderCat(1));
  expect(renderCat(0)).toEqual(renderCat(6));
  const patch = catPatch(110, 36, 1, false);
  expect(patch).toContain('\x1b[');
  expect(patch).not.toMatch(/[\r\n]|\x1b\[[0-9]*[JK]/);
  expect(patch).not.toContain('CPU');
  expect(patch).not.toContain('会话');
  expect(catPosition(48, 36)).toBeUndefined();
  expect(catPosition(110, 12)).toBeUndefined();
});

it('keeps metrics above sessions, with bars in roomy terminals and compact small screens', () => {
  const snap = { now: 1000, host: 'host', cores: 8, load: 1, bots: [{ profile: 'test', name: 'Busy', agent: 'agent', online: true, runs: [{ runId: 'id', scope: 'scope', chatId: 'chat', originMessageId: 'msg', promptPreview: '保持任务可见', startedAt: 0, ownerPid: process.pid, orphan: false }] }], metrics: { cpuPercent: 45, memoryTotal: 16 * 1024 ** 3, memoryNonFree: 12 * 1024 ** 3, uptimeSeconds: 600, disk: { total: 100, used: 70, available: 30, sampledAt: 1000 } } };
  const view = renderMonitor(snap, 110, 36, false);
  expect(view).toContain('/\\_/\\');
  expect(view).toContain('█');
  expect(view.indexOf('CPU')).toBeLessThan(view.indexOf('Busy'));
  expect(view).toContain('保持任务可见');
  expect(view).toContain('╭');
  expect(view).toContain('╰');
  expect(view).toContain('│');
  const small = renderMonitor(snap, 80, 24, false);
  expect(small).toContain('保持任务可见');
  expect(renderMonitor(snap, 110, 36, false, 1)).not.toEqual(view);
});

it('turns at both edges without jumping and faces its direction of travel', () => {
  for (const columns of [80, 110, 238]) {
    const first = catPosition(columns, 36, 0)!;
    expect(catPosition(columns, 36, 1)!.column).toBeGreaterThan(first.column);
    const steps = Math.ceil((columns - 16 - 4) / 2);
    expect(catPosition(columns, 36, steps)!.column).toBe(columns - 17);
    expect(catPosition(columns, 36, steps)!.direction).toBe('left');
    expect(catPosition(columns, 36, steps * 2)!.column).toBe(first.column);
    expect(catPosition(columns, 36, steps * 2)!.direction).toBe('right');
    let previous = first;
    for (let frame = 1; frame < 500; frame++) {
      const at = catPosition(columns, 36, frame)!;
      expect(at.column).toBeGreaterThanOrEqual(3);
      expect(at.column + 16).toBeLessThan(columns);
      expect(Math.abs(at.column - previous.column)).toBeLessThanOrEqual(2);
      expect(at.row).toBe(3);
      const direction = catPosition(columns, 36, frame + 1)!.column < at.column ? 'left' : 'right';
      expect(at.direction).toBe(direction);
      expect(catPatch(columns, 36, frame, false)).toContain(renderCat(frame, direction)[1]);
      previous = at;
    }
    const patch = catPatch(columns, 36, 1, false);
    expect(patch).toContain(`\x1b[3;${first.column}H${' '.repeat(16)}`);
  }
});
it('keeps all of a bot\'s sessions in its one closed card and preserves the terminal background in every theme', () => {
  const run = { runId: 'a', scope: 'a', chatId: 'chat', originMessageId: 'msg', promptPreview: '第一会话', startedAt: 0, ownerPid: process.pid, orphan: false };
  const snap = { now: 1000, host: 'host', cores: 8, load: 1, bots: [{ profile: 'test', name: 'Bot', agent: 'agent', online: true, runs: [run, { ...run, runId: 'b', scope: 'b', promptPreview: '第二会话' }] }] };
  const view = renderMonitor(snap, 160, 36, false);
  expect(view.match(/╭/g)).toHaveLength(1);
  expect(view.match(/╰/g)).toHaveLength(1);
  expect(view.match(/Bot \/ agent/g)).toHaveLength(1);
  expect(view).toContain('WORKING · 2 个会话');
  expect(view).toContain('第一会话');
  expect(view).toContain('第二会话');
  expect(view.indexOf('第一会话')).toBeLessThan(view.indexOf('┈'));
  expect(view.indexOf('┈')).toBeLessThan(view.indexOf('第二会话'));
  expect(view).not.toContain('\x1b');
  for (const theme of ['light', 'dark', 'terminal'] as const) {
    const colored = renderMonitor(snap, 160, 36, true, 0, false, theme);
    expect(colored).not.toMatch(/\x1b\[(?:48|4[0-7]|10[0-7])[;m]/);
    expect(colored).toContain('\x1b[39m');
    expect(catPatch(160, 36, 1, true, theme)).not.toContain('48;');
  }
});

it('mirrors the cat when walking back to the left', () => {
  expect(renderCat(0, 'left')).not.toEqual(renderCat(0, 'right'));
  for (const direction of ['left', 'right'] as const) {
    expect(renderCat(1, direction).every(row => row.length === 16)).toBe(true);
  }
});
