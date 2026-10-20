import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../../src/terminal/monitor', () => ({
  createMonitorReader: () => mocks.read,
  renderMonitor: () => 'CPU\n会话',
}));
import { runMonitor } from '../../../src/cli/commands/monitor';

const originals = new Map<string, PropertyDescriptor | undefined>();
function property(target: object, key: string, value: unknown) {
  const id = (target === process.stdin ? 'in:' : 'out:') + key;
  if (!originals.has(id)) originals.set(id, Object.getOwnPropertyDescriptor(target, key));
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}
afterEach(() => {
  process.stdin.emit('data', Buffer.from('q'));
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const [id, descriptor] of originals) {
    const target = id.startsWith('in:') ? process.stdin : process.stdout;
    const key = id.split(':')[1]!;
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
  originals.clear();
});
function terminal() {
  property(process.stdin, 'isTTY', true); property(process.stdout, 'isTTY', true);
  property(process.stdout, 'columns', 110); property(process.stdout, 'rows', 36);
  property(process.stdin, 'setRawMode', vi.fn());
  vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
  vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
  return vi.spyOn(process.stdout, 'write').mockReturnValue(true);
}
it('keeps 2 fps animation and resize separate from 10 second sampling, pauses, and cleans up', async () => {
  vi.useFakeTimers();
  const write = terminal();
  mocks.read.mockReset().mockResolvedValue({ now: 0 });
  const signals = process.listenerCount('SIGTERM');
  await runMonitor({ color: false });
  expect(mocks.read).toHaveBeenCalledTimes(1);
  write.mockClear();
  await vi.advanceTimersByTimeAsync(2000);
  expect(write).toHaveBeenCalledTimes(4);
  expect(write.mock.calls.every(([text]) => !String(text).includes('CPU'))).toBe(true);
  process.stdout.emit('resize');
  expect(mocks.read).toHaveBeenCalledTimes(1);
  process.stdin.emit('data', Buffer.from(' '));
  write.mockClear();
  await vi.advanceTimersByTimeAsync(10000);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(write).not.toHaveBeenCalled();
  process.stdin.emit('data', Buffer.from(' '));
  await vi.advanceTimersByTimeAsync(8000);
  expect(mocks.read).toHaveBeenCalledTimes(2);
  process.stdin.emit('data', Buffer.from('q'));
  expect(process.listenerCount('SIGTERM')).toBe(signals);
  expect(vi.getTimerCount()).toBe(0);
  expect(write).toHaveBeenLastCalledWith('\x1b[?25h\x1b[?1049l');
});
it('supports disabling animation without disabling sampling', async () => {
  vi.useFakeTimers(); const write = terminal();
  mocks.read.mockReset().mockResolvedValue({ now: 0 });
  await runMonitor({ animation: false });
  write.mockClear();
  await vi.advanceTimersByTimeAsync(9500);
  expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.read).toHaveBeenCalledTimes(2);
});
