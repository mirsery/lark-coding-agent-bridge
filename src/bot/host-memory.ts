import { execFile } from 'node:child_process';
import { appendFile, mkdir, rename, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { log } from '../core/logger';

const exec = promisify(execFile);

/** macOS reports a pressure-derived headroom percentage, not free RAM. */
export function parseMemoryFreePercent(output: string): number | undefined {
  const match = /System-wide memory free percentage:\s*(\d+)%/.exec(output);
  if (!match) return undefined;
  const value = Number(match[1]);
  return value <= 100 ? value : undefined;
}

/** Three samples provide hysteresis; repeated sampling failures fail open. */
export class MemoryPressureGate {
  private paused = false;
  private low = 0;
  private high = 0;
  private errors = 0;

  observe(percent: number | undefined): boolean {
    if (percent === undefined) {
      this.low = 0; this.high = 0;
      if (++this.errors >= 3) this.paused = false;
    } else {
      this.errors = 0;
      this.low = percent <= 15 ? this.low + 1 : 0;
      this.high = percent >= 25 ? this.high + 1 : 0;
      if (this.low >= 3) this.paused = true;
      if (this.high >= 3) this.paused = false;
    }
    return this.paused;
  }
}

/** Combine the latest sample with a live profile setting. */
export class MemoryGateControl {
  private high = false;
  constructor(private readonly enabled: () => boolean, private readonly apply: (paused: boolean) => void) {}
  observe(high: boolean): void { this.high = high; this.sync(); }
  sync(): void { this.apply(this.high && this.enabled()); }
}

async function command(file: string, args: string[]): Promise<string> {
  const result = await exec(file, args, { timeout: 5000, maxBuffer: 128 * 1024 });
  return result.stdout;
}

/** One sampler per profile; never records full command lines or environment. */
export function startHostMemoryMonitor(profileDir: string, onPressure: (paused: boolean) => void): () => void {
  if (process.platform !== 'darwin') return () => {};
  const gate = new MemoryPressureGate();
  const dir = join(profileDir, 'logs');
  const file = join(dir, 'host-memory.jsonl');
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous = false;
  const sample = async () => {
    let percent: number | undefined;
    try { percent = parseMemoryFreePercent(await command('/usr/bin/memory_pressure', [])); }
    catch { /* missing sample must not block the queue forever */ }
    if (stopped) return;
    const paused = gate.observe(percent);
    if (paused !== previous) {
      log.warn('host-memory', paused ? 'pressure-high' : 'pressure-cleared', { percent: percent ?? null });
      previous = paused;
    }
    onPressure(paused);
    try {
      const [swap, processes, disk] = await Promise.all([
        command('/usr/sbin/sysctl', ['vm.swapusage']).catch(() => ''),
        command('/bin/ps', ['-A', '-o', 'rss=,pid=,ppid=,comm=']).catch(() => ''),
        statfs(profileDir).catch(() => undefined),
      ]);
      const top = processes.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 10).map(m => ({ rssKiB: Number(m[1]), pid: Number(m[2]), ppid: Number(m[3]), executable: m[4]?.split('/').pop() }));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const existing = await stat(file).catch(() => undefined);
      if (existing && existing.size >= 1024 * 1024) {
        await rename(file, `${file}.1`);
      }
      await appendFile(file, JSON.stringify({ time: new Date().toISOString(), pressureFreePercent: percent ?? null,
        highPressure: paused, swap: swap.trim(), diskAvailableBytes: disk ? disk.bavail * disk.bsize : null, top }) + '\n', { mode: 0o600 });
    } catch (err) { log.warn('host-memory', 'sample-write-failed', { error: String(err) }); }
    if (!stopped) { timer = setTimeout(() => void sample(), 30_000); timer.unref(); }
  };
  void sample();
  return () => { stopped = true; if (timer) clearTimeout(timer); onPressure(false); };
}
