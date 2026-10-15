import { describe, expect, it, vi, afterEach } from 'vitest';
import { translateEvent } from '../../../src/agent/claude/stream-json';
import type { AgentEvent } from '../../../src/agent/types';
import { processAgentStream } from '../../../src/bot/agent-stream';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { runningToolLabel } from '../../../src/card/run-activity';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState, reduce, type RunState } from '../../../src/card/run-state';
import { log } from '../../../src/core/logger';
import { createFakeAgent } from '../../helpers/fake-agent';

const start: AgentEvent = { type: 'tool_use', id: 'a', name: 'Agent', input: { description: '升级依赖' } };
const step: AgentEvent = { type: 'subagent_activity', parentToolUseId: 'a', tool: 'Bash', description: '运行全量构建', at: 1 };

afterEach(() => { vi.restoreAllMocks(); });

describe('subagent progress', () => {
  it('keeps long child reports and thinking out of the reply, showing only the step', () => {
    const raw = { type: 'assistant', parent_tool_use_id: 'a', message: { content: [
      { type: 'text', text: 'PRIVATE'.repeat(10000) },
      { type: 'thinking', thinking: 'PRIVATE' },
      { type: 'tool_use', id: 'child', name: 'Bash', input: { description: '运行全量构建', command: 'SECRET' } },
    ] } };
    const events = [...translateEvent(raw)];
    const state = [start, ...events].reduce(reduce, initialState);
    const card = JSON.stringify(renderCard(state));
    expect(card).toContain('升级依赖（Agent） › 子任务：运行全量构建');
    expect(card).not.toContain('PRIVATE');
    expect(card).not.toContain('SECRET');
    expect(state.blocks).toHaveLength(1);
  });

  it('shows parallel child activity under its running parent, then clears it when the parent ends', () => {
    let state = [start, { ...start, id: 'b' }, step].reduce(reduce, initialState);
    expect(runningToolLabel(state)).toContain('子任务：运行全量构建');
    state = reduce(state, { type: 'tool_result', id: 'a', output: 'done', isError: false });
    expect(runningToolLabel(state)).toBe('升级依赖（Agent）');
    state = reduce(state, { ...step, parentToolUseId: 'b', description: 'Run build' });
    expect(runningToolLabel(state)).toBe('升级依赖（Agent） › 子任务：正在调用 Bash');
  });

  it('refreshes liveness on every child step while logging at most once a minute', async () => {
    let now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const info = vi.spyOn(log, 'info');
    const run = createFakeAgent().run({ runId: 'subagent-test', prompt: 'x' });
    const handle = new ActiveRuns().register('chat', run);
    async function* events(): AsyncIterable<AgentEvent> {
      yield start;
      yield step;
      now += 30_000;
      yield step;
      now += 30_000;
      yield step;
      yield { type: 'done', terminationReason: 'normal' };
    }
    const states: RunState[] = [];
    await processAgentStream(handle, events(), 'chat', undefined, () => {}, async (s) => { states.push(s); });
    expect(info.mock.calls.filter((c) => c[1] === 'subagent-activity')).toHaveLength(2);
    expect(handle.lastActivityAt).toBe(160_000);
    expect(states.filter((s) => s.subagent)).not.toHaveLength(0);
  });
});
