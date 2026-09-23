import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The logged-in Claude account's display name, read from the CLI's own
 * `.claude.json` (`oauthAccount`). Used to sign reply cards with who is
 * paying for the run. Returns undefined when the CLI is not logged in via
 * claude.ai (API key, Bedrock, …) or the file is unreadable.
 */
export function claudeAccountName(configPath = claudeConfigPath()): string | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(configPath).mtimeMs;
  } catch {
    return undefined;
  }
  // The file is rewritten often by the CLI; re-parse only when it changed.
  if (cache && cache.path === configPath && cache.mtimeMs === mtimeMs) return cache.name;
  let name: string | undefined;
  try {
    const account = (JSON.parse(readFileSync(configPath, 'utf8')) as { oauthAccount?: OauthAccount })
      .oauthAccount;
    name = pick(account?.displayName) ?? pick(account?.fullName) ?? pick(account?.emailAddress);
  } catch {
    name = undefined;
  }
  cache = { path: configPath, mtimeMs, name };
  return name;
}

interface OauthAccount {
  displayName?: unknown;
  fullName?: unknown;
  emailAddress?: unknown;
}

let cache: { path: string; mtimeMs: number; name: string | undefined } | undefined;

function claudeConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? join(dir, '.claude.json') : join(homedir(), '.claude.json');
}

function pick(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
