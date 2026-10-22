import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { CodeSnippetStore, extractCodeBlocks, snippetKey } from '../../../src/card/code-snippets.js';
import { MAX_COPY_BUTTONS, renderCard } from '../../../src/card/run-renderer.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import { runCommandHandler, type CommandContext } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { createFakeChannel } from '../../helpers/fake-channel.js';

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce(reduce, initialState);
}

/** Every button on the card, as [label, callback value]. */
function buttons(card: object): Array<[string, Record<string, unknown>]> {
  const found: Array<[string, Record<string, unknown>]> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const el = node as Record<string, unknown>;
    if (el.tag === 'button') {
      const value = (el.behaviors as Array<{ value: Record<string, unknown> }>)[0]!.value;
      found.push([(el.text as { content: string }).content, value]);
    }
    Object.values(el).forEach(walk);
  };
  walk(card);
  return found;
}

const SQL = "SELECT *\nFROM t\nWHERE a = '%&#x3D;%';";
const ANSWER = `结论如下：\n\n\`\`\`sql\n${SQL}\n\`\`\`\n\n再执行：\n\n~~~bash\nls -la\n~~~\n`;

describe('extractCodeBlocks', () => {
  it('finds backtick and tilde fences with their languages, keeping the code verbatim', () => {
    expect(extractCodeBlocks(ANSWER)).toEqual([
      { lang: 'sql', code: SQL },
      { lang: 'bash', code: 'ls -la' },
    ]);
  });

  it('keeps a shorter fence inside a longer one as code', () => {
    const md = '````md\n```js\nx()\n```\n````';
    expect(extractCodeBlocks(md)).toEqual([{ lang: 'md', code: '```js\nx()\n```' }]);
  });

  it('ignores unclosed and empty blocks', () => {
    expect(extractCodeBlocks('```sql\nSELECT 1')).toEqual([]);
    expect(extractCodeBlocks('```\n\n```')).toEqual([]);
  });
});

describe('copy buttons on the run card', () => {
  const done = stateFrom([
    { type: 'text', delta: ANSWER },
    { type: 'done', terminationReason: 'normal' },
  ]);

  it('adds one button per code block on a finished card, carrying only the key', () => {
    const kept: string[] = [];
    const card = renderCard(done, { copyCode: (code) => (kept.push(code), snippetKey(code)) });
    expect(kept).toEqual([SQL, 'ls -la']);
    expect(buttons(card)).toEqual([
      ['📋 复制 #1 SQL', { cmd: `copycode.${snippetKey(SQL)}` }],
      ['📋 复制 #2 BASH', { cmd: `copycode.${snippetKey('ls -la')}` }],
    ]);
  });

  it('labels a lone block without a number', () => {
    const one = stateFrom([
      { type: 'text', delta: '```\nmake\n```' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(buttons(renderCard(one, { copyCode: snippetKey }))[0]![0]).toBe('📋 复制代码');
  });

  it('adds none while running, without a store, or when there is no code', () => {
    const running = stateFrom([{ type: 'text', delta: ANSWER }]);
    expect(buttons(renderCard(running, { copyCode: snippetKey })).map(([label]) => label)).toEqual(['⏹ 终止']);
    expect(buttons(renderCard(done))).toEqual([]);
    const plain = stateFrom([
      { type: 'text', delta: 'no code here' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(buttons(renderCard(plain, { copyCode: snippetKey }))).toEqual([]);
  });

  it(`stops at ${MAX_COPY_BUTTONS} buttons`, () => {
    const many = Array.from({ length: MAX_COPY_BUTTONS + 2 }, (_, i) => `\`\`\`\ncmd ${i}\n\`\`\``).join('\n\n');
    const state = stateFrom([
      { type: 'text', delta: many },
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(buttons(renderCard(state, { copyCode: snippetKey }))).toHaveLength(MAX_COPY_BUTTONS);
  });
});

describe('CodeSnippetStore', () => {
  it('returns stable keys, survives a reload, and drops the oldest past its cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snippets-'));
    const path = join(dir, 'code-snippets.json');
    const store = new CodeSnippetStore(path, 2);
    const a = store.put('a');
    expect(store.put('a')).toBe(a);
    const b = store.put('b');
    store.put('c');
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toBe('b');
    await store.flush();

    const reloaded = new CodeSnippetStore(path, 2);
    await reloaded.load();
    expect(reloaded.get(b)).toBe('b');
    expect(reloaded.get(snippetKey('c'))).toBe('c');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ [b]: 'b', [snippetKey('c')]: 'c' });
  });
});

describe('/copycode', () => {
  const ctxFor = (store: CodeSnippetStore | undefined) => {
    const channel = createFakeChannel();
    const profileConfig = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access: { allowedUsers: ['ou-member'] },
    });
    const ctx = {
      channel,
      msg: { messageId: 'om_card', chatId: 'oc_dm', chatType: 'p2p', senderId: 'ou-member' },
      scope: 'oc_dm',
      chatMode: 'p2p',
      controls: { profile: 'claude', profileConfig, ...(store ? { codeSnippets: store } : {}) },
      fromCardAction: true,
    } as unknown as CommandContext;
    return { channel, ctx };
  };

  it('replies with the code alone as plain text, emails masked like on the card', async () => {
    const store = new CodeSnippetStore(join(await mkdtemp(join(tmpdir(), 'snippets-')), 'code-snippets.json'));
    const code = 'git commit -m "x" --author="A <a.b@example.com>"';
    const key = store.put(code);
    const { channel, ctx } = ctxFor(store);

    expect(await runCommandHandler('copycode', key, ctx)).toBe(true);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]!.content).toEqual({ text: 'git commit -m "x" --author="A <a.b[at]example.com>"' });
    expect(channel.sent[0]!.options).toMatchObject({ replyTo: 'om_card' });
  });

  it('says so when the code is gone', async () => {
    const { channel, ctx } = ctxFor(undefined);
    await runCommandHandler('copycode', 'deadbeefdeadbeef', ctx);
    expect(JSON.stringify(channel.sent[0]!.content)).toContain('这段代码已经找不到了');
  });
});
