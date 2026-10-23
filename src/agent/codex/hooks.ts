import { dirname, join } from 'node:path';
import { log } from '../../core/logger';
import { bridgeRoot, guardHookEnv, type RunGuard } from '../../policy/owner-guard';

/**
 * Codex tools the hook sees: the shell (`Bash`, as Codex names it for hooks),
 * file edits and image reads. MCP and sub-agent calls pass as with Claude.
 */
export const CODEX_HOOK_MATCHER = '^(Bash|apply_patch|view_image)$';
/** Long enough for the skill Read hook's first window, which clones the library. */
const CODEX_HOOK_TIMEOUT_SEC = 120;

/** The PreToolUse hook a Codex run gets: its `-c` overrides, environment and command. */
export interface CodexHookSetup {
  command: string;
  config: string[];
  env: Record<string, string>;
}

/**
 * The bridge's PreToolUse hook for a Codex run — the guest guard, the skill
 * Read hook, or both — or undefined when the run needs neither. Both go
 * through one command (`bin/codex-hook.mjs`, told what to do by the
 * environment): Codex only runs a hook whose hash it trusts, and one command
 * with one matcher is trusted once for every run.
 */
export function codexHookSetup(opts: {
  guard?: RunGuard;
  readHook?: string;
  /** Where the guard logs what it refuses, for the card (app-server runs). */
  refusalLog?: string;
  nodeBinary?: string;
  root?: string;
}): CodexHookSetup | undefined {
  if (!opts.guard && !opts.readHook) return undefined;
  const bin = opts.root ? join(opts.root, 'bin') : opts.guard ? dirname(opts.guard.hookScript) : join(bridgeRoot(), 'bin');
  const command = `"${opts.nodeBinary ?? process.execPath}" "${join(bin, 'codex-hook.mjs')}"`;
  const handler = `{type="command",command=${toml(command)},timeout=${CODEX_HOOK_TIMEOUT_SEC}}`;
  return {
    command,
    config: [
      '-c',
      `hooks.PreToolUse=[{matcher=${toml(CODEX_HOOK_MATCHER)},hooks=[${handler}]}]`,
      // Keystrokes sent to an interactive terminal (`write_stdin`) never
      // reach a hook: guests get no terminal to type into.
      ...(opts.guard ? ['-c', 'features.unified_exec_tty=false'] : []),
    ],
    env: {
      ...(opts.guard ? guardHookEnv(opts.guard) : {}),
      ...(opts.guard && opts.refusalLog ? { LARK_CHANNEL_HOOK_REFUSALS: opts.refusalLog } : {}),
      ...(opts.readHook ? { LARK_CHANNEL_READ_HOOK: opts.readHook } : {}),
    },
  };
}

/** A TOML basic string (JSON's escapes are a subset of TOML's). */
function toml(value: string): string {
  return JSON.stringify(value);
}

/** The bridge's hook could not be trusted: a run that needs it must not start. */
export class CodexHookTrustError extends Error {}

type Request = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface HookEntry {
  key: string;
  source?: string;
  eventName?: string;
  handlerType?: string;
  command?: string;
  currentHash?: string;
  trustStatus?: string;
}

/**
 * Make sure the app-server will run the bridge's hook. A hook given with `-c`
 * runs only once its hash is trusted (`hooks.state."<key>".trusted_hash` in
 * CODEX_HOME's config.toml), and the app-server has no switch to skip that —
 * exec's `--dangerously-bypass-hook-trust` is not honoured there. So trust it
 * the way Codex's own review does, then check that it took. Throws
 * CodexHookTrustError otherwise.
 */
export async function ensureCodexHookTrusted(request: Request, cwd: string, command: string): Promise<void> {
  const find = async (): Promise<HookEntry | undefined> => {
    const listed = await request('hooks/list', { cwds: [cwd] });
    const entries = Array.isArray(listed.data) ? (listed.data as { hooks?: unknown }[]) : [];
    return entries
      .flatMap((entry) => (Array.isArray(entry?.hooks) ? (entry.hooks as HookEntry[]) : []))
      .find(
        (hook) =>
          hook?.source === 'sessionFlags' &&
          hook.eventName === 'preToolUse' &&
          hook.handlerType === 'command' &&
          hook.command === command,
      );
  };
  const hook = await find();
  if (!hook || typeof hook.key !== 'string' || typeof hook.currentHash !== 'string') {
    throw new CodexHookTrustError('codex did not load the bridge hook');
  }
  if (hook.trustStatus === 'trusted') return;
  await request('config/value/write', {
    keyPath: 'hooks.state',
    value: { [hook.key]: { trusted_hash: hook.currentHash } },
    mergeStrategy: 'upsert',
  });
  const after = await find();
  if (after?.trustStatus !== 'trusted') {
    throw new CodexHookTrustError(`the bridge hook is still ${after?.trustStatus ?? 'missing'} after trusting it`);
  }
  log.info('codex-app-server', 'hook-trusted', { key: hook.key, was: hook.trustStatus ?? null });
}
