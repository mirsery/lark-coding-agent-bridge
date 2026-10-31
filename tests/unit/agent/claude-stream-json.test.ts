import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter.js';
import {
  encodeUserMessage,
  isFailedResult,
  replayedUuid,
  translateEvent,
} from '../../../src/agent/claude/stream-json.js';
import type { AgentEvent } from '../../../src/agent/types.js';

/** `claude -p` on a rejected login (captured with a bad token; wording from the revoked-token incident). */
const AUTH_FAILED_LINES = readFileSync(join(__dirname, '..', '..', 'fixtures', 'claude-auth-failed-stream.jsonl'), 'utf8')
  .trim()
  .split('\n');
const AUTH_FAILED_TEXT = 'Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.';

describe('Claude stream-json translator', () => {
  it('translates system init metadata', () => {
    expect([
      ...translateEvent({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        cwd: '/repo',
        model: 'sonnet',
      }),
    ]).toEqual([
      { type: 'system', sessionId: 'sess-1', cwd: '/repo', model: 'sonnet' },
    ]);
    expect([...translateEvent({ type: 'system', subtype: 'init', session_id: 'sess-1' })][0]).not.toHaveProperty('threadId');
  });

  it('keeps subagent content off the card, passing on only that it is active', () => {
    const sub = { parent_tool_use_id: 'toolu_agent_1' };
    expect([
      ...translateEvent({
        type: 'assistant',
        ...sub,
        message: {
          content: [
            { type: 'text', text: 'subagent report' },
            {
              type: 'tool_use',
              id: 'tool-sub',
              name: 'Bash',
              input: { command: 'mvn verify', description: '运行全量构建' },
            },
          ],
        },
      }),
      ...translateEvent({
        type: 'user',
        ...sub,
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-sub', content: 'x' }] },
      }),
    ]).toEqual([
      {
        type: 'subagent_activity',
        parentToolUseId: 'toolu_agent_1',
        tool: 'Bash',
        description: '运行全量构建',
        at: expect.any(Number),
      },
    ]);
    expect([
      ...translateEvent({
        type: 'assistant',
        ...sub,
        message: { content: [{ type: 'text', text: 'thinking out loud' }] },
      }),
    ]).toEqual([{ type: 'subagent_activity', parentToolUseId: 'toolu_agent_1', at: expect.any(Number) }]);
    expect([
      ...translateEvent({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'main answer' }] },
      }),
    ]).toEqual([{ type: 'text', delta: 'main answer' }]);
  });

  it('translates assistant text, thinking, and tool_use blocks in order', () => {
    expect([
      ...translateEvent({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'thinking', thinking: 'checking' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      }),
    ]).toEqual([
      { type: 'text', delta: 'hello' },
      { type: 'thinking', delta: 'checking' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ]);
  });

  it('translates user tool_result blocks including structured output and errors', () => {
    expect([
      ...translateEvent({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
            {
              type: 'tool_result',
              tool_use_id: 'tool-2',
              content: [{ type: 'text', text: 'bad' }],
              is_error: true,
            },
          ],
        },
      }),
    ]).toEqual([
      { type: 'tool_result', id: 'tool-1', output: 'ok', isError: false },
      {
        type: 'tool_result',
        id: 'tool-2',
        output: JSON.stringify([{ type: 'text', text: 'bad' }]),
        isError: true,
      },
    ]);
  });

  it('translates result usage before done', () => {
    expect([
      ...translateEvent({
        type: 'result',
        session_id: 'sess-2',
        usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5 },
        total_cost_usd: 0.1234,
      }),
    ]).toEqual([
      { type: 'usage', inputTokens: 17, outputTokens: 34, cachedInputTokens: 5, costUsd: 0.1234 },
      { type: 'done', sessionId: 'sess-2', terminationReason: 'normal' },
    ]);
    expect([...translateEvent({ type: 'result', session_id: 'sess-2' })][0]).not.toHaveProperty('threadId');
  });

  it('turns a rejected login into a failed turn rather than an answer', () => {
    const assistant = JSON.parse(AUTH_FAILED_LINES.find((line) => line.includes('"assistant"'))!);
    expect([...translateEvent(assistant)]).toEqual([
      { type: 'error', message: AUTH_FAILED_TEXT, terminationReason: 'failed', cause: 'auth' },
    ]);
    // The retries before it are the CLI's own business.
    expect([...translateEvent(JSON.parse(AUTH_FAILED_LINES[1]!))]).toEqual([]);
  });

  it('ignores unknown, empty, and incomplete raw events', () => {
    expect([...translateEvent(null)]).toEqual([]);
    expect([...translateEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '' }] } })]).toEqual([]);
    expect([...translateEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' }] } })]).toEqual([]);
    expect([...translateEvent({ type: 'system', subtype: 'other' })]).toEqual([]);
  });
});

