import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS } from '../../../src/config/schema';
import { autoEffortInstruction, effortRequest, stripEffortMarker } from '../../../src/session/effort-marker';
import { newSessionRequest, stripNewSessionMarker } from '../../../src/session/smart-session';
import { stripControlMarkers } from '../../../src/card/run-state';

describe('effortRequest', () => {
  it('reads a marker on its own line, the last one winning', () => {
    expect(effortRequest('结论。\n\n[[EFFORT: xhigh]]', EFFORT_LEVELS)).toBe('xhigh');
    expect(effortRequest('[[EFFORT：LOW]]\n后面\n[[EFFORT: max]]', EFFORT_LEVELS)).toBe('max');
  });

  it('ignores default, unknown levels, levels the agent lacks and inline mentions', () => {
    expect(effortRequest('好\n[[EFFORT: default]]', EFFORT_LEVELS)).toBeUndefined();
    expect(effortRequest('好\n[[EFFORT: turbo]]', EFFORT_LEVELS)).toBeUndefined();
    expect(effortRequest('好\n[[EFFORT: ultra]]', EFFORT_LEVELS)).toBeUndefined();
    expect(effortRequest('写 [[EFFORT: xhigh]] 就行', EFFORT_LEVELS)).toBeUndefined();
    expect(effortRequest(undefined, EFFORT_LEVELS)).toBeUndefined();
  });

  it('sits next to a close request in either order', () => {
    const before = '做完了。\n[[EFFORT: low]]\n[[NEW_SESSION: 做完了]]';
    const after = '做完了。\n[[NEW_SESSION: 做完了]]\n[[EFFORT: low]]';
    for (const text of [before, after]) {
      expect(effortRequest(text, EFFORT_LEVELS)).toBe('low');
      expect(newSessionRequest(stripEffortMarker(text))).toEqual({ summary: '做完了' });
      expect(stripNewSessionMarker(stripEffortMarker(text))).toBe('做完了。');
    }
  });
});

describe('stripEffortMarker', () => {
  it('drops complete markers and leaves other text alone', () => {
    expect(stripEffortMarker('结论。\n\n[[EFFORT: xhigh]]\n')).toBe('结论。');
    expect(stripEffortMarker('数组 a[[0]] 不是标记')).toBe('数组 a[[0]] 不是标记');
  });

  it('hides a marker still arriving at the end of a stream', () => {
    expect(stripEffortMarker('结论。\n[[EFF', true)).toBe('结论。');
    expect(stripEffortMarker('结论。\n[[EFFORT: xh', true)).toBe('结论。');
    expect(stripEffortMarker('结论。\n[', true)).toBe('结论。\n[');
  });

  it('leaves an answer of only [[NO_REPLY]] to the no-reply rule', () => {
    const state = stripControlMarkers({
      blocks: [{ kind: 'text', content: '[[NO_REPLY]]\n[[EFFORT: low]]' }],
      finalText: '[[NO_REPLY]]\n[[EFFORT: low]]',
    } as never);
    expect(state.blocks).toEqual([]);
    expect(state.finalText).toBeUndefined();
  });
});

describe('autoEffortInstruction', () => {
  it('names the current and default levels and the marker', () => {
    const text = autoEffortInstruction({ levels: ['low', 'high', 'xhigh'], current: 'xhigh', base: 'high' });
    expect(text).toContain('本轮推理强度（effort）是 xhigh，默认是 high');
    expect(text).toContain('[[EFFORT: low|high|xhigh]]');
  });
});
