import { describe, expect, it } from 'vitest';
import { configFormCard, type ConfigFormOpts } from '../../../src/card/config-card';

const base: ConfigFormOpts = {
  agentKind: 'claude',
  mode: 'personal',
  model: 'default',
  effort: undefined,
  messageReply: 'markdown',
  showToolCalls: false,
  cotMessages: 'off',
  maxConcurrentRuns: 1,
  runIdleTimeoutMinutes: 0,
  requireMentionInGroup: false,
  larkCliIdentity: 'bot-only',
  allowedUsers: [],
  allowedChats: [],
  admins: [],
  knownChats: [],
};

describe('configFormCard console URL', () => {
  it('shows the web console URL when one is running', () => {
    const url = 'http://127.0.0.1:53219/?token=abc123';
    const card = configFormCard({ ...base, consoleUrl: url });
    expect(JSON.stringify(card)).toContain(url);
    expect(JSON.stringify(card)).toContain('Web 控制台');
  });

  it('omits the console section when no console is running', () => {
    const card = configFormCard(base);
    expect(JSON.stringify(card)).not.toContain('Web 控制台');
  });
});

type Select = { tag: string; name?: string; initial_option?: string; options?: { value: string }[] };

function replyPicker(card: object): Select {
  const found = JSON.stringify(card).length > 0 ? findSelect(card) : undefined;
  if (!found) throw new Error('message_reply picker not found');
  return found;
}

function findSelect(node: unknown): Select | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findSelect(item);
      if (hit) return hit;
    }
    return undefined;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj.tag === 'select_static' && obj.name === 'message_reply') return obj as Select;
    for (const value of Object.values(obj)) {
      const hit = findSelect(value);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe('configFormCard message reply picker', () => {
  it('offers all three reply modes', () => {
    const picker = replyPicker(configFormCard(base));
    expect(picker.options?.map((o) => o.value)).toEqual(['text', 'markdown', 'card']);
  });

  it('keeps `card` selected instead of silently showing it as markdown', () => {
    const picker = replyPicker(configFormCard({ ...base, messageReply: 'card' }));
    expect(picker.initial_option).toBe('card');
  });
});
