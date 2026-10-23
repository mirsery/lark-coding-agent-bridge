import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clean, fit, createMonitorReader, readMonitor, renderMonitor } from '../../../src/terminal/monitor';

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
describe('terminal monitor', () => {
  it('reads live bots, isolated task telemetry and stale tasks without rewriting state', async () => {
    root = await mkdtemp(join(tmpdir(), 'monitor-'));
    const now = Date.now();
    await mkdir(join(root, 'registry'), { recursive: true });
    await mkdir(join(root, 'profiles', 'codex', 'logs'), { recursive: true });
    await mkdir(join(root, 'profiles', 'offline'), { recursive: true });
    const registry = JSON.stringify({ entries: [{ id: 'abcd', pid: process.pid, appId: 'test', tenant: 'feishu', profileName: 'codex', agentKind: 'codex', configPath: 'unused', startedAt: new Date(now).toISOString(), version: 'test', botName: 'Poki' }] });
    await writeFile(join(root, 'registry', 'processes.json'), registry);
    const run = { runId: 'run-one', scope: 'chat', chatId: 'chat', originMessageId: 'msg', promptPreview: 'Build dashboard https://example.com/browse/TASK-123', startedAt: now - 5000, ownerPid: process.pid };
    const runs = JSON.stringify({ one: run, stale: { ...run, runId: 'old', scope: 'other', startedAt: now - 25 * 3600000 } });
    await writeFile(join(root, 'profiles', 'codex', 'runs.json'), runs);
    const event = (fields: object) => JSON.stringify({ ts: new Date(now).toISOString(), phase: 'agent', ...fields });
    await writeFile(join(root, 'profiles', 'codex', 'logs', 'bridge-20261010.jsonl'), [
      event({ event: 'queued', phase: 'intake', msgId: 'msg', traceId: 'intake-trace' }),
      event({ event: 'run-started', runId: 'run-one', traceId: 'trace-one', scope: 'chat' }),
      event({ event: 'tool-in-flight', traceId: 'trace-one', tool: 'exec_command', args: 'secret' }),
      event({ event: 'tool-in-flight', traceId: 'other-trace', runId: 'different', scope: 'chat', tool: 'wrong-tool' }),
      '{partial',
    ].join('\n'));
    const read = createMonitorReader();
    const snap = await read(root, undefined, now);
    const bot = snap.bots.find(b => b.profile === 'codex')!;
    expect(bot.online).toBe(true);
    expect(bot.runs[0]!.runId).toBe('run-one');
    expect(bot.name).toBe('Poki');
    expect(bot.runs.find(r => r.runId === 'run-one')?.activity?.tool).toBe('exec_command');
    expect(bot.runs.find(r => r.runId === 'old')?.orphan).toBe(true);
    expect(snap.bots.find(b => b.profile === 'offline')?.online).toBe(false);
    expect(JSON.stringify(snap)).not.toContain('secret');
    expect(await readFile(join(root, 'registry', 'processes.json'), 'utf8')).toBe(registry);
    expect(await readFile(join(root, 'profiles', 'codex', 'runs.json'), 'utf8')).toBe(runs);
    expect((await readMonitor(root, 'codex')).bots).toHaveLength(1);
    const rendered = renderMonitor(snap, 110, 40, false);
    expect(rendered).toContain('Build dashboard');
    expect(rendered).toContain('RAM');
    expect(rendered).not.toContain('scope ');
    expect(rendered).not.toContain('PID ');
    expect(rendered).not.toContain('run-one');
    expect(rendered).not.toContain('LAST ');
    expect(rendered).toContain('[TASK-123]');
    expect(rendered).not.toContain('https://');
    expect(rendered).toContain('DISK');
    // The same reader must notice an append instead of returning stale cached events.
    await appendFile(join(root, 'profiles', 'codex', 'logs', 'bridge-20261010.jsonl'), '\n' + event({ event: 'tool-in-flight', traceId: 'trace-one', tool: 'new-tool' }));
    expect((await read(root, 'codex', now + 2000)).bots[0]!.runs[0]!.activity?.tool).toBe('new-tool');
  });
  it('strips terminal escape sequences and fits Chinese labels', () => {
    expect(clean('\x1b]0;malicious\x07\x1b[31m任务\x1b[0m\ntext')).toBe('任务 text');
    expect(fit('任务abcd', 6)).toBe('任务ab');
  });
  it('keeps a busy bot visible in a small terminal with many tasks', () => {
    const run = { runId: 'id', scope: 'chat', chatId: 'chat', originMessageId: 'msg', promptPreview: 'Task preview', startedAt: 0, ownerPid: process.pid, orphan: false };
    const rendered = renderMonitor({ now: 1000, host: 'host', cores: 8, load: 1, bots: [{ profile: 'codex', name: 'Poki', agent: 'codex', online: true, runs: Array.from({ length: 30 }, () => run) }] }, 80, 24, false);
    expect(rendered).toContain('Poki');
    expect(rendered).toContain('Task preview');
    expect(rendered.split('\n').length).toBeLessThanOrEqual(24);
  });
});

