import { beforeEach, expect, it, vi } from 'vitest';
import type { ProfileConfig } from '../../../src/config/profile-schema';
const mocks = vi.hoisted(() => ({
  refresh: vi.fn(), pick: vi.fn(), fallback: vi.fn(), claudeQuota: vi.fn(), claudeName: vi.fn(),
  codexQuota: vi.fn(), codexName: vi.fn(), home: vi.fn(),
}));
vi.mock('../../../src/agent/claude/accounts', () => ({
  claudeAccountsPaths: (dir: string) => ({ configFile: dir }),
  ClaudeAccountPool: class { refresh = mocks.refresh; pick = mocks.pick; quotaReading = mocks.fallback; },
}));
vi.mock('../../../src/agent/claude/quota', () => ({ readClaudeAccountQuota: mocks.claudeQuota }));
vi.mock('../../../src/agent/claude/account', () => ({ claudeAccountName: mocks.claudeName }));
vi.mock('../../../src/agent/codex/quota', () => ({ readCodexQuota: mocks.codexQuota }));
vi.mock('../../../src/agent/codex/account', () => ({ codexAccountName: mocks.codexName, effectiveCodexHome: mocks.home }));
import { readAgentSubscription } from '../../../src/agent/subscription';
beforeEach(() => { vi.resetAllMocks(); });
it('uses the selected Claude account for both sponsor and quota, with telemetry fallback', async () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: 'test-only' };
  mocks.pick.mockReturnValue({ id: 'backup', label: 'Bob', env });
  mocks.claudeQuota.mockResolvedValue(undefined);
  const quota = { windows: [{ label: '本周', usedPercent: 68 }] };
  mocks.fallback.mockReturnValue(quota);
  expect(await readAgentSubscription({ agentKind: 'claude' } as ProfileConfig, '/state')).toEqual({ sponsor: 'Bob', quota });
  expect(mocks.claudeQuota).toHaveBeenCalledWith({ cwd: '/state', timeoutMs: 8000 }, env);
  expect(mocks.fallback).toHaveBeenCalledWith('backup');
  expect(mocks.claudeName).not.toHaveBeenCalled();
});
it('resolves the profile-local Codex home for both account and quota', async () => {
  const config = { agentKind: 'codex', codex: { binaryPath: 'codex', inheritCodexHome: false } } as ProfileConfig;
  mocks.home.mockReturnValue('/state/codex-home');
  mocks.codexName.mockResolvedValue('Alice');
  mocks.codexQuota.mockResolvedValue({ windows: [] });
  expect(await readAgentSubscription(config, '/state')).toMatchObject({ sponsor: 'Alice' });
  expect(mocks.home).toHaveBeenCalledWith(config.codex, '/state');
  expect(mocks.codexName).toHaveBeenCalledWith('/state/codex-home');
  expect(mocks.codexQuota).toHaveBeenCalledWith({ ...config.codex, codexHome: '/state/codex-home' }, { cwd: '/state', profileDir: '/state', timeoutMs: 8000 });
});
