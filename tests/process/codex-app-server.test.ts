import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../src/agent/types.js';
import { initialState, reduce } from '../../src/card/run-state.js';
import { bridgeRoot, guardRefusal, ownerOnlyGuard } from '../../src/policy/owner-guard.js';

const cleanup: string[] = [];
const SUBAGENT_FIXTURE = join(__dirname, '../fixtures/codex-app-server-subagent.jsonl');
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })));
});

/**
 * A stand-in for `codex app-server --listen stdio://` speaking just enough of
 * the protocol: thread/start|resume, turn/start (a reply per turn), and
 * turn/interrupt for turns whose text contains SLOW. Turns containing ASK
 * first send the client an approval request. Turns containing STEER wait for
 * a turn/steer, echo it back as a userMessage item and answer it; LATE turns
 * refuse the steer (the turn was already ending) and finish without it.
 * LIMIT turns fail the way a used-up plan does; account/rateLimits/read then
 * reports the 5-hour window full. SUBAGENT turns replay a real multi-agent
 * turn (tests/fixtures/codex-app-server-subagent.jsonl): an MCP call, a
 * sub-agent whose own thread's items and turn end arrive on the same stream.
 * Given a PreToolUse hook (`-c hooks.PreToolUse=…`) it lists it untrusted
 * until config/value/write trusts it (never, with FAKE_HOOK_TRUST=stuck);
 * BLOCKED turns record a shell call in the thread's rollout, and one of a
 * code-mode cell in the hook's refusal log, and report the hook refusing both. Every message it receives is appended to messages.jsonl;
 * argv goes to argv.json.
 */
