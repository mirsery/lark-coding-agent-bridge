import { spawnProcess } from '../../platform/spawn';

/**
 * The Claude account the CLI is logged in as right now, for the reply card's
 * `Sponsor:` line. Asked of the CLI itself (`claude auth status`) rather than
 * parsed from its config file, so it follows `/login` account switches,
 * CLAUDE_CONFIG_DIR and API-key / third-party providers exactly as the agent
 * run does. Resolves to the login email's username (`name` of `name@domain`):
 * Feishu's message audit rejects raw email addresses (see mask-email.ts), and
 * the username is what identifies the account. Undefined when the CLI is not
 * logged in via claude.ai or cannot be asked.
 */
export const claudeAccountName = createClaudeAccountResolver();

export interface ClaudeAccountResolverOptions {
  /** Returns `claude auth status` stdout. Injected in tests. */
  readStatus?: () => Promise<string>;
  /** How long one lookup is reused, so a burst of runs spawns the CLI once. */
  ttlMs?: number;
  now?: () => number;
}

export function createClaudeAccountResolver(
  opts: ClaudeAccountResolverOptions = {},
): () => Promise<string | undefined> {
  const readStatus = opts.readStatus ?? readAuthStatus;
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let cached: { at: number; value: Promise<string | undefined> } | undefined;
  return () => {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    const value = readStatus().then(parseAuthStatus, () => undefined);
    cached = { at: now(), value };
    return value;
  };
}

/** Login username from `claude auth status` JSON — only for claude.ai logins. */
export function parseAuthStatus(stdout: string): string | undefined {
  try {
    const status = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown; email?: unknown };
    if (status.loggedIn !== true || status.authMethod !== 'claude.ai') return undefined;
    if (typeof status.email !== 'string') return undefined;
    const username = status.email.trim().split('@')[0]?.trim();
    return username ? username : undefined;
  } catch {
    return undefined;
  }
}

function readAuthStatus(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('claude', ['auth', 'status'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude auth status timed out'));
    }, 5_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}
