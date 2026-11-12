/**
 * With `preferences.forceReplyInThread` on, every flat (non-topic) message
 * used to open its own topic. A user who sends a link and then the question
 * about it a moment later (or a long paste the client splits in two) got two
 * topics and two independent runs, each missing half the request.
 *
 * Messages from the same sender in the same chat that arrive while a forced
 * topic is still being opened, or within a short window after it opened, join
 * that topic instead. They then share one scope, so the normal debounce merges
 * them into one batch (or they queue behind the run already going there).
 */
export const FORCED_TOPIC_JOIN_MS = 3000;

export interface ForcedTopic {
  threadId: string;
  /** The flat message the topic was opened under. */
  rootMessageId: string;
}

interface OpenTopic {
  opened: Promise<ForcedTopic | undefined>;
  /** Infinity while the topic is still being opened. */
  expiresAt: number;
}

export class ForcedTopicJoiner {
  private readonly topics = new Map<string, OpenTopic>();

  constructor(
    private readonly windowMs = FORCED_TOPIC_JOIN_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * The topic this sender just opened (or is opening), or undefined when there
   * is none to join. Joining extends the window, so a burst of messages stays
   * together. Synchronous on purpose: callers must check and `open` without
   * an await in between, or two concurrent messages both miss.
   */
  join(key: string): Promise<ForcedTopic | undefined> | undefined {
    const topic = this.topics.get(key);
    if (!topic) return undefined;
    if (topic.expiresAt < this.now()) {
      this.topics.delete(key);
      return undefined;
    }
    if (Number.isFinite(topic.expiresAt)) topic.expiresAt = this.now() + this.windowMs;
    return topic.opened;
  }

  /** Record a topic being opened for this sender; a failed open is forgotten. */
  open(key: string, opened: Promise<ForcedTopic | undefined>): void {
    this.sweep();
    const topic: OpenTopic = { opened, expiresAt: Number.POSITIVE_INFINITY };
    this.topics.set(key, topic);
    const settle = (result: ForcedTopic | undefined) => {
      if (this.topics.get(key) !== topic) return;
      if (result) topic.expiresAt = this.now() + this.windowMs;
      else this.topics.delete(key);
    };
    opened.then(settle, () => settle(undefined));
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, topic] of this.topics) {
      if (topic.expiresAt < now) this.topics.delete(key);
    }
  }
}

/**
 * A flat message that joined another message's forced topic. It is not itself
 * in the topic, so replying to it "in thread" would open yet another topic:
 * replies go under the topic's root message instead. Kept on the message so it
 * survives the on-disk pending queue.
 */
export interface ForcedTopicMember {
  forcedTopicRootId?: string;
}

/** The message a reply to `msg` should hang off. */
export function replyTargetOf(msg: { messageId: string } & ForcedTopicMember): string {
  return msg.forcedTopicRootId ?? msg.messageId;
}
