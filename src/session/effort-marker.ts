import type { EffortLevel } from '../config/schema';

/**
 * 自动切档 — the agent picks the effort of the conversation's next turn.
 *
 * It ends an answer with a line `[[EFFORT: xhigh]]`; the bridge strips the
 * line from what the user sees and runs the next turn of the same
 * conversation at that level. One turn only: an answer without the marker
 * sends the conversation back to its default, so a forgotten downgrade never
 * leaves a chat stuck on an expensive level. The judgement is made after
 * reading the conversation, which a classifier in front of every message
 * could not do ("继续", "按刚才的改").
 */

/** Per scope: the level the last answer asked for, and the level the last turn ran at when it was one. */
export interface AutoEffortState {
  next?: EffortLevel;
  ran?: EffortLevel;
}

/** The marker on a line of its own, anywhere — it may sit before or after `[[NEW_SESSION…]]`. */
const MARKER_LINE = /^[ \t]*\[\[EFFORT[:：][ \t]*([A-Za-z]+)[ \t]*\]\][ \t]*(?:\r?\n|$)/gm;
/** A marker still arriving at the end of a stream: `[[E`, `[[EFFORT: xh`… */
const TRAILING_PARTIAL = /\s*\[\[(?:E(?:F(?:F(?:O(?:R(?:T(?:[:：][^\]\n]*)?)?)?)?)?)?)?$/;

/**
 * The level the agent asked for in `text` (the last marker wins), if it is
 * one `levels` accepts. `default` asks for nothing.
 */
export function effortRequest(text: string | undefined, levels: readonly EffortLevel[]): EffortLevel | undefined {
  if (!text) return undefined;
  let level: string | undefined;
  for (const m of text.matchAll(MARKER_LINE)) level = m[1]?.toLowerCase();
  return levels.includes(level as EffortLevel) ? (level as EffortLevel) : undefined;
}

/** `text` without effort markers — complete, or still streaming in when `streaming`. */
export function stripEffortMarker(text: string, streaming = false): string {
  const done = text.replace(MARKER_LINE, '');
  const stripped = done !== text ? done.trimEnd() : text;
  if (!streaming) return stripped;
  const m = TRAILING_PARTIAL.exec(stripped);
  return m ? stripped.slice(0, m.index) : stripped;
}

/** Standing instruction for the agent while 自动切档 is on. */
export function autoEffortInstruction(input: {
  levels: readonly EffortLevel[];
  current: EffortLevel | undefined;
  base: EffortLevel | undefined;
}): string {
  const base = input.base ?? 'CLI 默认';
  const current = input.current ?? base;
  return (
    `本轮推理强度（effort）是 ${current}，默认是 ${base}。` +
    '如果你判断这个会话的下一条消息需要不同的档位——比如接下来要做跨模块排查、方案设计、难定位的 bug，需要更高档；' +
    '只是确认、闲聊、发面板，用低档就够——在最终回复的最后单独一行写 ' +
    `\`[[EFFORT: ${input.levels.join('|')}]]\`。只对下一轮生效，不写就回到默认，所以连续几轮都要高档就每轮都写。` +
    '默认档位合适时不要写；最高档只留给极难的问题。这个标记对用户不可见，不要在正文里提到它。'
  );
}
