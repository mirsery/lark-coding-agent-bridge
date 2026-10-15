import { describe, expect, it } from 'vitest';
import type { RunHandle } from '../../../src/bot/active-runs.js';
import { describeActiveRun } from '../../../src/bot/run-status.js';

function handle(overrides: Partial<RunHandle> = {}): RunHandle {
  return {
    run: { runId: 'r' } as RunHandle['run'],
    interrupted: false,
    startedAt: 0,
    lastActivityAt: 0,
    ...overrides,
  };
}

describe('describeActiveRun', () => {
  it('reports runtime, last activity and the running tool', () => {
    const line = describeActiveRun(
      handle({ lastActivityAt: 364_000, toolLabel: '查 bridge 日志（Bash）' }),
      372_000,
    );
    expect(line).toBe('已运行 6:12 · 上次动静 8 秒前 · 当前：查 bridge 日志（Bash）');
  });

  it('flags a run that has gone quiet', () => {
    expect(describeActiveRun(handle(), 300_000)).toBe('已运行 5:00 · ⚠️ 已 5 分钟没有新动静');
  });
});
