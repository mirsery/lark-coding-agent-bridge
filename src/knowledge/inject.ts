import type { KnowledgeStore, MemoryEntry, SkillSummary } from './store';

export interface KnowledgeContext {
  /** Notes that apply to every chat in this profile. */
  profileMemory?: string[];
  /** Notes recorded for this chat / topic only. */
  chatMemory?: string[];
  /** Index only — the agent reads a skill's body itself when it needs it. */
  skills?: Array<{ name: string; description: string; path: string }>;
  /** Set when notes were dropped to stay inside the budget. */
  truncated?: boolean;
}

export interface BuildKnowledgeContextInput {
  store: KnowledgeStore;
  scopeId: string;
  /** Character budget for the memory notes. Skills are just an index. */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 6000;
const MAX_SKILLS = 40;

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
  const [profile, chat, skills] = await Promise.all([
    input.store.listMemories({ kind: 'profile' }),
    input.store.listMemories({ kind: 'chat', scopeId: input.scopeId }),
    input.store.listSkills(),
  ]);

  const budgeted = applyBudget(profile, chat, input.maxChars ?? DEFAULT_MAX_CHARS);
  const trimmedSkills = skills.slice(0, MAX_SKILLS);
  if (
    budgeted.profile.length === 0 &&
    budgeted.chat.length === 0 &&
    trimmedSkills.length === 0
  ) {
    return undefined;
  }

  return {
    ...(budgeted.profile.length > 0 ? { profileMemory: budgeted.profile } : {}),
    ...(budgeted.chat.length > 0 ? { chatMemory: budgeted.chat } : {}),
    ...(trimmedSkills.length > 0 ? { skills: trimmedSkills.map(toSkillRef) } : {}),
    ...(budgeted.truncated || skills.length > trimmedSkills.length ? { truncated: true } : {}),
  };
}

function toSkillRef(skill: SkillSummary): { name: string; description: string; path: string } {
  return { name: skill.name, description: skill.description, path: skill.path };
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