async function createFakeAppServer(): Promise<{
  path: string;
  dir: string;
  messages(): Promise<Array<Record<string, any>>>;
  argv(): Promise<string[][]>;
  env(): Promise<Array<Record<string, string | undefined>>>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-app-server-'));
  cleanup.push(dir);
  const path = join(dir, 'fake-codex.mjs');
  const messagesPath = join(dir, 'messages.jsonl');
  const argvPath = join(dir, 'argv.jsonl');
  const rolloutPath = join(dir, 'rollout.jsonl');
  const envPath = join(dir, 'env.jsonl');
  await writeFile(
    path,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('codex-cli 0.159.2'); process.exit(0); }
appendFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv) + '\\n');
appendFileSync(${JSON.stringify(envPath)}, JSON.stringify({ LARK_CHANNEL_HOOK_REFUSALS: process.env.LARK_CHANNEL_HOOK_REFUSALS }) + '\\n');
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const hookFlag = argv.find((a) => a.startsWith('hooks.PreToolUse='));
const hookCommand = hookFlag ? JSON.parse(/command=("(?:[^"\\\\]|\\\\.)*")/.exec(hookFlag)[1]) : undefined;
let hookTrusted = false;
const rollout = ${JSON.stringify(rolloutPath)};
let turns = 0; let slow; let asked; let gated; let steering; const decisions = [];
const finish = (threadId, turnId, status, text) => {
  if (text) send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: 'm' + turnId, text } } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 105 }, total: {} } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status, error: null } } });
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  appendFileSync(${JSON.stringify(messagesPath)}, line + '\\n');
  if (gated && (msg.id === 501 || msg.id === 502)) {
    decisions.push(msg.result?.decision);
    if (gated.step === 'command') {
      gated.step = 'file';
      send({ method: 'item/started', params: { threadId: gated.threadId, turnId: gated.turnId, item: { type: 'fileChange', id: 'fc-1', status: 'inProgress', changes: [{ path: '/repo/notes.md', kind: { type: 'add' }, diff: 'hi' }] } } });
      return send({ id: 502, method: 'item/fileChange/requestApproval', params: { threadId: gated.threadId, turnId: gated.turnId, itemId: 'fc-1', startedAtMs: 2 } });
    }
    const g = gated; gated = undefined;
    return finish(g.threadId, g.turnId, 'completed', 'decisions: ' + decisions.join(','));
  }
  if (msg.method === 'account/rateLimits/read') {
    return send({ id: msg.id, result: { ordinaryUsageAllowed: false, rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1792758907 }, secondary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: 1793326168 }, rateLimitReachedType: 'rate_limit_reached' } } });
  }
  if (msg.method === 'turn/steer') {
    const s = steering; steering = undefined;
    if (!s || s.late || msg.params.expectedTurnId !== s.turnId) {
      send({ id: msg.id, error: { code: -32600, message: 'no active turn to steer' } });
      if (s) finish(s.threadId, s.turnId, 'completed', 'reply without steer');
      return;
    }
    send({ id: msg.id, result: { turnId: s.turnId } });
    send({ method: 'item/started', params: { threadId: s.threadId, turnId: s.turnId, item: { type: 'userMessage', id: 'u-' + s.turnId, clientId: msg.params.clientUserMessageId, content: msg.params.input } } });
    return finish(s.threadId, s.turnId, 'completed', 'steered: ' + msg.params.input[0].text);
  }
  if (msg.id === 99 && asked) { const a = asked; asked = undefined; return finish(a.threadId, a.turnId, 'completed', 'after refusal'); }
  if (msg.method === 'initialize') return send({ id: msg.id, result: { userAgent: 'fake' } });
  if (msg.method === 'hooks/list') {
    const hooks = hookCommand ? [{ key: 'flags:pre_tool_use:0:0', source: 'sessionFlags', eventName: 'preToolUse', handlerType: 'command', command: hookCommand, currentHash: 'h1', trustStatus: hookTrusted ? 'trusted' : 'untrusted' }] : [];
    return send({ id: msg.id, result: { data: [{ cwd: msg.params.cwds[0], hooks }] } });
  }
  if (msg.method === 'config/value/write') { hookTrusted = process.env.FAKE_HOOK_TRUST !== 'stuck'; return send({ id: msg.id, result: {} }); }
  if (msg.method === 'thread/start') return send({ id: msg.id, result: { thread: { id: 'thr-new', path: rollout } } });
  if (msg.method === 'thread/resume') return send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
  if (msg.method === 'turn/start') {
    const turnId = 'turn-' + (++turns);
    const threadId = msg.params.threadId;
    const text = msg.params.input[0].text;
    send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
    if (text.includes('ASK')) {
      // Hold the turn until the client answers, as Codex would.
      asked = { threadId, turnId };
      return send({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId, turnId } });
    }
    if (text.includes('SLOW')) { slow = { threadId, turnId }; return; }
    if (text.includes('SUBAGENT')) {
      const lines = readFileSync(${JSON.stringify(SUBAGENT_FIXTURE)}, 'utf8').trim().split('\\n');
      for (const l of lines) process.stdout.write(l.replaceAll('MAIN_THREAD', threadId) + '\\n');
      return;
    }
    if (text.includes('LIMIT')) {
      const error = { message: 'You’ve hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/settings/usage to purchase more credits or try again at 8:35 PM.', codexErrorInfo: 'usageLimitExceeded' };
      send({ method: 'error', params: { error, willRetry: false, threadId, turnId } });
      return send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed', error } } });
    }
    if (text.includes('BLOCKED')) {
      appendFileSync(rollout, JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_x', arguments: JSON.stringify({ cmd: 'cat secret.txt', workdir: '/private' }) } }) + '\\n');
      send({ method: 'hook/completed', params: { threadId, turnId, run: { id: 'pre-tool-use:0:/<session-flags>/config.toml:call_x', eventName: 'preToolUse', source: 'sessionFlags', status: 'blocked', entries: [{ kind: 'feedback', text: '这条命令会访问未对外开放的位置 /private。请停止这一步。' }] } } });
      // A code-mode cell's call: only the hook's refusal log has it.
      appendFileSync(process.env.LARK_CHANNEL_HOOK_REFUSALS, JSON.stringify({ id: 'exec-9', tool: 'Bash', input: { command: 'cat /private/key' } }) + '\\n');
      send({ method: 'hook/completed', params: { threadId, turnId, run: { id: 'pre-tool-use:0:/<session-flags>/config.toml:exec-9', eventName: 'preToolUse', source: 'sessionFlags', status: 'blocked', entries: [{ kind: 'feedback', text: '这条命令会访问未对外开放的位置 /private/key。' }] } } });
      return finish(threadId, turnId, 'completed', 'not allowed');
    }
    if (text.includes('STEER') || text.includes('LATE')) { steering = { threadId, turnId, late: text.includes('LATE') }; return; }
    if (text.includes('TOUCH')) {
      gated = { threadId, turnId, step: 'command' };
      return send({ id: 501, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'cmd-1', command: "/bin/zsh -lc 'touch x.txt'", proposedExecpolicyAmendment: ['/bin/zsh', '-lc', 'touch x.txt'], startedAtMs: 1 } });
    }
    return finish(threadId, turnId, 'completed', 'reply ' + turns);
  }
  if (msg.method === 'turn/interrupt') {
    send({ id: msg.id, result: {} });
    if (slow) finish(slow.threadId, slow.turnId, 'interrupted');
    return;
  }
});
process.stdin.on('end', () => process.exit(0));
`,
    'utf8',
  );
  await chmod(path, 0o755);
  const readJsonl = async (p: string) =>
    (await readFile(p, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { path, dir, messages: () => readJsonl(messagesPath), argv: () => readJsonl(argvPath), env: () => readJsonl(envPath) };
}

async function nextTurn(iterator: AsyncIterator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
    out.push(next.value);
    if (next.value.type === 'done' || next.value.type === 'error') break;
  }
  return out;
}

async function preparedRun(adapter: CodexAdapter, opts: AgentRunOptions): Promise<AgentRun> {
  await adapter.prepareRun(opts);
  return adapter.run(opts);
}

describe('Codex app-server transport', () => {
  it.each([undefined, 'thr-old'])('forwards smart-session compaction to app-server (%s)', async (threadId) => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir });
    const run = await preparedRun(adapter, { runId: 'compact', cwd, prompt: 'hello', threadId, compactWindowTokens: 300000 });
    try {
      await nextTurn(run.events[Symbol.asyncIterator]());
      expect((await fake.argv())[0]).toContain('model_auto_compact_token_limit=300000');
    } finally {
      run.endInput?.();
      await run.waitForExit(2000);
    }
  });
  it('serves later turns of the conversation from the same process', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: join(fake.dir, 'home') });
    const run = await preparedRun(adapter, { runId: 'r1', prompt: 'first', cwd, model: 'gpt-6-luna', effort: 'low', sandbox: 'workspace-write' });
    const events = run.events[Symbol.asyncIterator]();

    expect(await nextTurn(events)).toEqual([
      { type: 'system', threadId: 'thr-new' },
      { type: 'final_text', content: 'reply 1' },
      { type: 'usage', inputTokens: 100, cachedInputTokens: 60, outputTokens: 5, reasoningOutputTokens: 0 },
      { type: 'done', threadId: 'thr-new', terminationReason: 'normal' },
    ]);
    expect(run.send?.('second')).toBe(true);
    expect((await nextTurn(events)).find((e) => e.type === 'final_text')).toEqual({ type: 'final_text', content: 'reply 2' });

    run.endInput?.();
    expect(await run.waitForExit(2_000)).toBe(true);
    expect(run.send?.('third')).toBe(false);

    expect(await fake.argv()).toEqual([['app-server', '--listen', 'stdio://', '-c', 'approval_policy="never"', '-c', 'shell_environment_policy.inherit="all"']]);
    const messages = await fake.messages();
    expect(messages.map((m) => m.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start', 'turn/start']);
    expect(messages[2]?.params).toEqual({ cwd, sandbox: 'workspace-write', approvalPolicy: 'never', model: 'gpt-6-luna' });
    expect(messages[3]?.params).toMatchObject({ threadId: 'thr-new', effort: 'low' });
    // Every turn carries the bridge system prompt, like the exec path's stdin.
    expect(messages[3]?.params.input[0].text).toContain('lark-channel-bridge');
    expect(messages[3]?.params.input[0].text).toContain('first');
    expect(messages[4]?.params.input[0].text).toContain('second');
  });

  it('resumes an existing thread', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: join(fake.dir, 'home') });
    const run = await preparedRun(adapter, { runId: 'r2', prompt: 'again', cwd, threadId: 'thr-old' });
    const turn = await nextTurn(run.events[Symbol.asyncIterator]());
    expect(turn.at(-1)).toEqual({ type: 'done', threadId: 'thr-old', terminationReason: 'normal' });
    expect((await fake.messages())[2]).toMatchObject({ method: 'thread/resume', params: { threadId: 'thr-old' } });
    await run.stop();
  });

  it('interrupts a running turn through the protocol on stop', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: join(fake.dir, 'home') });
    const run = await preparedRun(adapter, { runId: 'r3', prompt: 'SLOW work', cwd, stopGraceMs: 1_000 });
    const events = run.events[Symbol.asyncIterator]();
    expect((await events.next()).value).toEqual({ type: 'system', threadId: 'thr-new' });
    // Let the turn get going before stopping it.
    await new Promise((resolve) => setTimeout(resolve, 150));

    await run.stop();
    const rest = await nextTurn(events);
    expect(rest.at(-1)).toEqual({ type: 'done', threadId: 'thr-new', terminationReason: 'interrupted' });
    expect((await fake.messages()).map((m) => m.method)).toContain('turn/interrupt');
    expect(await run.waitForExit(1_000)).toBe(true);
  });

  it('refuses requests from the server instead of leaving Codex waiting', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: join(fake.dir, 'home') });
    const run = await preparedRun(adapter, { runId: 'r4', prompt: 'ASK first', cwd });
    await nextTurn(run.events[Symbol.asyncIterator]());
    const refusal = (await fake.messages()).find((m) => m.id === 99);
    expect(refusal?.error).toMatchObject({ code: -32601 });
    await run.stop();
  });

  it('stays on codex exec when the profile needs exec-only behaviour', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const home = join(fake.dir, 'home');
    const exec = async (adapter: CodexAdapter, runId: string): Promise<boolean> => {
      const run = await preparedRun(adapter, { runId, prompt: 'x', cwd });
      await run.stop();
      return run.send === undefined;
    };
    expect(await exec(new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: home, transport: 'exec' }), 'e1')).toBe(true);
    expect(await exec(new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: home, ignoreUserConfig: true }), 'e2')).toBe(true);
    // ignoreRules (the default) must keep execpolicy rules out, which only exec can do.
    await mkdir(join(home, 'rules'), { recursive: true });
    await writeFile(join(home, 'rules', 'default.rules'), 'prefix_rule(pattern=["rm"], decision="forbidden")\n');
    expect(await exec(new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: home }), 'e3')).toBe(true);
    expect(await exec(new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: home, ignoreRules: false }), 'e4')).toBe(false);
  });

  it('falls back to codex exec for later runs once the app-server cannot start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-no-app-server-'));
    cleanup.push(dir);
    const path = join(dir, 'old-codex.mjs');
    // An older Codex: answers --version, but has no app-server subcommand.
    await writeFile(
      path,
      `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('codex-cli 0.40.0'); process.exit(0); }
