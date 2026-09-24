import type { ProfileConfig } from '../config/profile-schema';
import { claudeAccountName } from './claude/account';
import { codexAccountName, effectiveCodexHome } from './codex/account';

/**
 * The account paying for a profile's runs, for the reply card's `Sponsor:`
 * line — the Claude CLI's claude.ai login, or the Codex CLI's ChatGPT login.
 * Undefined when the agent is on an API key or the account can't be read.
 * Shared bot / scheduler code goes through here so it never imports an
 * agent's internals directly.
 */
export function agentAccountName(
  profileConfig: Pick<ProfileConfig, 'agentKind' | 'codex'>,
): Promise<string | undefined> {
  if (profileConfig.agentKind === 'claude') return claudeAccountName();
  if (profileConfig.agentKind === 'codex') return codexAccountName(effectiveCodexHome(profileConfig.codex));
  return Promise.resolve(undefined);
}
