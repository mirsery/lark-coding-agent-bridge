export type MonitorTheme = 'light' | 'dark' | 'terminal';

const palettes: Record<MonitorTheme, Record<number, string>> = {
  light: { 35: '38;5;97', 36: '38;5;30', 90: '38;5;240', 91: '38;5;160', 92: '38;5;28', 93: '38;5;130' },
  dark: { 35: '38;5;182', 36: '38;5;116', 90: '38;5;245', 91: '38;5;203', 92: '38;5;151', 93: '38;5;222' },
  terminal: { 35: '35', 36: '36', 90: '39', 91: '31', 92: '32', 93: '33' },
};

/** 正文始终使用终端默认前景色；所有模式都不设置背景色。 */
export function foreground(code: number, theme: MonitorTheme): string {
  return code === 37 ? '39' : palettes[theme][code] ?? String(code);
}

/** OSC 11 只查询默认背景；不支持查询时保留终端自己的 ANSI 调色板。 */
export class TerminalTheme {
  mode: MonitorTheme = 'terminal';
  private pending = '';

  input(chunk: string): string {
    if (chunk === 'q' || chunk === '\x03') { this.pending = ''; return chunk; }
    let text = this.pending + chunk;
    this.pending = '';
    let keys = '';
    while (text) {
      const start = text.indexOf('\x1b]');
      if (start < 0) {
        if (text.endsWith('\x1b')) { this.pending = '\x1b'; text = text.slice(0, -1); }
        return keys + text;
      }
      keys += text.slice(0, start);
      text = text.slice(start);
      const end = /\x07|\x1b\\/.exec(text);
      if (!end) {
        if (text.length <= 256) this.pending = text;
        return keys;
      }
      const rgb = /^\x1b\]11;rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/i.exec(text.slice(0, end.index));
      if (rgb) {
        const [r, g, b] = rgb.slice(1).map(value => parseInt(value!, 16) / (16 ** value!.length - 1));
        const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        this.mode = luminance > 0.5 ? 'light' : 'dark';
      }
      text = text.slice(end.index + end[0].length);
    }
    return keys;
  }
}
