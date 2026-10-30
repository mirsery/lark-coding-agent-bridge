import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { knowledgeStub, withKnowledgeVersion } from '../../../src/knowledge/inject';
import { writeKnowledgeSnapshot } from '../../../src/knowledge/snapshot';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('knowledge version', () => {
  it('stamps a stable hash of the content, first in the block', () => {
    const a = withKnowledgeVersion({ profileMemory: ['a'], chatMemory: ['b'] });
    expect(a?.version).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.keys(a ?? {})[0]).toBe('version');
    expect(withKnowledgeVersion({ profileMemory: ['a'], chatMemory: ['b'] })?.version).toBe(a?.version);
    expect(withKnowledgeVersion(a)?.version).toBe(a?.version);
    expect(withKnowledgeVersion({ profileMemory: ['a'], chatMemory: ['c'] })?.version).not.toBe(a?.version);
    expect(withKnowledgeVersion(undefined)).toBeUndefined();
  });

  it('builds a stub pointing back at the version', () => {
    expect(knowledgeStub('abc')).toEqual({ unchangedSince: 'abc' });
    expect(knowledgeStub('abc', '/s/abc.json')).toEqual({ unchangedSince: 'abc', snapshot: '/s/abc.json' });
  });
});

describe('writeKnowledgeSnapshot', () => {
  it('writes each version once and prunes the oldest beyond the cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'knowledge-snap-'));
    dirs.push(dir);
    const context = withKnowledgeVersion({ profileMemory: ['a'] });
    if (!context?.version) throw new Error('expected version');
    const file = await writeKnowledgeSnapshot(dir, context);
    expect(file).toBe(join(dir, `${context.version}.json`));
    expect(JSON.parse(await readFile(file ?? '', 'utf8'))).toEqual(context);

    for (let i = 0; i < 45; i += 1) {
      const old = join(dir, `old${i}.json`);
      await writeFile(old, '{}');
      await utimes(old, new Date(1000 + i), new Date(1000 + i));
    }
    await writeKnowledgeSnapshot(dir, withKnowledgeVersion({ profileMemory: ['b'] }) ?? {});
    const names = await readdir(dir);
    expect(names).toHaveLength(40);
    expect(names).not.toContain('old0.json');
  });

  it('skips a context without a version', async () => {
    expect(await writeKnowledgeSnapshot('/nonexistent', { profileMemory: ['a'] })).toBeUndefined();
  });
});
