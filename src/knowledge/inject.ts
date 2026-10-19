import type { LibraryEntry, LibraryWriteTarget } from './knowledge-libraries';
import type { KnowledgeStore, MemoryEntry, SkillSummary } from './store';

export interface KnowledgeContext {
  /** Notes that apply to every chat in this profile. */
  profileMemory?: string[];
  /** Notes recorded for this chat / topic only. */
  chatMemory?: string[];
  /** Index only — the agent reads a skill's body itself when it needs it. */
  skills?: SkillRef[];
  /** Index of the subscribed knowledge libraries (a department's shared repository…). */
  libraryKnowledge?: LibraryEntryRef[];
  /** Libraries the agent may commit to right now — only while a write window is open. */
  libraryWrite?: LibraryWriteRef[];
  /** Set when notes were dropped to stay inside the budget. */
  truncated?: boolean;
}

export interface BuildKnowledgeContextInput {
  store: KnowledgeStore;
  scopeId: string;
  /** Character budget for the memory notes. Skills are just an index. */
  maxChars?: number;
}

export interface SkillRef {
  name: string;
  description: string;
  path: string;
  /** Shared library the skill comes from; absent for the profile's own. */
  source?: string;
  /** From a third party's library: read-only here, changes go to that repository's maintainers. */
  external?: true;
}

export interface LibraryEntryRef {
  library: string;
  path: string;
  title: string;
  summary: string;
  /** Under `shared/`: the library's reviewed conclusions. */
  authoritative?: true;
  /** In this bot's own directory of the library. */
  own?: true;
  /** Another bot's notes: for reference only. */
  personal?: true;
}

export interface LibraryWriteRef {
  library: string;
  /** Clone to commit and push in. */
  work: string;
  /** Directory the default branch accepts changes in. */
  self: string;
  branch: string;
  /** When the window closes, ISO 8601. */
  until: string;
}

const DEFAULT_MAX_CHARS = 6000;
const MAX_SKILLS = 80;
/**
 * The index rides along on every message, and shared libraries can bring dozens
 * of skills with paragraph-long descriptions. One sentence is enough to decide
 * whether to open the body, and the whole index gets its own budget.
 */
const MAX_DESCRIPTION_CHARS = 240;
const SKILL_INDEX_MAX_CHARS = 16_000;
/** Entries arrive shared first, other bots' notes last, so those are what the budget drops. */
const MAX_LIBRARY_ENTRIES = 120;
const LIBRARY_INDEX_MAX_CHARS = 8000;

/**
 * Assemble what the agent should know before answering, or `undefined` when
 * there is nothing to inject.
 *
 * Only the skill *index* goes into the prompt. Bodies stay on disk and are read
 * on demand: a dozen skills would otherwise cost thousands of tokens on every
 * single turn, most of them irrelevant to the message at hand.
 */
export async function buildKnowledgeContext(
  input: BuildKnowledgeContextInput,
): Promise<KnowledgeContext | undefined> {
  const [profile, chat, skills, entries, targets] = await Promise.all([
    input.store.listMemories({ kind: 'profile' }),
    input.store.listMemories({ kind: 'chat', scopeId: input.scopeId }),
    input.store.listSkills(),
    // A library that cannot be read must not cost the run its own memory.
    input.store.listLibraryEntries().catch((): LibraryEntry[] => []),
    input.store.libraryWriteTargets().catch((): LibraryWriteTarget[] => []),
  ]);

  const budgeted = applyBudget(profile, chat, input.maxChars ?? DEFAULT_MAX_CHARS);
  const trimmedSkills = budgetSkills(skills.slice(0, MAX_SKILLS).map(toSkillRef));
  const libraryKnowledge = budgetLibraryEntries(entries.slice(0, MAX_LIBRARY_ENTRIES).map(toLibraryEntryRef));
  const libraryWrite = targets.map(toLibraryWriteRef);
  if (
    budgeted.profile.length === 0 &&
    budgeted.chat.length === 0 &&
    trimmedSkills.length === 0 &&
    libraryKnowledge.length === 0 &&
    libraryWrite.length === 0
  ) {
    return undefined;
  }

  return {
    ...(budgeted.profile.length > 0 ? { profileMemory: budgeted.profile } : {}),
    ...(budgeted.chat.length > 0 ? { chatMemory: budgeted.chat } : {}),
    ...(trimmedSkills.length > 0 ? { skills: trimmedSkills } : {}),
    ...(libraryKnowledge.length > 0 ? { libraryKnowledge } : {}),
    ...(libraryWrite.length > 0 ? { libraryWrite } : {}),
    ...(budgeted.truncated || skills.length > trimmedSkills.length || entries.length > libraryKnowledge.length
      ? { truncated: true }
      : {}),
  };
}

function toLibraryEntryRef(entry: LibraryEntry): LibraryEntryRef {
  return {
    library: entry.library,
    path: entry.path,
    title: entry.title,
    summary: entry.summary,
    ...(entry.kind === 'shared' ? { authoritative: true as const } : {}),
    ...(entry.kind === 'own' ? { own: true as const } : {}),
    ...(entry.kind === 'personal' ? { personal: true as const } : {}),
  };
}

function toLibraryWriteRef(target: LibraryWriteTarget): LibraryWriteRef {
  return {
    library: target.library,
    work: target.work,
    self: `${target.self}/`,
    branch: target.defaultBranch,
    until: new Date(target.until).toISOString(),
  };
}

function budgetLibraryEntries(entries: LibraryEntryRef[]): LibraryEntryRef[] {
  const kept: LibraryEntryRef[] = [];
  let used = 0;
  for (const entry of entries) {
    const size = entry.library.length + entry.path.length + entry.title.length + entry.summary.length;
    if (used + size > LIBRARY_INDEX_MAX_CHARS) break;
    kept.push(entry);
    used += size;
  }
  return kept;
}

function toSkillRef(skill: SkillSummary): SkillRef {
  const description =
    skill.description.length > MAX_DESCRIPTION_CHARS
      ? `${skill.description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
      : skill.description;
  return {
    name: skill.name,
    description,
    path: skill.path,
    ...(skill.source ? { source: skill.source } : {}),
    ...(skill.external ? { external: true as const } : {}),
  };
}

/** Keep skills in order until the index budget runs out (own skills come first). */
function budgetSkills(skills: SkillRef[]): SkillRef[] {
  const kept: SkillRef[] = [];
  let used = 0;
  for (const skill of skills) {
    const size = skill.name.length + skill.description.length + skill.path.length + (skill.source?.length ?? 0);
    if (used + size > SKILL_INDEX_MAX_CHARS) break;
    kept.push(skill);
    used += size;
  }
  return kept;
}

/**
 * Keep the newest notes when the budget is tight, and give chat notes priority
 * over profile ones: the local context is what the current message is about.
 */
function applyBudget(
  profile: MemoryEntry[],
  chat: MemoryEntry[],
  maxChars: number,
): { profile: string[]; chat: string[]; truncated: boolean } {
  const keptChat: string[] = [];
  const keptProfile: string[] = [];
  let used = 0;
  let truncated = false;

  for (const entry of [...chat].reverse()) {
    if (used + entry.text.length > maxChars) {
      truncated = true;
      break;
    }
    keptChat.unshift(entry.text);
    used += entry.text.length;
  }
  for (const entry of [...profile].reverse()) {
    if (used + entry.text.length > maxChars) {
      truncated = true;
      break;
    }
    keptProfile.unshift(entry.text);
    used += entry.text.length;
  }

  return { profile: keptProfile, chat: keptChat, truncated };
}
