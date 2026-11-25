import { createTemperatureSampler } from './temperature';
import { createIoSampler, type IoMetrics } from './io';
import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { cpus, freemem, homedir, platform, totalmem, uptime } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const macDiskCapacityScript = `
  ObjC.import('Foundation');
  function run(args) {
    const url = $.NSURL.fileURLWithPath(args[0]);
    const capacity = Ref();
    if (url.getResourceValueForKeyError(capacity, $.NSURLVolumeAvailableCapacityForImportantUsageKey, null)) {
      return ObjC.unwrap(capacity[0]);
    }
  }
`;

async function readMacAvailable(path: string): Promise<number | undefined> {
  if (platform() !== 'darwin') return undefined;
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', macDiskCapacityScript, path], {
    timeout: 1500, maxBuffer: 4096, encoding: 'utf8',
  });
  const bytes = stdout.trim();
  return /^\d+$/.test(bytes) ? Number(bytes) : undefined;
}

export interface CpuTicks { idle: number; total: number }
export interface HostMetrics {
  cpuPercent: number | null;
  temperatureC?: number | null;
  io?: IoMetrics;
  memoryTotal: number;
  memoryNonFree: number;
  uptimeSeconds: number;
  disk?: { total: number; used: number; available: number; availableIncludingPurgeable?: number; sampledAt: number };
}
export function cpuPercent(previous: CpuTicks, current: CpuTicks): number | null {
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0 || idle < 0) return null;
  return Math.max(0, Math.min(100, (1 - idle / total) * 100));
}
/** Metrics are cached for 10s and disk capacity for 60s. Never spawn top/ps per frame. */
export function createHostSampler(intervalMs = 10_000, readAvailable = readMacAvailable) {
  const sampleIo = createIoSampler();
  const sampleTemperature = createTemperatureSampler();
  let cached: HostMetrics | undefined;
  let sampledAt = -Infinity;
  let previous: CpuTicks | undefined;
  let diskSample: Promise<HostMetrics['disk']> | undefined;
  let diskAttempt = -Infinity;
  async function sampleDisk(now: number): Promise<HostMetrics['disk']> {
    const path = homedir();
    const [fs, macAvailable] = await Promise.all([statfs(path), readAvailable(path).catch(() => undefined)]);
    const total = fs.blocks * fs.bsize;
    const available = fs.bavail * fs.bsize;
    const disk = { total, available, used: (fs.blocks - fs.bfree) * fs.bsize, sampledAt: now };
    if (macAvailable !== undefined && Number.isSafeInteger(macAvailable) && macAvailable >= available && macAvailable <= total) {
      return { ...disk, availableIncludingPurgeable: macAvailable };
    }
    return disk;
  }
  return async (now = Date.now()): Promise<HostMetrics> => {
    if (cached && now >= sampledAt && now - sampledAt < intervalMs) return cached;
    const ticks = cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
    const percent = previous ? cpuPercent(previous, ticks) : null;
    previous = ticks;
    if (now - diskAttempt >= 60_000) {
      diskAttempt = now;
      const previousDisk = diskSample;
      diskSample = sampleDisk(now).catch(() => previousDisk);
    }
    const memoryTotal = totalmem();
    const [io, temperatureC, disk] = await Promise.all([sampleIo(now), sampleTemperature(now), diskSample]);
    sampledAt = now;
    cached = { io, temperatureC, cpuPercent: percent, memoryTotal, memoryNonFree: memoryTotal - freemem(), uptimeSeconds: uptime(), disk };
    return cached;
  };
}
