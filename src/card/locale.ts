/**
 * The language a conversation is held in, read off what the caller wrote.
 * Chinese is the default: only a message with real foreign prose switches it.
 */
export type Locale = 'zh' | 'en';

const HAN = /\p{Script=Han}/u;
// Bits of a message that say nothing about the writer's language: links,
// paths and slash commands, @mentions, and anything with a digit (SNs, ticket
// keys, versions).
const NOISE = /https?:\/\/\S+|(?<!\S)[/~.]\S*|@\S+|\S*\d\S*/gu;
const WORD = /\p{L}{2,}/gu;
/**
 * Fewer real words than this is a pick or an ack (`b`, `ok`), not a language:
 * stay on the Chinese default.
 */
const MIN_FOREIGN_WORDS = 3;

export function detectLocale(texts: readonly string[]): Locale {
  const joined = texts.join('\n');
  if (HAN.test(joined)) return 'zh';
  const words = joined.replace(NOISE, ' ').match(WORD) ?? [];
  return words.length >= MIN_FOREIGN_WORDS ? 'en' : 'zh';
}
