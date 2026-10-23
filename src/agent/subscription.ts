import type { ProfileConfig } from '../config/profile-schema';
import type { AgentKind } from './registry';
import type { QuotaReading } from './quota';
import { claudeAccountName } from './claude/account';
import { ClaudeAccountPool, claudeAccountsPaths } from './claude/accounts';
import { readClaudeAccountQuota } from './claude/quota';
import { codexAccountName, effectiveCodexHome } from './codex/account';
import { readCodexQuota } from './codex/quota';

export interface AgentSubscription { sponsor?: string; quota?: QuotaReading }
type Reader = (config: ProfileConfig, profileDir: string) => Promise<AgentSubscription>;
const READERS: Record<AgentKind, Reader> = {
  claude: async (_config, profileDir) => {
    // Pick exactly the account new runs use, never the emptiest account in the pool.
    const pool = new ClaudeAccountPool({ paths: claudeAccountsPaths(profileDir) });
    await pool.refresh();
    const account = pool.pick();
    const sponsor = account?.label ?? (account?.id === 'default' ? await claudeAccountName() : account?.id);
    const quota = account ? await readClaudeAccountQuota({ cwd: profileDir, timeoutMs: 8000 }, account.env)
      ?? pool.quotaReading(account.id) : undefined;
    return { sponsor, quota };
  },
  codex: async (config, profileDir) => {
    const home = effectiveCodexHome(config.codex, profileDir);
    const [sponsor, quota] = await Promise.all([
      codexAccountName(home),
      readCodexQuota(config.codex ? { ...config.codex, codexHome: home } : undefined, { cwd: profileDir, profileDir, timeoutMs: 8000 }),
    ]);
    return { sponsor, quota };
  },
};

/** Read-only account display; no model turn or account switch. */
export async function readAgentSubscription(config: ProfileConfig, profileDir: string): Promise<AgentSubscription> {
  return READERS[config.agentKind]?.(config, profileDir) ?? {};
}
