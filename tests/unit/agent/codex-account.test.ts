import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCodexAccountResolver,
  effectiveCodexHome,
  parseCodexAuth,
} from '../../../src/agent/codex/account';

const idToken = (claims: Record<string, unknown>) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const auth = (fields: Record<string, unknown>) => JSON.stringify(fields);

describe('parseCodexAuth', () => {
  it('returns the login username for a ChatGPT login', () => {
    expect(
      parseCodexAuth(auth({ auth_mode: 'chatgpt', tokens: { id_token: idToken({ email: 'first.last@example.com' }) } })),
    ).toBe('first.last');
  });

  it('returns undefined for an API-key login, a missing or odd token, or unreadable JSON', () => {
    expect(parseCodexAuth(auth({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }))).toBeUndefined();
    expect(parseCodexAuth(auth({ auth_mode: 'chatgpt', tokens: {} }))).toBeUndefined();
    expect(parseCodexAuth(auth({ auth_mode: 'chatgpt', tokens: { id_token: 'not-a-jwt' } }))).toBeUndefined();
    expect(parseCodexAuth(auth({ auth_mode: 'chatgpt', tokens: { id_token: idToken({ email: ' ' }) } }))).toBeUndefined();
    expect(parseCodexAuth('{not json')).toBeUndefined();
  });
});

describe('effectiveCodexHome', () => {
  const saved = process.env.CODEX_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  });

  it('follows the same resolution as the adapter', () => {
    expect(effectiveCodexHome({ codexHome: '/custom' })).toBe('/custom');
    expect(effectiveCodexHome({ inheritCodexHome: false }, '/state')).toBe(join('/state', 'codex-home'));
    expect(effectiveCodexHome({ inheritCodexHome: false })).toBeUndefined();
    process.env.CODEX_HOME = '/outer';
    expect(effectiveCodexHome({ inheritCodexHome: true })).toBe('/outer');
    delete process.env.CODEX_HOME;
    expect(effectiveCodexHome(undefined)).toBe(join(homedir(), '.codex'));
  });
});

describe('createCodexAccountResolver', () => {
  it('reuses one read per home within the TTL and picks up an account switch after it', async () => {
    let clock = 0;
    let email = 'first@example.com';
    let reads = 0;
    const resolve = createCodexAccountResolver({
      readAuth: async () => {
        reads += 1;
        return auth({ auth_mode: 'chatgpt', tokens: { id_token: idToken({ email }) } });
      },
      ttlMs: 1_000,
      now: () => clock,
    });

    expect(await resolve('/home-a')).toBe('first');
    email = 'second@example.com';
    clock = 500;
    expect(await resolve('/home-a')).toBe('first');
    expect(reads).toBe(1);
    clock = 1_500;
    expect(await resolve('/home-a')).toBe('second');
    expect(await resolve(undefined)).toBeUndefined();
  });

  it('resolves to undefined when auth.json cannot be read', async () => {
    const resolve = createCodexAccountResolver({ readAuth: async () => Promise.reject(new Error('ENOENT')) });
    expect(await resolve('/nowhere')).toBeUndefined();
  });
});
