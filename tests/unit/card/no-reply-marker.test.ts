import { describe, expect, it } from 'vitest';
import { initialState, isNoReplyText, NO_REPLY_MARKER, stripNoReply, type RunState } from '../../../src/card/run-state';

const withText = (content: string, extra: Partial<RunState> = {}): RunState => ({
  ...initialState,
  blocks: [{ kind: 'text', content, streaming: false }],
  ...extra,
});

describe('NO_REPLY marker', () => {
  it('recognises the marker, with surrounding whitespace', () => {
    expect(isNoReplyText(NO_REPLY_MARKER)).toBe(true);
    expect(isNoReplyText(`\n  ${NO_REPLY_MARKER}\n`)).toBe(true);
  });

  it('treats a streaming prefix as the marker so no progress card opens early', () => {
    expect(isNoReplyText('[[')).toBe(true);
    expect(isNoReplyText('[[NO_RE')).toBe(true);
  });

  it('does not swallow real answers', () => {
    expect(isNoReplyText('')).toBe(false);
    expect(isNoReplyText('卡片已发出')).toBe(false);
    expect(isNoReplyText(`说明 ${NO_REPLY_MARKER}`)).toBe(false);
    expect(isNoReplyText('[link](x)')).toBe(false);
    expect(isNoReplyText('[')).toBe(false);
  });

  it('strips marker-only text blocks and final text', () => {
    const stripped = stripNoReply(withText(NO_REPLY_MARKER, { finalText: NO_REPLY_MARKER }));
    expect(stripped.blocks).toEqual([]);
    expect(stripped.finalText).toBeUndefined();
  });

  it('keeps tool blocks and normal text untouched', () => {
    const state: RunState = {
      ...initialState,
      blocks: [
        { kind: 'tool', tool: { id: 't1', name: 'Bash', input: {}, status: 'done' } },
        { kind: 'text', content: '正常回答', streaming: false },
      ],
      finalText: '正常回答',
    };
    expect(stripNoReply(state)).toBe(state);
  });
});
