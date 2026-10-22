import type { SupplementTarget } from './active-runs';

/**
 * Leading markers that mean "add this to the task that is running" rather
 * than "here is a new question": 补充 / 追加 / +, each also accepted with a
 * leading slash (/补充, /追加, /+) since that is how people type commands.
 */
const SUPPLEMENT_PREFIX_RE = /^\s*\/?(?:补充|追加|\+)/;

const SUPPLEMENT_PREFIX_TRIM_RE = /^\/?(?:补充|追加|\+)[\s:：,，]*/;

const PREVIEW_MAX = 60;

export type SupplementSignal = 'quote' | 'prefix' | 'topic';

/**
 * Only explicit signals count: guessing wrong in the "supplement" direction
 * mixes a new question into someone's running task, while guessing wrong the
 * other way merely queues it for the next run — so no signal means queue.
 *
 * A topic is itself an explicit signal: the run is scoped to that topic, and
 * a message posted there hangs off the topic root rather than quoting the
 * run, so a follow-up in the same topic while the run is going is folded in
 * without a quote or prefix.
 */
export function supplementSignal(
  content: string,
  quotedMessageId: string | undefined,
  target: SupplementTarget,
  inTopic = false,
): SupplementSignal | undefined {
  if (quotedMessageId && quotesRun(quotedMessageId, target)) return 'quote';
  if (SUPPLEMENT_PREFIX_RE.test(content)) return 'prefix';
  if (inTopic) return 'topic';
  return undefined;
}

/** The quoted message is the run's own trigger or reply — not something new to read. */
export function quotesRun(quotedMessageId: string, target: SupplementTarget): boolean {
  return target.originIds.has(quotedMessageId) || target.replyIds.has(quotedMessageId);
}

/**
 * A supplement runs with the run's existing identity and permissions, so only
 * whoever started it (or the bot owner) may add to it — anyone else would be
 * borrowing them.
 */
export function maySupplement(target: SupplementTarget, senderId: string, isOwner: boolean): boolean {
  return isOwner || target.initiators.has(senderId);
}

/** One-line preview for the reply's「收到补充」marker (prefix dropped — the marker says it). */
export function supplementPreview(content: string, attachmentCount: number): string {
  const text = content.replace(/\s+/g, ' ').trim().replace(SUPPLEMENT_PREFIX_TRIM_RE, '');
  if (!text) return attachmentCount > 0 ? `（${attachmentCount} 个附件）` : '（空消息）';
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
}

export const SUPPLEMENT_INSTRUCTION =
  '这条消息是用户在你执行当前任务的过程中追加的补充信息，不是新任务：把它纳入当前任务继续做；' +
  '它改变了要求时按新要求调整，已经完成且不受影响的部分不用重做。';
