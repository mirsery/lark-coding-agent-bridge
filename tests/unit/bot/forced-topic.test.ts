import { describe, expect, it } from 'vitest';
import { ForcedTopicJoiner, replyTargetOf } from '../../../src/bot/forced-topic.js';

const topic = { threadId: 'omt_1', rootMessageId: 'om_root' };

describe('ForcedTopicJoiner', () => {
  it('lets a message join a topic that is still being opened', async () => {
    const joiner = new ForcedTopicJoiner(3000, () => 0);
    let resolve!: (t: typeof topic) => void;
    joiner.open('chat:user', new Promise((r) => { resolve = r; }));
    const joining = joiner.join('chat:user');
    expect(joining).toBeDefined();
    resolve(topic);
    await expect(joining).resolves.toEqual(topic);
  });

  it('keeps the topic open for the window after it opened, sliding on each join', async () => {
    let now = 0;
    const joiner = new ForcedTopicJoiner(3000, () => now);
    joiner.open('chat:user', Promise.resolve(topic));
    await Promise.resolve();
    now = 2500;
    expect(joiner.join('chat:user')).toBeDefined();
    now = 5000;
    expect(joiner.join('chat:user')).toBeDefined();
    now = 8001;
    expect(joiner.join('chat:user')).toBeUndefined();
  });

  it('does not join across senders', () => {
    const joiner = new ForcedTopicJoiner(3000, () => 0);
    joiner.open('chat:user', Promise.resolve(topic));
    expect(joiner.join('chat:other')).toBeUndefined();
  });

  it('forgets a topic that failed to open', async () => {
    const joiner = new ForcedTopicJoiner(3000, () => 0);
    const failed = Promise.resolve(undefined);
    joiner.open('chat:user', failed);
    await failed;
    await Promise.resolve();
    expect(joiner.join('chat:user')).toBeUndefined();
  });
});

describe('replyTargetOf', () => {
  it('replies under the topic root for a message that joined it', () => {
    expect(replyTargetOf({ messageId: 'om_2', forcedTopicRootId: 'om_1' })).toBe('om_1');
    expect(replyTargetOf({ messageId: 'om_2' })).toBe('om_2');
  });
});