describe('responsive monitor layout', () => {
  const snapshot = {
    now: 1000, host: 'host', cores: 8, load: 1,
    metrics: { temperatureC: 56.2, io: { disk: { read: 2048, write: 4096 }, network: { read: 8192, write: 16384 }, sampledAt: 1000 }, cpuPercent: 30, memoryTotal: 16 * 1024 ** 3, memoryNonFree: 12 * 1024 ** 3, uptimeSeconds: 50000, disk: { total: 100, used: 10, available: 90, sampledAt: 1000 } },
    bots: ['CC', 'Poki'].map(name => ({ profile: name, name, agent: 'agent', online: true, runs: [{ runId: name, scope: 'chat', chatId: 'chat', originMessageId: 'msg', promptPreview: '检查终端响应式布局和任务进度 '.repeat(12), startedAt: 0, ownerPid: process.pid, orphan: false }] })),
  };
  const cells = (text: string) => [...clean(text)].reduce((sum, c) => sum + ((c.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0);
  it('uses the wide viewport and places bots alongside each other', () => {
    const lines = renderMonitor(snapshot, 238, 67, false).split('\n');
    expect(lines.some(line => line.includes('CC /') && line.includes('Poki /'))).toBe(true);
    expect(Math.max(...lines.map(cells))).toBeGreaterThan(220);
    expect(lines.join('\n')).toContain('TEMP 56.2°C');
    expect(lines.join('\n')).toContain('IO R 2.0K/s W 4.0K/s');
    // Network rates are plain numbers, not sparklines.
    expect(lines.join('\n')).toMatch(/Down +8\.0K\/s/);
    expect(lines.join('\n')).toMatch(/Up +16\.0K\/s/);
    expect(lines.join('\n')).not.toMatch(/[▁▂▃▄▅▆▇]/);
  });
  it('stacks bots in ordinary windows and stays within narrow viewport dimensions', () => {
    expect(renderMonitor(snapshot, 110, 36, false).split('\n').some(line => line.includes('CC /') && line.includes('Poki /'))).toBe(false);
    for (const columns of [20, 48, 80, 110, 150, 238]) {
      for (const rows of [12, 24, 67]) {
        const lines = renderMonitor(snapshot, columns, rows, true).split('\n');
        expect(lines.length).toBeLessThan(rows);
        expect(Math.max(...lines.map(cells))).toBeLessThan(columns);
      }
    }
  });
});

 it('shows task origin on the right and moves it to its own row in a narrow terminal', () => {
  const run = { runId: 'id', scope: 'chat', chatId: 'chat', originMessageId: 'msg', promptPreview: '![image](img_private_token) 整理接口文档', startedAt: 0, ownerPid: process.pid, orphan: false, chatType: 'group' as const, chatName: '研发交流群', actorName: '张三' };
  const snap = { now: 1000, host: 'host', cores: 8, load: 1, bots: [{ profile: 'codex', name: 'Poki', agent: 'agent', online: true, runs: [run] }] };
  const lines = renderMonitor(snap, 110, 36, false).split('\n');
  expect(lines.join('\n')).not.toContain('img_private_token');
  expect(lines.some(line => line.includes('整理接口文档') && line.includes('研发交流群') && line.includes('张三'))).toBe(true);
  const narrow = renderMonitor(snap, 48, 36, false);
  expect(narrow).toContain('研发交流群');
  expect(narrow).toContain('张三');
  const dm = renderMonitor({ ...snap, bots: [{ ...snap.bots[0]!, runs: [{ ...run, chatType: 'p2p' as const, chatName: undefined }] }] }, 110, 36, false);
  expect(dm).toContain('私聊');
  expect(dm).toContain('张三');
});

const width = (line: string) => [...line].reduce((n, c) => n + ((c.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0);
const quota = (fiveHour: number, week: number) => ({ windows: [
  { label: '5 小时窗口', usedPercent: fiveHour, resets: '2026-10-23T12:00:00Z' },
  { label: '本周', usedPercent: week, resets: '2026-10-25T12:00:00Z' },
] });

it('shows each bot sponsor and both quota windows with local reset times, including idle bots', () => {
  const snap = { now: Date.parse('2026-10-23T10:00:00Z'), host: 'host', cores: 8, load: 1,
    bots: ['alice', 'bob'].map((sponsor, index) => ({ profile: sponsor, name: sponsor, agent: 'agent', online: true, runs: [],
      subscription: { sponsor, loading: false, quota: quota(index ? 42 : 12, 67) } })) };
  const output = renderMonitor(snap, 238, 67, false);
  expect(output).toContain('Sponsor: alice');
  expect(output).toContain('Sponsor: bob');
  expect(output).toMatch(/5h █+░+  12% · 重置 /);
  expect(output).toMatch(/5h █+░+  42% · 重置 /);
  expect(output).toMatch(/周 █+░+  67% · 重置 /);
  expect(output).not.toContain('2026-10-23T');
  for (const columns of [20, 48, 80, 150, 238]) {
    const lines = renderMonitor(snap, columns, 24, false).split('\n');
    expect(lines.length).toBeLessThan(24);
    expect(lines.every(line => width(line) < columns)).toBe(true);
  }
  const unknown = renderMonitor({ ...snap, bots: [{ ...snap.bots[0]!, subscription: { loading: false } }] }, 110, 36, false);
  expect(unknown).toMatch(/5h ░+    — · 重置 —/);
  expect(unknown).toMatch(/周 ░+    — · 重置 —/);
  expect(unknown).not.toContain('0%');
  const loading = renderMonitor({ ...snap, bots: [{ ...snap.bots[0]!, subscription: { loading: true } }] }, 110, 36, false);
  expect(loading).toContain('Sponsor: 读取中…');
  expect(loading).toContain('额度读取中…');
});

it('groups each bot into one card: its sponsor and quota on top, its sessions below', () => {
  const run = { runId: 'one', scope: 'chat', chatId: 'chat', originMessageId: 'msg', promptPreview: '检查布局', startedAt: 0, ownerPid: process.pid, orphan: false };
  const subscription = { sponsor: 'alice', loading: false, quota: quota(12, 67) };
  // Idle first: the order is the snapshot's, a busy bot does not jump ahead.
  const snap = { now: Date.parse('2026-10-23T10:00:00Z'), host: 'host', cores: 8, load: 1, bots: [
    { profile: 'idle', name: 'Idle', agent: 'agent', online: true, subscription: { sponsor: 'bob', loading: false, quota: quota(5, 30) }, runs: [] },
    { profile: 'busy', name: 'Busy', agent: 'agent', online: true, subscription, runs: [run, { ...run, runId: 'two', promptPreview: '第二个会话' }] },
  ] };
  for (const columns of [80, 238]) {
    const output = renderMonitor(snap, columns, 67, false);
    expect(output.match(/╭/g)).toHaveLength(2);
    expect(output.match(/Sponsor: alice/g)).toHaveLength(1);
    expect(output.match(/Busy \/ agent/g)).toHaveLength(1);
    expect(output.match(/12% · 重置/g)).toHaveLength(1);
    expect(output).toContain('WORKING · 2 个会话');
    expect(output).toContain('等待新任务');
    expect(output.indexOf('Idle / agent')).toBeLessThan(output.indexOf('Busy / agent'));
    expect(output.indexOf('Sponsor: alice')).toBeLessThan(output.indexOf('检查布局'));
    expect(output.indexOf('检查布局')).toBeLessThan(output.indexOf('第二个会话'));
    expect(output).not.toContain('会话  ─');
  }
  const wide = renderMonitor(snap, 238, 67, false).split('\n');
  expect(wide.some(line => line.includes('Idle / agent') && line.includes('Busy / agent'))).toBe(true);
  expect(wide.some(line => line.includes('Sponsor: bob') && line.includes('Sponsor: alice'))).toBe(true);
  // Side by side, both groups end on the same row as tall as the busier one; the footer follows, not the window bottom.
  const bottom = wide.findIndex(line => line.includes('╰'));
  expect(wide[bottom]!.match(/╰/g)).toHaveLength(2);
  expect(wide.slice(bottom + 1).map(line => line.trim()).filter(Boolean)).toHaveLength(2);
  expect(wide.length).toBeLessThan(40);
  for (const columns of [20, 48, 80, 110, 150, 238]) {
    for (const rows of [12, 24, 36]) {
      const output = renderMonitor(snap, columns, rows, false);
      expect(output).toContain(rows >= 24 ? '检查布局' : 'Idle');
      const lines = output.split('\n');
      expect(lines.length).toBeLessThan(rows);
      expect(lines.every(line => width(line) < columns)).toBe(true);
    }
  }
});

it('marks exhausted quota, offline bots, stale sessions and sessions that do not fit', () => {
  const run = { runId: 'one', scope: 'chat', chatId: 'chat', originMessageId: 'msg', promptPreview: '排查告警', startedAt: 0, ownerPid: process.pid, orphan: false };
  const snap = { now: Date.parse('2026-10-23T10:00:00Z'), host: 'host', cores: 8, load: 1, bots: [
    { profile: 'codex', name: 'Poki', agent: 'codex', online: true, subscription: { sponsor: 'carol', loading: false, quota: { ...quota(100, 21), blocked: true } },
      runs: [{ ...run, orphan: true }, ...Array.from({ length: 12 }, (_, i) => ({ ...run, runId: `r${i}` }))] },
    { profile: 'claude', name: 'CC', agent: 'claude', online: false, runs: [] },
  ] };
  const output = renderMonitor(snap, 189, 46, false);
  expect(output).toContain('额度已用尽');
  expect(output).toMatch(/5h █{10} 100% · 重置/);
  expect(output).toContain('已中断 / 过期');
  expect(output).toContain('WORKING · 12 个会话');
  expect(output).toMatch(/\+\d+ 个会话 · 放大窗口查看/);
  expect(output).toContain('○ CC / claude');
  expect(output).toContain('OFFLINE');
  // Tight windows fall back to one compact quota line, the exhausted state first.
  const tight = renderMonitor(snap, 80, 18, false);
  expect(tight).toContain('额度已用尽 · 5h 100% · 周 21%  ·  Sponsor: carol');
  expect(tight).toContain('+12 个会话 · 放大窗口查看');
  expect(tight).toContain('未运行');
});
