import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CodexConfig } from '../../config/profile-schema';

/**
 * The Codex home a profile's runs use — the same resolution `CodexAdapter`
 * applies: an explicit `codex.codexHome`, else the inherited `$CODEX_HOME`
 * / `~/.codex`. A profile-local home (inheritance explicitly disabled) needs
 * the profile state dir; without it the account is simply unknown.
 */
export function effectiveCodexHome(
  codex: Pick<CodexConfig, 'codexHome' | 'inheritCodexHome'> | undefined,
  profileStateDir?: string,
): string | undefined {
  if (codex?.codexHome) return codex.codexHome;
  if (codex?.inheritCodexHome === false) {
    return profileStateDir ? join(profileStateDir, 'codex-home') : undefined;
  }
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/**
 * Login username from Codex's `auth.json` — only for a ChatGPT login, read
 * from the `email` claim of the stored id token (the CLI prints no account
 * name: `codex login status` says only "Logged in using ChatGPT"). Mirrors
 * the Claude byline: the username (`name` of `name@domain`), because
 * Feishu's message audit rejects raw email addresses. The token is decoded,
 * never verified or logged — it only labels the card.
 */
export function parseCodexAuth(raw: string): string | undefined {
  try {
    const auth = JSON.parse(raw) as { auth_mode?: unknown; tokens?: { id_token?: unknown } };
    if (auth.auth_mode !== undefined && auth.auth_mode !== 'chatgpt') return undefined;
    const idToken = auth.tokens?.id_token;
    if (typeof idToken !== 'string') return undefined;
    const payload = idToken.split('.')[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown };
    if (typeof claims.email !== 'string') return undefined;
    const username = claims.email.trim().split('@')[0]?.trim();
    return username ? username : undefined;
  } catch {
    return undefined;
  }
}

export interface CodexAccountResolverOptions {
  /** Returns `<codexHome>/auth.json`. Injected in tests. */
  readAuth?: (codexHome: string) => Promise<string>;
  /** How long one lookup per home is reused, so a burst of runs reads the file once. */
  ttlMs?: number;
  now?: () => number;
}

export function createCodexAccountResolver(
  opts: CodexAccountResolverOptions = {},
): (codexHome: string | undefined) => Promise<string | undefined> {
  const readAuth = opts.readAuth ?? ((home: string) => readFile(join(home, 'auth.json'), 'utf8'));
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Promise<string | undefined> }>();
  return (codexHome) => {
    if (!codexHome) return Promise.resolve(undefined);
    const hit = cache.get(codexHome);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = readAuth(codexHome).then(parseCodexAuth, () => undefined);
    cache.set(codexHome, { at: now(), value });
    return value;
  };
}

/** The ChatGPT account the Codex CLI is logged in as, for the reply card's `Sponsor:` line. */
export const codexAccountName = createCodexAccountResolver();
