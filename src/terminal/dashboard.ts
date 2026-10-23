import { foreground, type MonitorTheme } from './theme';

/**
 * 通用终端字符动画：AlphaESS 吉祥物——戴帽子、穿黑色卫衣的橙猫推着平板车上的储能柜，独立占用五行，
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
// 与上面逐列对应的上色分区，照表情包配色：c 橙色的猫（含腿和尾巴），h 黑色卫衣，k 平板车和储能柜。
const MASCOT_PARTS = [
  '  cccccccc      kkkkkkk',
  '  ccccccc       kkkkkkk',
  '  chhhhhkkkk    kkkkkkk',
  ' c hhhhh    kkkkkkkkkkk',
];
const STRIDE_PARTS = ['   c   c     k       k', '    c c      k       k'];
const PART_COLORS: Record<string, number> = { c: 93, h: 90, k: 37 };
export const CAT_WIDTH = Math.max(...[...MASCOT, ...STRIDES].map(row => row.length));
function frameRows(rows: string[], strides: string[], frame: number, direction: 'left' | 'right'): string[] {
  const step = ((frame % 6) + 6) % 6;
  const art = [...rows, strides[step % 2]!].map(row => row.padEnd(CAT_WIDTH));
  return direction === 'right' ? art : art.map(row => [...row].reverse().join(''));
}
export function renderCat(frame: number, direction: 'left' | 'right' = 'right'): string[] {
  const mirror: Record<string, string> = { '/': '\\', '\\': '/', '(': ')', ')': '(', '<': '>', '>': '<' };
  const art = frameRows(MASCOT, STRIDES, frame, direction);
  return direction === 'right' ? art : art.map(row => [...row].map(char => mirror[char] ?? char).join(''));
}
/** renderCat 每一格属于哪个上色分区（c / h / k，空白为空格），与它逐行逐列对应。 */
export function catParts(frame: number, direction: 'left' | 'right' = 'right'): string[] {
  return frameRows(MASCOT_PARTS, STRIDE_PARTS, frame, direction);
}
/** 按分区给一行吉祥物上色；`paint` 决定颜色怎么写（局部刷新与整屏渲染各自的写法）。 */
export function paintCat(row: string, parts: string, paint: (text: string, code: number) => string): string {
  let out = '';
  for (let i = 0; i < row.length;) {
    let j = i + 1;
    while (j < row.length && parts[j] === parts[i]) j++;
    const code = PART_COLORS[parts[i] ?? ' '];
    out += code === undefined ? row.slice(i, j) : paint(row.slice(i, j), code);
    i = j;
  }
  return out;
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
  const parts = catParts(frame, at.direction);
  const paint = (text: string, code: number) => color ? `\x1b[${foreground(code, theme)}m${text}` : text;
  const art = renderCat(frame, at.direction).map((line, i) => `\x1b[${at.row + i};${at.column}H${paintCat(line, parts[i]!, paint)}`).join('');
  return color ? erase + art + '\x1b[0m' : erase + art;
}
