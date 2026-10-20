/**
 * Long tasks keep a ledger: a file with the plan, what is done and what comes
 * next (see the system prompt). The agent names it in its reply with one line
 * such as `📒 任务台账：~/.lark-channel/tasks/x.md`. Knowing it lets the bridge
 * pick the task up again after the run dies halfway, instead of leaving the
 * work stranded.
 */

import { homedir } from 'node:os';

const LEDGER_RE = /(?:📒\s*)?(?:任务台账|[Tt]ask ledger)\s*[:：]\s*`?((?:~|\/)[^\s`，。）)]+)`?/;

/**
 * The ledger path a reply announces, if any. A path under the home directory
 * comes back as `~/…`: it is shown in chat, where the host's home path stays hidden.
 */
export function findLedger(text: string, home: string = homedir()): string | undefined {
  const path = LEDGER_RE.exec(text)?.[1];
  if (!path || !home || home === '/') return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * The run's process was killed from outside (SIGTERM / SIGKILL: exit 143 /
 * 137) rather than failing on its own — worth resuming, unlike a real error.
 */
export function isKilledExit(message: string | undefined): boolean {
  if (!message) return false;
  return /exited with code (?:137|143)\b|\bSIG(?:KILL|TERM)\b/.test(message);
}

/** Resumes after an interruption before giving up on a task. */
export const MAX_INTERRUPT_RESUMES = 3;
/** Pause before resuming an interrupted task, so a crash loop can't spin. */
export const INTERRUPT_RESUME_DELAY_MS = 30_000;
