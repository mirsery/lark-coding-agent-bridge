import { expect, it } from 'vitest';
import { TerminalTheme, foreground } from '../../../src/terminal/theme';

it('detects light and dark backgrounds from split OSC replies without consuming keys', () => {
  const theme = new TerminalTheme();
  expect(theme.mode).toBe('terminal');
  expect(theme.input('r\x1b]11;rgb:ffff/')).toBe('r');
  expect(theme.input('ffff/ffff\x1b')).toBe('');
  expect(theme.input('\\ ')).toBe(' ');
  expect(theme.mode).toBe('light');
  expect(theme.input('\x1b]11;rgb:1818/1818/1818\x07')).toBe('');
  expect(theme.mode).toBe('dark');
  theme.input('\x1b]11;rgb:ff/ff/ff\x07');
  expect(theme.mode).toBe('light');
});

it('keeps native foregrounds without detection and bounds malformed responses', () => {
  const theme = new TerminalTheme();
  expect(foreground(37, 'light')).toBe('39');
  expect(foreground(37, 'dark')).toBe('39');
  expect(foreground(92, 'terminal')).toBe('32');
  expect(foreground(92, 'light')).not.toBe(foreground(92, 'dark'));
  theme.input('\x1b]11;rgb:invalid\x07');
  expect(theme.mode).toBe('terminal');
  theme.input('\x1b]11;' + 'x'.repeat(300));
  expect(theme.input('q')).toBe('q');
  theme.input('\x1b]11;');
  expect(theme.input('\x03')).toBe('\x03');
});
