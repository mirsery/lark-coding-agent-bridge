import { describe, expect, it } from 'vitest';
import { createClaudeAccountResolver, parseAuthStatus } from '../../../src/agent/claude/account';

const status = (fields: Record<string, unknown>) => JSON.stringify(fields);

describe('parseAuthStatus', () => {
  it('returns the login username for a claude.ai login', () => {
    expect(
      parseAuthStatus(status({ loggedIn: true, authMethod: 'claude.ai', email: 'first.last@example.com' })),
    ).toBe('first.last');
  });

  it('returns undefined when logged out, on an API key, or on unreadable output', () => {
    expect(parseAuthStatus(status({ loggedIn: false, authMethod: 'claude.ai', email: 'a@b.c' }))).toBeUndefined();
    expect(parseAuthStatus(status({ loggedIn: true, authMethod: 'api_key' }))).toBeUndefined();
    expect(parseAuthStatus(status({ loggedIn: true, authMethod: 'claude.ai', email: ' ' }))).toBeUndefined();
    expect(parseAuthStatus('{not json')).toBeUndefined();
  });
});

describe('createClaudeAccountResolver', () => {
  it('reuses one lookup within the TTL and picks up an account switch after it', async () => {
    let clock = 0;
    let email = 'first@example.com';
    let reads = 0;
    const resolve = createClaudeAccountResolver({
      readStatus: async () => {
        reads += 1;
        return status({ loggedIn: true, authMethod: 'claude.ai', email });
      },
      ttlMs: 1_000,
      now: () => clock,
    });

    expect(await resolve()).toBe('first');
    email = 'second@example.com';
    clock = 500;
    expect(await resolve()).toBe('first');
    expect(reads).toBe(1);

    clock = 1_500;
    expect(await resolve()).toBe('second');
    expect(reads).toBe(2);
  });

  it('resolves undefined when the CLI cannot be asked', async () => {
    const resolve = createClaudeAccountResolver({
      readStatus: async () => {
        throw new Error('spawn claude ENOENT');
      },
    });
    expect(await resolve()).toBeUndefined();
  });
});
