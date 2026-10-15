import type { NormalizedMessage } from '@larksuite/channel';
import { isCreator, type RuntimeControls } from './access';

/**
 * Whether every message of a batch comes from the bot owner in person — not
 * a bot, and not someone quoting or relaying the owner. Unknown owner counts
 * as not the owner.
 */
export function isOwnerBatch(
  controls: RuntimeControls,
  batch: readonly NormalizedMessage[],
  isBot: (msg: NormalizedMessage) => boolean,
): boolean {
  return batch.length > 0 && batch.every((m) => isCreator(controls, m.senderId) && !isBot(m));
}
