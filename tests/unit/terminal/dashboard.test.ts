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
  expect(view).toContain('━');
  expect(view.indexOf('CPU')).toBeLessThan(view.indexOf('Busy'));
  expect(view).toContain('保持任务可见');
  const small = renderMonitor(snap, 80, 24, false);
  expect(small).toContain('保持任务可见');
  expect(renderMonitor(snap, 110, 36, false, 1)).not.toEqual(view);
});
