import { expect, it } from 'vitest';
import { diskDisplay } from '../../../web/src/lib/utils';

const disk = { total: 250_790_436_864, used: 209_208_336_384, available: 41_582_100_480 };

it('uses the macOS available space for both capacity and usage percentage', () => {
  const display = diskDisplay({ ...disk, availableIncludingPurgeable: 102_185_399_246 });
  expect(display.detail).toBe('可用 102.2 / 250.8 GB');
  expect(display.percent).toBeCloseTo(59.3, 1);
});

it('uses filesystem counters when no macOS reading is available', () => {
  const display = diskDisplay(disk);
  expect(display.detail).toBe('可用 41.6 / 250.8 GB');
  expect(display.percent).toBeCloseTo(83.4, 1);
});