describe('Claude stream-json reader behavior', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('skips non-JSON stdout lines and reports non-zero stderr detail without redacting visible paths', async () => {
    const stderr = 'fatal stderr at /Users/example/work/repo/file.ts';
    const binary = await createFakeBinary([
      'not json',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'kept' }] } }),
    ], 7, stderr);
    cleanup = binary.cleanup;

    const run = new ClaudeAdapter({ binary: binary.path }).run({
      runId: 'run-reader',
      prompt: 'hi',
      cwd: tmpdir(),
    });
    const events = await collect(run.events);

    expect(events).toEqual([
      { type: 'text', delta: 'kept' },
      {
        type: 'error',
        message: `claude exited with code 7: ${stderr}`,
        terminationReason: 'failed',
      },
    ]);
  });

  it('does not end the run on the no-turn result a resume emits for leftover task notifications', async () => {
    // Shape captured from `claude -p --resume` on a session whose background
    // Bash died with the previous process.
    const binary = await createFakeBinary([
      JSON.stringify({ type: 'system', subtype: 'task_notification' }),
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-r' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: '', num_turns: 0, session_id: 'sess-r' }),
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-r' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'answer', num_turns: 1, session_id: 'sess-r' }),
    ], 0, '');
    cleanup = binary.cleanup;

    const run = new ClaudeAdapter({ binary: binary.path }).run({
      runId: 'run-resume-notification',
      prompt: 'hi',
      cwd: tmpdir(),
      sessionId: 'sess-r',
    });
    const events = await collect(run.events);

    expect(events.filter((e) => e.type !== 'system')).toEqual([
      { type: 'text', delta: 'answer' },
      { type: 'done', sessionId: 'sess-r', terminationReason: 'normal' },
    ]);
  });

  it('reports each turn its own cost although Claude accumulates it over the process', async () => {
    const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 };
    const binary = await createFakeBinary([
      JSON.stringify({ type: 'result', num_turns: 1, session_id: 's', usage, total_cost_usd: 0.02 }),
      JSON.stringify({ type: 'result', num_turns: 1, session_id: 's', usage, total_cost_usd: 0.035 }),
    ], 0, '');
    cleanup = binary.cleanup;

    const run = new ClaudeAdapter({ binary: binary.path }).run({ runId: 'run-cost', prompt: 'hi', cwd: tmpdir() });
    const usages = (await collect(run.events)).filter((e) => e.type === 'usage');

    expect(usages).toHaveLength(2);
    expect(usages[0]).toMatchObject({ inputTokens: 1060, cachedInputTokens: 1000, outputTokens: 20, costUsd: 0.02 });
    expect((usages[1] as { costUsd: number }).costUsd).toBeCloseTo(0.015, 10);
  });

  it('subtracts the session total Claude restores on resume from the first turn', async () => {
    const usage = { input_tokens: 64, output_tokens: 13164, cache_read_input_tokens: 12936660, cache_creation_input_tokens: 426269 };
    const binary = await createFakeBinary([
      JSON.stringify({ type: 'result', num_turns: 1, session_id: 'sess-c', usage, total_cost_usd: 161.8928 }),
      JSON.stringify({ type: 'result', num_turns: 1, session_id: 'sess-c', usage, total_cost_usd: 162.5 }),
    ], 0, '');
    cleanup = binary.cleanup;
    const config = await mkdtemp(join(tmpdir(), 'claude-config-'));
    await mkdir(join(config, 'projects', 'p'), { recursive: true });
    await writeFile(join(config, 'projects', 'p', 'sess-c.jsonl'), `${JSON.stringify({ type: 'cost-state', sessionId: 'sess-c', totalCostUSD: 155.6318 })}\n`);
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      const run = new ClaudeAdapter({ binary: binary.path }).run({ runId: 'run-resumed-cost', prompt: 'hi', cwd: tmpdir(), sessionId: 'sess-c' });
      const costs = (await collect(run.events)).filter((e) => e.type === 'usage').map((e) => (e as { costUsd: number }).costUsd);
      expect(costs[0]).toBeCloseTo(6.261, 3);
      expect(costs[1]).toBeCloseTo(0.6072, 4);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      await rm(config, { recursive: true, force: true });
    }
  });

  it('counts from zero when the resumed session had no total to restore', async () => {
    const usage = { input_tokens: 10, output_tokens: 20 };
    const binary = await createFakeBinary([
      JSON.stringify({ type: 'result', num_turns: 1, session_id: 'sess-z', usage, total_cost_usd: 0.4 }),
    ], 0, '');
    cleanup = binary.cleanup;
    const config = await mkdtemp(join(tmpdir(), 'claude-config-'));
    await mkdir(join(config, 'projects', 'p'), { recursive: true });
    // A saved total above what Claude reports: it restored nothing this time.
    await writeFile(join(config, 'projects', 'p', 'sess-z.jsonl'), `${JSON.stringify({ type: 'cost-state', sessionId: 'sess-z', totalCostUSD: 9 })}\n`);
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      const run = new ClaudeAdapter({ binary: binary.path }).run({ runId: 'run-unrestored', prompt: 'hi', cwd: tmpdir(), sessionId: 'sess-z' });
      const usages = (await collect(run.events)).filter((e) => e.type === 'usage');
      expect(usages).toEqual([expect.objectContaining({ costUsd: 0.4 })]);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      await rm(config, { recursive: true, force: true });
    }
  });

  it('ends a rejected login with its error: no done after it, no bare exit code', async () => {
    const binary = await createFakeBinary(AUTH_FAILED_LINES, 1, '');
    cleanup = binary.cleanup;

    const run = new ClaudeAdapter({ binary: binary.path }).run({ runId: 'run-auth', prompt: 'hi', cwd: tmpdir() });
    const events = (await collect(run.events)).filter((e) => e.type !== 'system' && e.type !== 'usage');

    expect(events).toEqual([{ type: 'error', message: AUTH_FAILED_TEXT, terminationReason: 'failed', cause: 'auth' }]);
  });

  it('still reports done when a no-turn result is the only result before exit', async () => {
    const binary = await createFakeBinary([
      JSON.stringify({ type: 'result', subtype: 'success', result: '', num_turns: 0, session_id: 'sess-e' }),
    ], 0, '');
    cleanup = binary.cleanup;

    const run = new ClaudeAdapter({ binary: binary.path }).run({
      runId: 'run-no-turn-only',
      prompt: 'hi',
      cwd: tmpdir(),
    });

    await expect(collect(run.events)).resolves.toEqual([
      { type: 'done', sessionId: 'sess-e', terminationReason: 'normal' },
    ]);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeBinary(lines: string[], exitCode: number, stderr: string): Promise<{
  path: string;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-stream-json-test-'));
  const path = join(dir, 'fake-claude.mjs');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      `const lines = ${JSON.stringify(lines)};`,
      'for (const line of lines) console.log(line);',
      `process.stderr.write(${JSON.stringify(stderr)});`,
      `process.exit(${exitCode});`,
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return {
    path,
    cleanup: async () => {
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('streamed input bookkeeping', () => {
  it('tags a message with its uuid and recognizes the CLI replaying it', () => {
    const line = JSON.parse(encodeUserMessage('hi', 'u-1'));
    expect(line).toEqual({ type: 'user', uuid: 'u-1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
    // Shape from `claude -p --replay-user-messages` 2.1.296.
    expect(replayedUuid({ type: 'user', isReplay: true, uuid: 'u-1', message: { role: 'user', content: [] } })).toBe('u-1');
    expect(replayedUuid({ type: 'user', uuid: 'u-2', message: { content: [{ type: 'tool_result' }] } })).toBeUndefined();
  });

  it('tells failed results apart', () => {
    expect(isFailedResult({ type: 'result', subtype: 'success', is_error: false })).toBe(false);
    expect(isFailedResult({ type: 'result', subtype: 'error_during_execution' })).toBe(true);
    expect(isFailedResult({ type: 'result', subtype: 'success', is_error: true })).toBe(true);
    expect(isFailedResult({ type: 'assistant' })).toBe(false);
  });
});
