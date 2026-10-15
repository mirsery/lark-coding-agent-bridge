import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';
import type { AgentEvent } from '../../src/agent/types';
import { isAlive, listDescendants } from '../../src/agent/process-tree.js';

const dirs: string[] = [];

describe.skipIf(process.platform === 'win32')('stopping a Claude run', () => {
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it.each(['default', '143', 'ignore', 'result'])('ends the process tree when the root handles SIGTERM as %s', { timeout: 20_000 }, async (mode) => {
    const fake = await createHangingClaude(mode);
    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-tree',
      prompt: 'hang',
      cwd: fake.dir,
      stopGraceMs: 300,
    });
    const shellPid = await readPid(fake.shellPidFile);
    const sleepPid = await readPid(fake.sleepPidFile);
    expect(run.pid).toBeDefined();
    expect(listDescendants(run.pid!)).toEqual(expect.arrayContaining([shellPid, sleepPid]));

    const events = collect(run.events);
    await Promise.all([run.stop(), run.stop()]);
    expect(await events).toEqual([expect.objectContaining({ type: 'done', terminationReason: 'interrupted' })]);

    await expectGone(shellPid);
    await expectGone(sleepPid);
    expect(await run.waitForExit(1_000)).toBe(true);
  });
  it('does not emit a second terminal event when stopping a process kept for background work', async () => {
    const fake = await createHangingClaude('done');
    const run = new ClaudeAdapter({ binary: fake.path }).run({ runId: 'stop-linger', prompt: 'x', cwd: fake.dir, stopGraceMs: 100 });
    await readPid(fake.sleepPidFile);
    const all: AgentEvent[] = [];
    let ready!: () => void;
    const seen = new Promise<void>((r) => { ready = r; });
    const collecting = (async () => {
      for await (const evt of run.events) {
        all.push(evt);
        if (evt.type === 'done') ready();
      }
    })();
    await seen;
    await run.stop();
    await collecting;
    expect(all.filter((e) => e.type === 'done' || e.type === 'error')).toHaveLength(1);
  });

  it('reports an external signal as a failure', async () => {
    const fake = await createHangingClaude();
    const run = new ClaudeAdapter({ binary: fake.path }).run({ runId: 'external-kill', prompt: 'x', cwd: fake.dir });
    const shell = await readPid(fake.shellPidFile);
    const sleep = await readPid(fake.sleepPidFile);
    const events = collect(run.events);
    try {
      process.kill(run.pid!, 'SIGKILL');
      const result = await events;
      expect(result).toEqual([expect.objectContaining({ type: 'error', terminationReason: 'failed' })]);
    } finally {
      for (const pid of [shell, sleep]) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  });

});

/**
 * A "claude" that starts a shell which starts `sleep`, both ignoring SIGTERM
 * — a stand-in for a hung tool command — and then never finishes.
 */
async function createHangingClaude(mode = 'default'): Promise<{
  path: string;
  dir: string;
  shellPidFile: string;
  sleepPidFile: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-stop-tree-'));
  dirs.push(dir);
  const path = join(dir, 'fake-claude.mjs');
  const shellPidFile = join(dir, 'shell.pid');
  const sleepPidFile = join(dir, 'sleep.pid');
  const script = `trap '' TERM; sleep 300 & echo $! > ${sleepPidFile}; wait`;
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const child = spawn("/bin/sh", ["-c", ${JSON.stringify(script)}], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(shellPidFile)}, String(child.pid));`,
      ...(mode === '143' ? ["process.on('SIGTERM', () => process.exit(143));"] : []),
      ...(mode === 'result' ? ["process.on('SIGTERM', () => { console.log(JSON.stringify({ type: 'result', session_id: 'stopped' })); process.exit(0); });"] : []),
      ...(mode === 'ignore' ? ["process.on('SIGTERM', () => {});"] : []),
      ...(mode === 'done' ? ["console.log(JSON.stringify({type: 'system', subtype: 'background_tasks_changed', tasks: [{}]}));", "console.log(JSON.stringify({type: 'result'}));", "console.log(JSON.stringify({type: 'system', subtype: 'background_tasks_changed', tasks: [{}]}));"] : []),
      'process.stdin.resume();',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, shellPidFile, sleepPidFile };
}

async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 250; i++) {
    const text = await readFile(file, 'utf8').catch(() => '');
    const pid = Number(text.trim());
    if (pid > 0) return pid;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no pid in ${file}`);
}

/** Killed processes linger as zombies until reaped; give init a moment. */
async function expectGone(pid: number): Promise<void> {
  for (let i = 0; i < 250 && isAlive(pid); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(isAlive(pid), `pid ${pid} still alive`).toBe(false);
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const evt of events) out.push(evt);
  return out;
}
