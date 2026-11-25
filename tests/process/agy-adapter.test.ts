import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgyAdapter } from '../../src/agent/agy/adapter';
import type { AgentEvent } from '../../src/agent/types';
import { createDefaultProfileConfig } from '../../src/config/profile-schema';
import { probeSwitchTarget } from '../../src/runtime/agent-failover';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(needsLogin = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'bridge-agy-test-'));
  roots.push(cwd);
  const binary = join(cwd, 'agy');
  await writeFile(binary, `#!${process.execPath}
const { createInterface } = require('node:readline');
if (process.argv.includes('--version')) {
  console.log('1.5.17');
  process.exit(0);
}
const send = (data) => console.log(JSON.stringify({ jsonrpc: '2.0', ...data }));
const result = (id, value) => send({ id, result: value });
const update = (value) => send({ method: 'session/update', params: { sessionId: 'conversation', update: value } });
let turn;
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    return result(msg.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} }, _meta: { antigravity: { systemPrompt: { append: true } } } } });
  }
  if (msg.method === 'session/new' || msg.method === 'session/resume') {
    if (!msg.params._meta?.antigravity?.systemPrompt?.append.includes('Poki')) process.exit(4);
    if (${needsLogin}) return send({ id: msg.id, error: { code: -32000, message: 'Authentication required' } });
    if (msg.method === 'session/resume') {
      if (msg.params.sessionId !== 'conversation') process.exit(5);
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'history' } });
      return result(msg.id, {});
    }
    return result(msg.id, { sessionId: 'conversation' });
  }
  if (msg.method === 'session/prompt') {
    if (msg.params.sessionId !== 'conversation') process.exit(6);
    turn = msg.id;
    if (msg.params.prompt[0].text.startsWith('Connectivity check.')) {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } });
      return result(turn, { stopReason: 'end_turn' });
    }
    if (msg.params.prompt[0].text === 'slow') {
      return update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
    }
    if (msg.params.prompt[0].text === 'fail') {
      return send({ id: turn, error: { code: -32000, message: 'Model unavailable' } });
    }
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read', rawInput: {} });
    return send({ id: 501, method: 'session/request_permission', params: { sessionId: 'conversation', toolCall: { toolCallId: 'tool-1' }, options: [] } });
  }
  if (msg.method === 'session/cancel') {
    if (msg.params.sessionId !== 'conversation') process.exit(7);
    return result(turn, { stopReason: 'cancelled' });
  }
  if (msg.id === 501 && msg.result?.outcome?.outcome === 'cancelled') {
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'failed', rawOutput: 'denied' });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' ACP' } });
    result(turn, { stopReason: 'end_turn' });
  }
});
`, { mode: 0o755 });
  const adapter = new AgyAdapter({ binary });
  adapter.setBotIdentity({ name: 'Poki', openId: 'ou_test' });
  return { cwd, adapter };
}

describe('agy ACP process', () => {
  it('streams only the current turn after reopening the selected session and declines permission', async () => {
    const { cwd, adapter } = await fixture();
    for (const sessionId of [undefined, 'conversation']) {
      const run = adapter.run({ runId: 'test', cwd, sessionId, prompt: 'hello' });
      const events: AgentEvent[] = [];
      for await (const event of run.events) events.push(event);
      expect(events.filter((event) => event.type === 'text').map((event) => event.delta)).toEqual(['Hello', ' ACP']);
      expect(events).toContainEqual({ type: 'tool_result', id: 'tool-1', output: 'denied', isError: true });
      expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'conversation', terminationReason: 'normal' });
      expect(await run.waitForExit(1000)).toBe(true);
    }
  });

  it('probes ACP with a fresh turn and reports login failure before cutover', async () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'agy',
      accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    });
    const signedIn = await fixture();
    await expect(probeSwitchTarget(signedIn.adapter, profile)).resolves.toBeUndefined();
    const signedOut = await fixture(true);
    await expect(probeSwitchTarget(signedOut.adapter, profile)).rejects.toThrow(/登录、额度和模型配置/);
  });

  it('cancels the active ACP prompt', async () => {
    const { cwd, adapter } = await fixture();
    const run = adapter.run({ runId: 'test', cwd, prompt: 'slow' });
    const events: AgentEvent[] = [];
    let stopping: Promise<void> | undefined;
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'text') stopping = run.stop();
    }
    await stopping;
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'conversation', terminationReason: 'interrupted' });
    expect(await run.waitForExit(1000)).toBe(true);
  });

  it('reports the real unsigned-in response without attempting an interactive login', async () => {
    const { cwd, adapter } = await fixture(true);
    const run = adapter.run({ runId: 'test', cwd, prompt: 'hello' });
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);
    expect(events).toEqual([{
      type: 'error', message: expect.stringContaining('agy acp --login'), terminationReason: 'failed',
    }]);
    expect(await run.waitForExit(1000)).toBe(true);
  });

  it('reports an ACP failure as a single terminal error', async () => {
    const { cwd, adapter } = await fixture();
    const run = adapter.run({ runId: 'test', cwd, prompt: 'fail' });
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);
    expect(events.filter((event) => event.type === 'error' || event.type === 'done')).toEqual([
      { type: 'error', message: 'Model unavailable', terminationReason: 'failed' },
    ]);
    expect(await run.waitForExit(1000)).toBe(true);
  });
});