if (process.argv[2] === 'app-server') { console.error("error: unrecognized subcommand 'app-server'"); process.exit(2); }
process.stdin.resume(); process.stdin.on('end', () => { console.log(JSON.stringify({ type: 'turn.completed' })); process.exit(0); });
`,
      'utf8',
    );
    await chmod(path, 0o755);
    const cwd = await realpath(dir);
    const adapter = new CodexAdapter({ binary: path, profileStateDir: dir, codexHome: join(dir, 'home') });

    const first = await preparedRun(adapter, { runId: 'f1', prompt: 'x', cwd });
    const firstEvents = await nextTurn(first.events[Symbol.asyncIterator]());
    expect(firstEvents.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('start-up failed') });

    const second = await preparedRun(adapter, { runId: 'f2', prompt: 'y', cwd });
    expect(second.send).toBeUndefined();
    expect((await nextTurn(second.events[Symbol.asyncIterator]())).at(-1)).toMatchObject({ type: 'done' });
  });

  it('asks the bridge before commands and file changes on a gated run, inside a read-only sandbox', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const asked: Array<{ tool: string; summary: string }> = [];
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: join(fake.dir, 'home') });
    const run = await preparedRun(adapter, {
      runId: 'g1',
      prompt: 'TOUCH and write notes',
      cwd,
      sandbox: 'danger-full-access',
      approvals: {
        decide: async (request) => {
          asked.push(request);
          return request.tool === 'command_execution'
            ? { decision: 'allow', reason: 'ok' }
            : { decision: 'deny', reason: 'no' };
        },
      },
    });
    const turn = await nextTurn(run.events[Symbol.asyncIterator]());

    expect(asked).toEqual([
      // Codex wraps every command in its shell; the bridge judges and shows the script inside.
      { tool: 'command_execution', summary: 'touch x.txt', readOnly: false, command: 'touch x.txt' },
      { tool: 'file_change', summary: '修改文件：/repo/notes.md' },
    ]);
    expect(turn).toContainEqual({ type: 'final_text', content: 'decisions: accept,decline' });
    expect(turn).toContainEqual({ type: 'tool_use', id: 'fc-1', name: 'file_change', input: { paths: ['/repo/notes.md'] } });
    expect((await fake.messages())[2]?.params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'untrusted' });
    await run.stop();
  });

  it('reads a mid-turn supplement into the running turn with turn/steer', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: join(fake.dir, 'home') });
    const run = await preparedRun(adapter, { runId: 's1', prompt: 'STEER me', cwd });
    const events = run.events[Symbol.asyncIterator]();
    expect((await events.next()).value).toEqual({ type: 'system', threadId: 'thr-new' });
    await waitFor(async () => (await fake.messages()).some((m) => m.method === 'turn/start'));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(run.inject?.('also add tests', 'also add tests')).toBe(true);
    const turn = await nextTurn(events);
    expect(turn).toEqual([
      { type: 'supplement', preview: 'also add tests' },
      { type: 'final_text', content: 'steered: also add tests' },
      { type: 'usage', inputTokens: 100, cachedInputTokens: 60, outputTokens: 5, reasoningOutputTokens: 0 },
      { type: 'done', threadId: 'thr-new', terminationReason: 'normal' },
    ]);
    const steer = (await fake.messages()).find((m) => m.method === 'turn/steer');
    expect(steer?.params).toMatchObject({
      threadId: 'thr-new',
      expectedTurnId: 'turn-1',
      clientUserMessageId: expect.any(String),
      input: [{ type: 'text', text: 'also add tests' }],
    });
    // The turn is over: the next supplement is the caller's to queue.
    expect(run.inject?.('too late', 'too late')).toBe(false);
    await run.stop();
  });

  it('runs a supplement the turn could no longer take as a follow-up turn of the same reply', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: join(fake.dir, 'home') });
    const run = await preparedRun(adapter, { runId: 's2', prompt: 'LATE one', cwd });
    const events = run.events[Symbol.asyncIterator]();
    expect((await events.next()).value).toEqual({ type: 'system', threadId: 'thr-new' });
    await waitFor(async () => (await fake.messages()).some((m) => m.method === 'turn/start'));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(run.inject?.('one more thing', 'one more thing')).toBe(true);
    // One reply: the first answer turns into progress text, the follow-up
    // turn answers last, usage covers both, and there is a single done.
    expect(await nextTurn(events)).toEqual([
      { type: 'text', delta: 'reply without steer' },
      { type: 'supplement', preview: 'one more thing' },
      { type: 'system', threadId: 'thr-new' },
      { type: 'final_text', content: 'reply 2' },
      { type: 'usage', inputTokens: 200, cachedInputTokens: 120, outputTokens: 10, reasoningOutputTokens: 0 },
      { type: 'done', threadId: 'thr-new', terminationReason: 'normal' },
    ]);
    const starts = (await fake.messages()).filter((m) => m.method === 'turn/start');
    expect(starts).toHaveLength(2);
    expect(starts[1]?.params.input[0].text).toBe('one more thing');
    await run.stop();
  });

  it('pauses on a used-up plan with the window and reset Codex reports, without touching reset credits', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: join(fake.dir, 'home') });
    const run = await preparedRun(adapter, { runId: 'q1', prompt: 'LIMIT reached', cwd });
    const turn = await nextTurn(run.events[Symbol.asyncIterator]());
    expect(turn.slice(-2)).toEqual([
      expect.objectContaining({ type: 'rate_limit', blocked: true, limitType: 'five_hour', resetsAt: 1792758907_000 }),
      expect.objectContaining({ type: 'error', message: expect.stringContaining('usage limit') }),
    ]);
    expect(turn.reduce(reduce, initialState)).toMatchObject({ terminal: 'paused', limit: { limitType: 'five_hour', resetsAt: 1792758907_000 } });
    const methods = (await fake.messages()).map((m) => m.method);
    expect(methods).toContain('account/rateLimits/read');
    expect(methods.filter((m) => /credit/i.test(m ?? ''))).toEqual([]);
    await run.stop();
  });

  it('keeps a sub-agent\'s own thread out of the reply and shows its steps as sub-agent activity', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: join(fake.dir, 'home') });
    const run = await preparedRun(adapter, { runId: 'sub1', prompt: 'SUBAGENT go', cwd });
    const turn = await nextTurn(run.events[Symbol.asyncIterator]());

    // The sub-agent's answer and turn end are not the reply's.
    expect(turn.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(turn.find((e) => e.type === 'final_text')).toEqual({ type: 'final_text', content: 'MAIN done' });
    expect(turn.some((e) => e.type === 'text' && e.delta.includes('child finished'))).toBe(false);
    // Steps that used to be invisible: the MCP call and the sub-agent calls.
    const tools = turn.filter((e) => e.type === 'tool_use').map((e) => e.type === 'tool_use' && [e.name, e.input]);
    expect(tools).toEqual([
      ['mcp__echo__say', { text: 'hello mcp' }],
      ['Agent', { description: '启动子 agent：CHILD-TASK: run echo child-step' }],
      ['Agent', { description: '等待子 agent' }],
    ]);
    expect(turn).toContainEqual({ type: 'tool_result', id: expect.any(String), output: 'echo: hello mcp', isError: false });
    // The sub-agent's command shows under the wait call, without the command itself.
    const waitId = turn.find((e) => e.type === 'tool_use' && (e.input as { description?: string }).description === '等待子 agent');
    expect(turn).toContainEqual(
      expect.objectContaining({ type: 'subagent_activity', parentToolUseId: (waitId as { id: string }).id, tool: 'command_execution', description: '运行命令' }),
    );
    const state = turn.reduce(reduce, initialState);
    expect(state.terminal).toBe('done');
    expect(state.blocks.filter((b) => b.kind === 'tool').every((b) => b.kind === 'tool' && b.tool.status === 'done')).toBe(true);
    await run.stop();
  });

  it('refuses a supplement before the turn is under way and on the exec transport', async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const home = join(fake.dir, 'home');
    const run = await preparedRun(new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: home }), { runId: 's3', prompt: 'hi', cwd });
    // Still opening the conversation: nothing to steer yet.
    expect(run.inject?.('early', 'early')).toBe(false);
    await nextTurn(run.events[Symbol.asyncIterator]());
    expect(run.inject?.('after', 'after')).toBe(false);
    await run.stop();

    const exec = await preparedRun(new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: home, transport: 'exec' }), { runId: 's4', prompt: 'x', cwd });
    expect(exec.inject).toBeUndefined();
    await exec.stop();
  });

  it("trusts the bridge's hook before a guest's turn, and shows the calls it refuses", async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const guard = ownerOnlyGuard({ larkChannelHome: join(cwd, '.lark-channel'), workspace: cwd, home: cwd, root: bridgeRoot() });
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: join(fake.dir, 'home') });
    const run = await preparedRun(adapter, { runId: 'h1', prompt: 'BLOCKED read the secret', cwd, guard });
    const turn = await nextTurn(run.events[Symbol.asyncIterator]());
    await run.stop();

    expect((await fake.argv())[0]).toEqual(expect.arrayContaining(['features.unified_exec_tty=false', expect.stringMatching(/^hooks\.PreToolUse=/)]));
    expect((await fake.messages()).map((m) => m.method).slice(0, 7)).toEqual([
      'initialize',
      'initialized',
      'hooks/list',
      'config/value/write',
      'hooks/list',
      'thread/start',
      'turn/start',
    ]);
    expect(turn).toContainEqual({ type: 'tool_use', id: 'call_x', name: 'command_execution', input: { command: 'cd /private && cat secret.txt' } });
    const refused = turn.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.id === 'call_x');
    expect(refused?.isError).toBe(true);
    expect(guardRefusal(refused?.output ?? '')).toBe('这条命令会访问未对外开放的位置 /private');
    expect(turn).toContainEqual({ type: 'tool_use', id: 'exec-9', name: 'command_execution', input: { command: 'cat /private/key' } });
    expect(turn.at(-1)).toMatchObject({ type: 'done' });
    // The log goes with the process.
    const log = (await fake.env()).at(0)?.LARK_CHANNEL_HOOK_REFUSALS as string;
    await waitFor(async () => !existsSync(dirname(log)));
  });

  it("never runs a guest's turn on a hook it could not trust, and sends later hooked runs through exec", async () => {
    const fake = await createFakeAppServer();
    const cwd = await realpath(fake.dir);
    const guard = ownerOnlyGuard({ larkChannelHome: join(cwd, '.lark-channel'), workspace: cwd, home: cwd, root: bridgeRoot() });
    const adapter = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir, codexHome: join(fake.dir, 'home'), env: { FAKE_HOOK_TRUST: 'stuck' } });

    const first = await preparedRun(adapter, { runId: 't1', prompt: 'x', cwd, guard });
    expect((await nextTurn(first.events[Symbol.asyncIterator]())).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('still untrusted') });
    expect((await fake.messages()).map((m) => m.method)).not.toContain('thread/start');

    // The owner's runs need no hook and stay on the app-server.
    const owner = await preparedRun(adapter, { runId: 't2', prompt: 'x', cwd });
    expect(owner.send).toBeDefined();
    await owner.stop();

    const guest = await preparedRun(adapter, { runId: 't3', prompt: 'x', cwd, guard });
    expect(guest.send).toBeUndefined();
    await waitFor(async () => (await fake.argv()).length === 3);
    await guest.stop();
    expect((await fake.argv()).at(-1)?.slice(0, 2)).toEqual(['--dangerously-bypass-hook-trust', 'exec']);
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
