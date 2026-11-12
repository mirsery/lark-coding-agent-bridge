import { describe, expect, it } from 'vitest';
import { MemoryGateControl, MemoryPressureGate, parseMemoryFreePercent } from '../../../src/bot/host-memory';
import { ProcessPool } from '../../../src/bot/process-pool';

describe('host memory pressure', () => {
  it('parses macOS pressure and rejects malformed data', () => {
    expect(parseMemoryFreePercent('System-wide memory free percentage: 12%\n')).toBe(12);
    expect(parseMemoryFreePercent('System-wide memory free percentage: 120%')).toBeUndefined();
    expect(parseMemoryFreePercent('unavailable')).toBeUndefined();
  });
  it('requires sustained pressure and recovery, and fails open on repeated errors', () => {
    const gate = new MemoryPressureGate();
    expect([gate.observe(10), gate.observe(10), gate.observe(10)]).toEqual([false, false, true]);
    expect([gate.observe(30), gate.observe(30), gate.observe(30)]).toEqual([true, true, false]);
    gate.observe(10); gate.observe(10); gate.observe(10);
    expect([gate.observe(undefined), gate.observe(undefined), gate.observe(undefined)]).toEqual([true, true, false]);
  });
  it('respects live configuration and releases the queue when disabled', async () => {
    let enabled = true;
    const pool = new ProcessPool(() => 1);
    const gate = new MemoryGateControl(() => enabled, paused => pool.setPressurePaused(paused));
    gate.observe(true);
    const queued = pool.acquire();
    expect(pool.snapshot().waiting).toBe(1);
    enabled = false;
    gate.sync();
    const release = await queued;
    release();
    enabled = true;
    gate.sync();
    expect(pool.tryAcquire()).toBeUndefined();
    gate.observe(false);
    const next = pool.tryAcquire();
    expect(next).toBeDefined();
    next?.();
  });
  it('queues without interrupting active work and resumes fairly', async () => {
    const pool = new ProcessPool(() => 1);
    const first = await pool.acquire();
    pool.setPressurePaused(true);
    let admitted = false;
    const queued = pool.acquire().then(release => { admitted = true; return release; });
    first();
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(pool.tryAcquire()).toBeUndefined();
    pool.setPressurePaused(false);
    const release = await queued;
    expect(admitted).toBe(true);
    release();
  });
});
