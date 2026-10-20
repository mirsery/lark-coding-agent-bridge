/** Fixed-size ASCII art works without fonts, images, or terminal-specific APIs. */
export const CAT_WIDTH = 16;
export function renderCat(frame: number): string[] {
  const step = ((frame % 6) + 6) % 6;
  const eyes = step === 3 ? '- -' : step === 4 ? 'o -' : 'o o';
  const tail = ['~', '-', '~', ')', '|', ')'][step];
  return ['   /\\_/\\', `  ( ${eyes} )`, '   > ^ <', `  /|___|\\${tail}`].map(row => row.padEnd(CAT_WIDTH));
}
export function catPosition(columns: number, rows: number): { row: number; column: number } | undefined {
  return columns >= 80 && rows >= 24 ? { row: 1, column: columns - CAT_WIDTH } : undefined;
}
/** Cursor positioning only: never clear lines that contain status or session text. */
export function catPatch(columns: number, rows: number, frame: number, color = true): string {
  const at = catPosition(columns, rows);
  if (!at) return '';
  const art = renderCat(frame).map((line, i) => `\x1b[${at.row + i};${at.column}H${line}`).join('');
  return color ? '\x1b[36m' + art + '\x1b[0m' : art;
}
