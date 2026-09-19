import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

type ReactionType = 'Typing' | 'DONE';

async function addReaction(
  channel: LarkChannel,
  messageId: string,
  type: ReactionType,
): Promise<string | undefined> {
  try {
    const id = await channel.addReaction(messageId, type);
    if (id) log.info('reaction', 'added', { messageId, reactionId: id, type });
    return id;
  } catch (err) {
    log.warn('reaction', 'add-failed', {
      messageId,
      type,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Add a "Typing" reaction (敲键盘) to a message to give text-mode users an
 * instant "I got your message and I'm responding" cue while Claude is still
 * thinking. Matches the conventional Feishu UX for "the other side is
 * replying". Card mode doesn't need this — the streaming card already
 * shows a "正在思考…" footer the moment it's posted.
 *
 * Returns the reaction id on success, undefined on any failure. Failures
 * are logged but never thrown — losing a decoration must not break the
 * actual reply flow.
 */
export function addWorkingReaction(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  return addReaction(channel, messageId, 'Typing');
}

/**
 * Add a "DONE" reaction to the triggering message once a run finishes
 * successfully. Unlike the Typing reaction this fires in every reply mode
 * (card included) — the point is a glance-able marker on the question
 * itself ("this got answered"), independent of whether the reply card
 * shows its own status.
 */
export function addDoneReaction(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  return addReaction(channel, messageId, 'DONE');
}

/** Remove a previously-added reaction. Tolerates errors silently — best
 * effort cleanup; a leftover reaction is harmless. */
export async function removeReaction(
  channel: LarkChannel,
  messageId: string,
  reactionId: string,
): Promise<void> {
  try {
    await channel.removeReaction(messageId, reactionId);
    log.info('reaction', 'removed', { messageId, reactionId });
  } catch (err) {
    log.warn('reaction', 'remove-failed', {
      messageId,
      reactionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
