import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAccountName } from '../../../src/agent/claude/account';

function configFile(content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'claude-account-')), '.claude.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

describe('claudeAccountName', () => {
  it('prefers the display name, then full name, then email', () => {
    expect(
      claudeAccountName(configFile({ oauthAccount: { displayName: 'CC', fullName: 'Full', emailAddress: 'a@b.c' } })),
    ).toBe('CC');
    expect(claudeAccountName(configFile({ oauthAccount: { displayName: ' ', fullName: 'Full' } }))).toBe('Full');
    expect(claudeAccountName(configFile({ oauthAccount: { emailAddress: 'a@b.c' } }))).toBe('a@b.c');
  });

  it('returns undefined without a claude.ai login or a readable file', () => {
    expect(claudeAccountName(configFile({ numStartups: 3 }))).toBeUndefined();
    expect(claudeAccountName(configFile('{not json'))).toBeUndefined();
    expect(claudeAccountName(join(tmpdir(), 'does-not-exist', '.claude.json'))).toBeUndefined();
  });
});
