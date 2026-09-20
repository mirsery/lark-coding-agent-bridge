import { describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import {
  interruptedNoticeText,
  reportInterruptedRuns,
  sendInterruptedNotice,
} from '../../../src/bot/interrupted-notice';
import type { RunRecord } from '../../../src/runtime/run-registry';

const base: RunRecord = {
  runId: 'run-1',
  scope: 'oc_chat',
  chatId: 'oc_chat',
  originMessageId: 'om_1',
  promptPreview: '整理一份 claude artifacts 文档给我',
  startedAt: 1_000,
  ownerPid: 1,
};

function fakeChannel(send: unknown): LarkChannel {
  return { send } as unknown as LarkChannel;
}

describe('interruptedNoticeText', () => {
  it('names the cause and how long the run got', () => {
    const text = interruptedNoticeText(base, 'restart', 1_000 + 200_000);
    expect(text).toContain('bridge 重启');
    expect(text).toContain('3 分 20 秒');
    expect(text).toContain('整理一份 claude artifacts 文档给我');
    expect(text).toContain('继续');
  });

  it('distinguishes a shutdown from a restart', () => {
    expect(interruptedNoticeText(base, 'shutdown', 2_000)).toContain('bridge 关闭');
  });

  it('clips a long prompt to one line', () => {
    const long = { ...base, promptPreview: `${'长'.repeat(200)}\n第二行` };
    const text = interruptedNoticeText(long, 'restart', 2_000);
    const taskLine = text.split('\n').find((l) => l.startsWith('任务：')) ?? '';
    expect(taskLine.length).toBeLessThan(80);
    expect(taskLine).toContain('…');
  });

  it('omits the task line when there is no prompt preview', () => {
    const text = interruptedNoticeText({ ...base, promptPreview: '  ' }, 'restart', 2_000);
    expect(text).not.toContain('任务：');
  });
});

describe('sendInterruptedNotice', () => {
  it('replies to the triggering message, threaded inside a topic', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await sendInterruptedNotice(fakeChannel(send), { ...base, threadId: 'omt_1' }, 'restart');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[2]).toEqual({ replyTo: 'om_1', replyInThread: true });
  });

  it('does not thread when the run was not in a topic', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await sendInterruptedNotice(fakeChannel(send), base, 'restart');
    expect(send.mock.calls[0]?.[2]).toEqual({ replyTo: 'om_1' });
  });

  it('falls back to a plain send when the origin message is gone', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('message not found'))
      .mockResolvedValueOnce(undefined);
    await sendInterruptedNotice(fakeChannel(send), base, 'restart');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[2]).toBeUndefined();
  });

  it('swallows a total send failure', async () => {
    const send = vi.fn().mockRejectedValue(new Error('chat gone'));
    await expect(sendInterruptedNotice(fakeChannel(send), base, 'restart')).resolves.toBeUndefined();
  });
});

describe('reportInterruptedRuns', () => {
  it('sends nothing when there is nothing to report', async () => {
    const send = vi.fn();
    await reportInterruptedRuns(fakeChannel(send), [], 'restart');
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps going after one chat fails', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('reply failed'))
      .mockRejectedValueOnce(new Error('plain failed'))
      .mockResolvedValueOnce(undefined);
    await reportInterruptedRuns(
      fakeChannel(send),
      [base, { ...base, runId: 'run-2', chatId: 'oc_other' }],
      'restart',
    );
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]?.[0]).toBe('oc_other');
  });
});
