import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

/**
 * Bridge-managed knowledge for one profile: what the bot should remember, and
 * the reusable instructions it can pull in on demand.
 *
 * Everything is plain Markdown on disk rather than a database, for one reason:
 * the directory is meant to be a git repository. A human can read it, edit it
 * in an editor, review a diff of it, and sync it between machines — none of
 * which works if the same content lives in a JSON blob.
 *
 *   knowledge/
 *     MEMORY.md                 profile-wide notes
 *     chats/<scope>.md          notes scoped to one chat / topic
 *     skills/<name>/SKILL.md    reusable instructions, agent-agnostic
 */

export type MemoryScope = { kind: 'profile' } | { kind: 'chat'; scopeId: string };

export interface MemoryEntry {
  /** Short stable id, written into the file so edits keep it. */
  id: string;
  text: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  /** Absolute path of SKILL.md — handed to the agent so it can read the body. */
  path: string;
}

/** Bullet lines look like `- [a1b2c3] remember this`. */
const ENTRY_RE = /^-\s*\[([0-9a-f]{6})\]\s*(.*)$/;

export class KnowledgeStore {
  readonly dir: string;

  constructor(dir: string = paths.knowledgeDir) {
    this.dir = dir;
  }

  get skillsDir(): string {
    return join(this.dir, 'skills');
  }

  memoryFile(scope: MemoryScope): string {
    if (scope.kind === 'profile') return join(this.dir, 'MEMORY.md');
    return join(this.dir, 'chats', `${sanitizeScopeId(scope.scopeId)}.md`);
  }

  async listMemories(scope: MemoryScope): Promise<MemoryEntry[]> {
    const raw = await readIfExists(this.memoryFile(scope));
    if (!raw) return [];
    const entries: MemoryEntry[] = [];
    for (const line of raw.split('\n')) {
      const match = ENTRY_RE.exec(line.trim());
      if (match?.[1] && match[2]?.trim()) entries.push({ id: match[1], text: match[2].trim() });
    }
    return entries;
  }

  async addMemory(scope: MemoryScope, text: string): Promise<MemoryEntry> {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('memory text is empty');
    const existing = await this.listMemories(scope);
    const taken = new Set(existing.map((entry) => entry.id));
    let id = randomBytes(3).toString('hex');
    while (taken.has(id)) id = randomBytes(3).toString('hex');

    const file = this.memoryFile(scope);
    const current = (await readIfExists(file)) ?? defaultMemoryHeader(scope);
    const body = `${current.replace(/\s*$/, '')}\n- [${id}] ${clean}\n`;
    await this.write(file, body);
    return { id, text: clean };
  }

  async removeMemory(scope: MemoryScope, id: string): Promise<boolean> {
    const file = this.memoryFile(scope);
    const raw = await readIfExists(file);
    if (!raw) return false;
    let removed = false;
    const kept = raw.split('\n').filter((line) => {
      const match = ENTRY_RE.exec(line.trim());
      if (match?.[1] === id) {
        removed = true;
        return false;
      }
      return true;
    });
    if (!removed) return false;
    await this.write(file, `${kept.join('\n').replace(/\s*$/, '')}\n`);
    return true;
  }

  /** Drop every note in a scope — `/memory clear`. Returns how many went. */
  async clearMemories(scope: MemoryScope): Promise<number> {
    const entries = await this.listMemories(scope);
    if (entries.length === 0) return 0;
    await this.write(this.memoryFile(scope), defaultMemoryHeader(scope));
    return entries.length;
  }

  async listSkills(): Promise<SkillSummary[]> {
    let names: string[];
    try {
      const dirents = await readdir(this.skillsDir, { withFileTypes: true });
      names = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('knowledge', 'skills-scan-failed', { err: String(err) });
      }
      return [];
    }

    const skills: SkillSummary[] = [];
    for (const name of names.sort()) {
      const path = join(this.skillsDir, name, 'SKILL.md');
      const raw = await readIfExists(path);
      if (raw === undefined) continue;
      skills.push({ ...parseSkillHeader(name, raw), path });
    }
    return skills;
  }

  async readSkill(name: string): Promise<{ summary: SkillSummary; body: string } | undefined> {
    if (!isSafeSkillName(name)) return undefined;
    const path = join(this.skillsDir, name, 'SKILL.md');
    const raw = await readIfExists(path);
    if (raw === undefined) return undefined;
    return { summary: { ...parseSkillHeader(name, raw), path }, body: raw };
  }

  /** Create the directory skeleton so a fresh profile has something to sync. */
  async ensure(): Promise<void> {
    await mkdir(join(this.dir, 'chats'), { recursive: true, mode: 0o700 });
    await mkdir(this.skillsDir, { recursive: true, mode: 0o700 });
  }

  /** Remove a chat's note file entirely (used when a chat is forgotten). */
  async dropChat(scopeId: string): Promise<void> {
    await rm(this.memoryFile({ kind: 'chat', scopeId }), { force: true });
  }

  private async write(file: string, body: string): Promise<void> {
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    // 0600 like every other piece of profile state: chat notes routinely quote
    // things people would not want world-readable on a shared machine.
    await writeFileAtomic(file, body, { mode: 0o600 });
  }
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function defaultMemoryHeader(scope: MemoryScope): string {
  return scope.kind === 'profile'
    ? '# 记忆（全局）\n\n这个 profile 下所有会话都会看到下面的内容。\n'
    : '# 记忆（本会话）\n\n只有这个会话会看到下面的内容。\n';
}

/**
 * A chat scope id (`oc_xxx` or `oc_xxx:omt_yyy`) becomes one safe file name.
 * The colon is illegal on Windows, and the id itself is not a secret but is
 * long, so it is kept verbatim apart from separator characters.
 */
export function sanitizeScopeId(scopeId: string): string {
  return scopeId.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'unknown';
}

export function isSafeSkillName(name: string): boolean {
  return /^[\w.-]{1,64}$/.test(name) && name !== '.' && name !== '..';
}

/**
 * Read a skill's name and one-line description.
 *
 * Accepts the YAML-ish frontmatter that Claude Code skills use, and falls back
 * to "first heading + first paragraph" so a plain Markdown file also works —
 * the point of this layer is that one file serves both agents.
 */
export function parseSkillHeader(dirName: string, raw: string): { name: string; description: string } {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(raw);
  if (frontmatter?.[1]) {
    const block = frontmatter[1];
    const name = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const description = /^description:\s*(.+)$/m.exec(block)?.[1]?.trim();
    if (name || description) {
      return { name: name || dirName, description: description || '' };
    }
  }

  const lines = raw.split('\n');
  const heading = lines.find((line) => line.startsWith('# '))?.slice(2).trim();
  const firstProse = lines.find(
    (line) => line.trim() && !line.startsWith('#') && !line.startsWith('---'),
  );
  return { name: heading || dirName, description: (firstProse ?? '').trim() };
}
