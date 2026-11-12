import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readBuildQueue } from '../../../src/coding-board/build-queue';

it('reads live holder and waiting tickets without deleting stale ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-queue-'));
  const lock = join(dir, 'lock');
  try {
    await mkdir(lock); await mkdir(`${lock}.queue`);
    await writeFile(join(lock, 'owner'), `${process.pid} abc 10:00:00 /work/tree one\n`);
    await writeFile(join(`${lock}.queue`, '1-0000001'), `99999999 old /old\n`);
    await writeFile(join(`${lock}.queue`, '2-0000002'), `${process.pid} next /work/tree two\n`);
    const queue = await readBuildQueue(123, lock);
    expect(queue.entries).toEqual([{ path: '/work/tree one', state: 'running' }, { path: '/work/tree two', state: 'waiting', position: 1 }]);
    expect(await readFile(join(`${lock}.queue`, '1-0000001'), 'utf8')).toContain('/old');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
