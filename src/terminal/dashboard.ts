import { foreground, type MonitorTheme } from './theme';

/** 通用终端字符动画：独立占用四行，不依赖图片或终端专属接口。 */
export const CAT_WIDTH = 16;
export function renderCat(frame: number, direction: 'left' | 'right' = 'right'): string[] {
  const step = ((frame % 6) + 6) % 6;
  const legs = step % 2 ? '  /_/-\\_\\' : '  (_/  \\_)';
  const art = ['     /\\_/\\', ' ___( o.o )', `(~___ >^< )`, legs].map(row => row.padEnd(CAT_WIDTH));
  const mirror: Record<string, string> = { '/': '\\', '\\': '/', '(': ')', ')': '(', '<': '>', '>': '<' };
  return direction === 'right' ? art : art.map(row => [...row].reverse().map(char => mirror[char] ?? char).join(''));
}
export function catPosition(columns: number, rows: number, frame = 0): { row: number; column: number; direction: 'left' | 'right' } | undefined {
  if (columns < 80 || rows < 24) return undefined;
  const travel = Math.max(1, columns - CAT_WIDTH - 4);
  const steps = Math.ceil(travel / 2);
  const phase = Math.max(0, Math.floor(frame)) % (steps * 2);
  const returning = phase >= steps;
  const offset = returning ? travel - Math.min((phase - steps) * 2, travel) : Math.min(phase * 2, travel);
  return { row: 3, column: 3 + offset, direction: returning ? 'left' : 'right' };
}
/** 先擦除上一帧的猫，再画新位置；所有写入严格限制在动画区域。 */
export function catPatch(columns: number, rows: number, frame: number, color = true, theme: MonitorTheme = 'terminal'): string {
  const at = catPosition(columns, rows, frame);
  const previous = catPosition(columns, rows, frame - 1);
  if (!at || !previous) return '';
  const erase = renderCat(frame).map((_, i) => `\x1b[${previous.row + i};${previous.column}H${' '.repeat(CAT_WIDTH)}`).join('');
  const art = renderCat(frame, at.direction).map((line, i) => `\x1b[${at.row + i};${at.column}H${line}`).join('');
  return color ? `\x1b[${foreground(36, theme)}m` + erase + art + '\x1b[0m' : erase + art;
}
