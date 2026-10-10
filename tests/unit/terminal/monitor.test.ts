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
