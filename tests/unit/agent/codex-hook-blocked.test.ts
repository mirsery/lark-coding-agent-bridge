import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerTranslator } from '../../../src/agent/codex/app-server-translator';
import { codexCall, refusedCall, rolloutCall } from '../../../src/agent/codex/blocked-calls';
import type { AgentEvent } from '../../../src/agent/types';
import { guardRefusal } from '../../../src/policy/owner-guard';

/** A guest run on codex-cli 0.163.0 `app-server` whose two first calls the bridge's hook refused. */
const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/codex-app-server-hook-blocked.json'), 'utf8'),
) as { notifications: Array<{ method: string; params: Record<string, unknown> }>; rollout: string[] };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rolloutFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-'));
  dirs.push(dir);
  const file = join(dir, 'rollout.jsonl');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function translate(lookup?: (id: string) => ReturnType<typeof rolloutCall>): AgentEvent[] {
  const t = new CodexAppServerTranslator('thread-1', lookup);
  return fixture.notifications.flatMap((n) => t.notification(n.method, n.params));
}

describe('Codex calls the bridge hook blocked', () => {
  it('show as failed steps, named and read as the items they would have become', () => {
    const rollout = rolloutFile(fixture.rollout);
    const events = translate((id) => rolloutCall(rollout, id));
    const tools = events.filter((e) => e.type === 'tool_use');
    expect(tools).toHaveLength(3);
    expect(tools[0]).toMatchObject({
      name: 'command_execution',
      input: { command: expect.stringMatching(/^cd \/\S+\/home\/private && cat secret\.txt$/) },
    });
    expect(tools[1]).toMatchObject({ name: 'file_change', input: { paths: [expect.stringMatching(/\/home\/ro\/new\.txt$/)] } });
    // The allowed command is the item Codex reports as always.
    expect(tools[2]).toMatchObject({ name: 'command_execution', input: { command: "/bin/zsh -lc 'echo ok > allowed.txt'" } });

    const refused = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.isError);
    expect(refused.map((e) => e.id)).toEqual([tools[0]?.id, tools[1]?.id]);
    // What `/audit 拦截` records: the guard's reason, as for Claude.
    expect(refused.map((e) => guardRefusal(e.output))).toEqual([
      expect.stringMatching(/^这条命令会访问未对外开放的位置 \/\S+\/home\/private$/),
      expect.stringMatching(/^只读目录不能改动：\/\S+\/home\/ro$/),
    ]);
  });

  it("read a code-mode cell's call from the hook's refusal log, which the rollout never has", () => {
    const log = rolloutFile([
      JSON.stringify({ id: 'exec-1', tool: 'Bash', input: { command: 'cat secret.txt' } }),
      JSON.stringify({ id: 'exec-2', tool: 'apply_patch', input: { command: '*** Begin Patch\n*** Add File: /ro/n.txt\n+x\n*** End Patch\n' } }),
      JSON.stringify({ id: 'exec-3', tool: 'view_image', input: { path: '/p.png' } }),
    ]);
    expect(refusedCall(log, 'exec-1')).toEqual({ name: 'command_execution', input: { command: 'cat secret.txt' } });
    expect(refusedCall(log, 'exec-2')).toEqual({ name: 'file_change', input: { paths: ['/ro/n.txt'] } });
    expect(refusedCall(log, 'exec-3')).toEqual({ name: 'view_image', input: { file_path: '/p.png' } });
    expect(refusedCall(log, 'exec-4')).toBeUndefined();
    expect(refusedCall(join(tmpdir(), 'no-such-log.jsonl'), 'exec-1')).toBeUndefined();
  });

  it('still show, unnamed, when the call is not in the rollout', () => {
    const events = translate(() => undefined).slice(0, 2);
    expect(events[0]).toMatchObject({ type: 'tool_use', name: 'PreToolUse', input: {} });
    expect(events[1]).toMatchObject({ type: 'tool_result', isError: true });
  });

  it('leave hooks that let the call run, and blocks by hooks of the user\'s own, unattributed to the guard', () => {
    const t = new CodexAppServerTranslator('thread-1');
    const run = { id: 'pre-tool-use:0:/Users/x/.codex/hooks.json:call_1', eventName: 'preToolUse', source: 'user', status: 'blocked', entries: [{ kind: 'feedback', text: 'no' }] };
    expect(t.notification('hook/completed', { threadId: 'thread-1', run: { ...run, status: 'completed' } })).toEqual([]);
    const events = t.notification('hook/completed', { threadId: 'thread-1', run });
    expect(events[1]).toMatchObject({ type: 'tool_result', id: 'call_1', output: 'PreToolUse hook: no', isError: true });
    expect(guardRefusal((events[1] as { output: string }).output)).toBeUndefined();
  });
});

describe('codexCall', () => {
  it('reads shell calls as the command they run, and where', () => {
    expect(codexCall('exec_command', { cmd: 'ls', workdir: '/w' })).toEqual({ name: 'command_execution', input: { command: 'cd /w && ls' } });
    expect(codexCall('exec_command', { cmd: 'ls' })).toEqual({ name: 'command_execution', input: { command: 'ls' } });
    expect(codexCall('shell', { command: ['bash', '-lc', 'ls'] })).toEqual({ name: 'command_execution', input: { command: 'bash -lc ls' } });
  });

  it('reads a patch as the files it touches, and image views and other tools as they are', () => {
    const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** Move to: b.ts\n*** Delete File: c.ts\n*** End Patch\n';
    expect(codexCall('apply_patch', { input: patch })).toEqual({ name: 'file_change', input: { paths: ['a.ts', 'b.ts', 'c.ts'] } });
    expect(codexCall('view_image', { path: '/p.png' })).toEqual({ name: 'view_image', input: { file_path: '/p.png' } });
    expect(codexCall('spawn_agent', { message: 'hi' })).toEqual({ name: 'spawn_agent', input: { message: 'hi' } });
  });

  it('finds nothing in a missing rollout', () => {
    expect(rolloutCall(join(tmpdir(), 'no-such-rollout.jsonl'), 'call_1')).toBeUndefined();
  });
});
