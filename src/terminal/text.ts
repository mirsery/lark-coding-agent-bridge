/** Remove terminal control sequences from all untrusted labels and prompts. */
export function clean(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}
export function width(char: string): number { const c = char.codePointAt(0) ?? 0; return c >= 0x1100 && (c <= 0x115f || c >= 0x2e80) ? 2 : 1; }
export function fit(text: string, cells: number): string {
  let out = ''; let used = 0;
  for (const ch of clean(text)) { const w = width(ch); if (used + w > cells) break; out += ch; used += w; }
  return out + ' '.repeat(Math.max(0, cells - used));
}
