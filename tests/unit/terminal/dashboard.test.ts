import { expect, it } from 'vitest';
import { CAT_WIDTH, catParts, catPatch, catPosition, renderCat } from '../../../src/terminal/dashboard';
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
  expect(view).toContain('( o.o )');
  expect(view).toContain('| A  ||');
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
    const steps = Math.ceil((columns - CAT_WIDTH - 4) / 2);
    expect(catPosition(columns, 36, steps)!.column).toBe(columns - CAT_WIDTH - 1);
    expect(catPosition(columns, 36, steps)!.direction).toBe('left');
    expect(catPosition(columns, 36, steps * 2)!.column).toBe(first.column);
    expect(catPosition(columns, 36, steps * 2)!.direction).toBe('right');
    let previous = first;
    for (let frame = 1; frame < 500; frame++) {
      const at = catPosition(columns, 36, frame)!;
      expect(at.column).toBeGreaterThanOrEqual(3);
      expect(at.column + CAT_WIDTH).toBeLessThan(columns);
      expect(Math.abs(at.column - previous.column)).toBeLessThanOrEqual(2);
      expect(at.row).toBe(3);
      const direction = catPosition(columns, 36, frame + 1)!.column < at.column ? 'left' : 'right';
      expect(at.direction).toBe(direction);
      expect(catPatch(columns, 36, frame, false)).toContain(renderCat(frame, direction)[1]);
      previous = at;
    }
    const patch = catPatch(columns, 36, 1, false);
    // The previous frame is erased across the mascot's full width and all five rows.
    expect(patch).toContain(`\x1b[3;${first.column}H${' '.repeat(CAT_WIDTH)}`);
    expect(patch).toContain(`\x1b[7;${first.column}H${' '.repeat(CAT_WIDTH)}`);
    expect(patch).not.toContain(`\x1b[8;`);
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

it('draws the capped mascot pushing an A-branded cabinet, mirrored without mirroring the letter', () => {
  expect(CAT_WIDTH).toBeLessThanOrEqual(26);
  expect(renderCat(0, 'left')).not.toEqual(renderCat(0, 'right'));
  for (const direction of ['left', 'right'] as const) {
    for (const frame of [0, 1]) {
      const art = renderCat(frame, direction);
      expect(art).toHaveLength(5);
      expect(art.every(row => row.length === CAT_WIDTH)).toBe(true);
      const text = art.join('\n');
      expect(text).toContain('( o.o )');
      expect(text).toContain('.--.');
      expect(text).toMatch(/[oO] {7}[oO]/);
    }
  }
  // Walking right the cat pushes from the left; walking left the cart leads on the left.
  expect(renderCat(0, 'right')[1]!.indexOf('o.o')).toBeLessThan(renderCat(0, 'right')[1]!.indexOf('A'));
  expect(renderCat(0, 'left')[1]!.indexOf('A')).toBeLessThan(renderCat(0, 'left')[1]!.indexOf('o.o'));
  expect(renderCat(0, 'right')[1]).toContain('| A  ||');
  expect(renderCat(0, 'left')[1]).toContain('||  A |');
  expect(renderCat(0, 'right')[0]).toContain('/\\.--.__');
  expect(renderCat(0, 'left')[0]).toContain('__.--./\\');
  // Legs and wheels alternate between frames.
  expect(renderCat(0, 'right')[4]).not.toEqual(renderCat(1, 'right')[4]);
});

it('paints the mascot like the sticker: an orange cat in a dark hoodie pushing a plain cabinet', () => {
  for (const direction of ['left', 'right'] as const) {
    for (const frame of [0, 1]) {
      const art = renderCat(frame, direction);
      const parts = catParts(frame, direction);
      expect(parts.map(row => row.length)).toEqual(art.map(row => row.length));
      // Every stroke belongs to a part, and the cabinet's letter to the cart.
      art.forEach((row, i) => [...row].forEach((char, j) => { if (char !== ' ') expect(parts[i]![j]).not.toBe(' '); }));
      expect(parts[1]![art[1]!.indexOf('A')]).toBe('k');
      expect(parts[1]![art[1]!.indexOf('o.o')]).toBe('c');
      expect(parts[2]![art[2]!.indexOf('###')]).toBe('h');
    }
  }
  const patch = catPatch(160, 36, 1, true, 'dark');
  expect(patch).toContain('\x1b[38;5;222m( o.o )');
  expect(patch).toContain('\x1b[38;5;245m|###|');
  expect(patch).toContain('\x1b[39m| A  ||');
  expect(patch.endsWith('\x1b[0m')).toBe(true);
  const snap = { now: 1000, host: 'host', cores: 8, load: 1, bots: [] };
  const view = renderMonitor(snap, 160, 36, true, 0, false, 'dark');
  expect(view).toContain('\x1b[38;5;222m( o.o )\x1b[0m');
  expect(view).toContain('\x1b[38;5;245m|###|\x1b[0m');
  expect(renderMonitor(snap, 160, 36, false)).toContain('( o.o )       | A  ||');
});
