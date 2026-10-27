import { foreground, type MonitorTheme } from './theme';
import type { MonitorSnapshot } from './snapshot';

export function conversationLabel(snapshot: MonitorSnapshot): string {
  const names = [...new Set(snapshot.bots.flatMap(bot => bot.runs.filter(run => !run.orphan).map(run => run.actorName?.trim()).filter((name): name is string => Boolean(name))))];
  const text = names.join(' · ').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  let result = ''; let used = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const width = code >= 0x1100 && (code <= 0x115f || code >= 0x2e80) ? 2 : 1;
    if (used + width > 24) break;
    result += char; used += width;
  }
  return result;
}
function labelWidth(label: string): number {
  return [...label].reduce((total, char) => {
    const code = char.codePointAt(0) ?? 0;
    return total + (code >= 0x1100 && (code <= 0x115f || code >= 0x2e80) ? 2 : 1);
  }, 0);
}

/**
 * 通用终端字符动画：AlphaESS 吉祥物——戴帽子的猫推着平板车上的储能柜，独立占用五行，
 * 不依赖图片或终端专属接口。向左走时镜像图形，柜子上的「A」保持原样可读。
 */
const MASCOT = [
  '  /\\.--.__      .-----.',
  '  ( o.o )       | A  ||',
  '  /|###|>==.    |    ||',
  ' ~ |___|    \\___|____||',
];
// 腿交替迈步，轮子跟着转；轮子在平板两端下方。
const STRIDES = ['   /   \\     o       o', '    | |      O       O'];
export const CAT_WIDTH = Math.max(...[...MASCOT, ...STRIDES].map(row => row.length));
export function renderCat(frame: number, direction: 'left' | 'right' = 'right'): string[] {
  const step = ((frame % 6) + 6) % 6;
  const art = [...MASCOT, STRIDES[step % 2]!].map(row => row.padEnd(CAT_WIDTH));
  const mirror: Record<string, string> = { '/': '\\', '\\': '/', '(': ')', ')': '(', '<': '>', '>': '<' };
  return direction === 'right' ? art : art.map(row => [...row].reverse().map(char => mirror[char] ?? char).join(''));
}
export function catPosition(columns: number, rows: number, frame = 0, label = ''): { row: number; column: number; direction: 'left' | 'right' } | undefined {
  if (columns < 80 || rows < 24) return undefined;
  const travel = Math.max(1, columns - CAT_WIDTH - (label ? labelWidth(label) + 2 : 0) - 4);
  const steps = Math.ceil(travel / 2);
  const phase = Math.max(0, Math.floor(frame)) % (steps * 2);
  const returning = phase >= steps;
  const offset = returning ? travel - Math.min((phase - steps) * 2, travel) : Math.min(phase * 2, travel);
  return { row: 3, column: 3 + offset, direction: returning ? 'left' : 'right' };
}
/** 先擦除上一帧的猫，再画新位置；所有写入严格限制在动画区域。 */
export function catPatch(columns: number, rows: number, frame: number, color = true, theme: MonitorTheme = 'terminal', label = ''): string {
  const at = catPosition(columns, rows, frame, label);
  const previous = catPosition(columns, rows, frame - 1, label);
  if (!at || !previous) return '';
  const erase = renderCat(frame).map((_, i) => `\x1b[${previous.row + i};${previous.column}H${' '.repeat(CAT_WIDTH + (label ? labelWidth(label) + 2 : 0))}`).join('');
  const art = renderCat(frame, at.direction).map((line, i) => `\x1b[${at.row + i};${at.column}H${line}${i === 0 && label ? '  ' + label : ''}`).join('');
  return color ? `\x1b[${foreground(36, theme)}m` + erase + art + '\x1b[0m' : erase + art;
}
