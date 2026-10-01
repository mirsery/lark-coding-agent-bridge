import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter.js';
import { translateEvent } from '../../../src/agent/claude/stream-json.js';
import type { AgentEvent } from '../../../src/agent/types.js';

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
