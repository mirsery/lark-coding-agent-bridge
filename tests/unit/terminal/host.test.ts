import { describe, it, expect, vi } from 'vitest';
import { statfs } from 'node:fs/promises';
import { cpuPercent, createHostSampler } from '../../../src/terminal/host';
vi.mock('../../../src/terminal/io', () => ({ createIoSampler: () => async () => ({ disk: null, network: null, sampledAt: 0 }) }));
vi.mock('../../../src/terminal/temperature', () => ({ createTemperatureSampler: () => async () => 56.2 }));
vi.mock('node:fs/promises', () => ({ statfs: vi.fn().mockResolvedValue({ blocks: 100, bfree: 30, bavail: 20, bsize: 1024 }) }));
describe('host metrics', () => {
  it('uses counter deltas rather than lifetime CPU averages', () => {
    expect(cpuPercent({ idle: 900, total: 1000 }, { idle: 920, total: 1100 })).toBe(80);
    expect(cpuPercent({ idle: 900, total: 1000 }, { idle: 900, total: 1000 })).toBeNull();
    expect(cpuPercent({ idle: 900, total: 1000 }, { idle: 10, total: 20 })).toBeNull();
  });
  it('caches disk sampling across frequent refreshes and labels the first CPU sample unavailable', async () => {
    const read = createHostSampler(10_000, async () => undefined);
    const first = await read(1000);
    expect(first.cpuPercent).toBeNull();
    expect(first.temperatureC).toBe(56.2);
    expect(first.disk).toEqual({ total: 102400, used: 71680, available: 20480, sampledAt: 1000 });
    expect(await read(3000)).toBe(first);
    await read(31000);
    expect(statfs).toHaveBeenCalledTimes(1);
    expect((await read(61000)).disk?.sampledAt).toBe(61000);
    expect(statfs).toHaveBeenCalledTimes(2);
  });
  it('shares the macOS capacity sample and falls back to current filesystem counters on failure', async () => {
    const available = vi.fn().mockResolvedValueOnce(50_000).mockRejectedValueOnce(new Error('capacity unavailable'))
      .mockResolvedValueOnce(120_000);
    const read = createHostSampler(10_000, available);
    const [first, concurrent] = await Promise.all([read(1000), read(1000)]);
    expect(first.disk).toEqual({ total: 102400, used: 71680, available: 20480, availableIncludingPurgeable: 50_000, sampledAt: 1000 });
    expect(concurrent.disk).toEqual(first.disk);
    expect(available).toHaveBeenCalledTimes(1);
    expect((await read(61000)).disk).toEqual({ total: 102400, used: 71680, available: 20480, sampledAt: 61000 });
    expect((await read(121000)).disk?.availableIncludingPurgeable).toBeUndefined();
  });
});
