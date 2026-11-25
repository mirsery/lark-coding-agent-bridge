import { describe, expect, it } from 'vitest';
import { agentCapability } from '../../../src/agent/capability';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { canUseDm, canUseGroup } from '../../../src/policy/access';
import { evaluateRunPolicy, type RunPolicyInput, type ScopeContext } from '../../../src/policy/run-policy';

const profile = createDefaultProfileConfig({
  agentKind: 'agy',
  accounts: { app: { id: 'test', secret: 'test', tenant: 'feishu' } },
  mode: 'team',
  access: { admins: ['admin'], allowedUsers: ['guest'], allowedChats: ['group'] },
});
const controls = { botOwnerId: 'owner', ownerRefreshState: 'ok' as const };

function policy(scope: ScopeContext, overrides: Partial<RunPolicyInput> = {}) {
  return evaluateRunPolicy({
    scope, attachments: [], prompt: 'hello', requestedCwd: '/tmp', cwdRealpath: '/tmp',
    access: { ok: true, reason: 'owner' },
    capability: agentCapability(profile), profileConfig: profile, now: 0,
    ...overrides,
  });
}

describe('Antigravity access', () => {
  it('limits chat access to the bot owner in private, including team-mode profiles', () => {
    expect(canUseDm(profile, controls, 'owner').ok).toBe(true);
    expect(canUseDm(profile, controls, 'admin').ok).toBe(false);
    expect(canUseDm(profile, controls, 'guest').ok).toBe(false);
    expect(canUseGroup(profile, controls, 'group', 'owner').ok).toBe(false);
  });

  it('rejects background, comment and group runs regardless of upstream routing', () => {
    const actorId = 'owner';
    for (const source of ['comment', 'meeting', 'cron', 'dream', 'card'] as const) {
      expect(policy({ source, actorId }).ok).toBe(false);
    }
    expect(policy({ source: 'im', chatType: 'group', actorId }).ok).toBe(false);
    expect(policy({ source: 'im', chatType: 'p2p', actorId }).ok).toBe(true);
    expect(policy({ source: 'im', chatType: 'p2p', actorId: 'guest' }, {
      access: { ok: true, reason: 'allowed-user' },
    }).ok).toBe(false);
  });

  it('rejects a bridge access ceiling the adapter cannot enforce', () => {
    expect(policy({ source: 'im', chatType: 'p2p', actorId: 'owner' }, {
      profileConfig: { ...profile, permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' } },
    }).ok).toBe(false);
  });
});
