import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isAlive } from '../runtime/registry';

export interface QueueEntry { path: string; state: 'running' | 'waiting'; position?: number }
export interface QueueSnapshot { observedAt: number; state: 'available' | 'unavailable'; entries: QueueEntry[] }

/** Observe the legacy queue without removing stale tickets or invoking its script. */
export async function readBuildQueue(now = Date.now(), lock = process.env.BUILD_QUEUE_LOCK ?? join(homedir(), '.cache', 'build-queue.lock')): Promise<QueueSnapshot> {
  const entries: QueueEntry[] = [];
  try {
    const owner = await readFile(join(lock, 'owner'), 'utf8').catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return ''; throw err; });
    const match = /^(\d+)\s+\S+\s+\S+\s+(.+?)\s*$/.exec(owner);
    if (match && isAlive(Number(match[1]))) entries.push({ path: match[2]!, state: 'running' });
    const dir = `${lock}.queue`;
    const names = await readdir(dir).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return [] as string[]; throw err; });
    for (const name of names.filter(n => /^\d+-\d+$/.test(n)).sort()) {
      const raw = await readFile(join(dir, name), 'utf8').catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return ''; throw err; });
      const ticket = /^(\d+)\s+\S+\s+(.+?)\s*$/.exec(raw);
      if (ticket && isAlive(Number(ticket[1]))) entries.push({ path: ticket[2]!, state: 'waiting', position: entries.filter(e => e.state === 'waiting').length + 1 });
    }
    // A missing owner is ambiguous: the queue may be absent or starting.
    return { observedAt: now, state: 'available', entries };
  } catch { return { observedAt: now, state: 'unavailable', entries: [] }; }
}
