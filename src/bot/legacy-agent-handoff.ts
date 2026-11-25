import { join } from 'node:path';
import { agentCapability } from '../agent/capability';
import { agentDescriptor } from '../agent/registry';
import { probeAgentSession } from '../agent/session-probe';
import { agentSessionsFile } from '../config/app-paths';
import type { ProfileConfig } from '../config/profile-schema';
import { evaluateRunPolicy, type RunPolicyAllow, type ScopeContext } from '../policy/run-policy';
import { agentHandoffSection, handoffExcerpt } from '../session/agent-handoff';
import { SessionCatalog } from '../session/catalog';
import { stripEffortMarker } from '../session/effort-marker';
import { stripNewSessionMarker } from '../session/smart-session';
import { findLedger } from './task-ledger';

/** Recover a pre-upgrade turn only where its native transcript proves the
 * same owner DM. The old catalog alone does not identify its participants. */
export async function legacyAgentHandoff(input: {
  profileDir: string;
  profile: ProfileConfig;
  scopeId: string;
  scope: ScopeContext;
  policy: RunPolicyAllow;
}): Promise<string | undefined> {
  const { profileDir, profile, scopeId, scope, policy } = input;
  const failover = profile.agentFailover;
  const source = failover?.standby;
  if (!source || !failover.preferences[source] || policy.access.reason !== 'owner' || scope.chatType !== 'p2p') {
    return undefined;
  }
  const sourceProfile = { ...profile, agentKind: source };
  const sessions = agentSessionsFile(join(profileDir, 'sessions.json'), source, failover.original);
  const catalog = new SessionCatalog(`${sessions}.catalog.json`);
  await catalog.load();
  const identity = { scopeId, agentId: source, cwdRealpath: policy.cwdRealpath };
  let entry = catalog.activeFor({ ...identity, policyFingerprint: policy.policyFingerprint });
  if (!entry && profile.codex) {
    // Selecting Codex for the first time adds CLI settings that the outgoing
    // session's fingerprint did not contain.
    const previousPolicy = evaluateRunPolicy({
      scope,
      attachments: [],
      prompt: '',
      requestedCwd: policy.requestedCwd,
      cwdRealpath: policy.cwdRealpath,
      access: policy.access,
      capability: agentCapability(sourceProfile),
      profileConfig: sourceProfile,
      now: Date.now(),
    });
    if (previousPolicy.ok) entry = catalog.activeFor({ ...identity, policyFingerprint: previousPolicy.policyFingerprint });
  }
  const handle = entry?.[agentDescriptor(source).sessionHandle];
  if (!handle || !entry || Date.now() - entry.updatedAt >= 30 * 86_400_000) return undefined;
  const probe = await probeAgentSession(sourceProfile, handle, policy.cwdRealpath);
  const ownerDm = probe?.ownerDm;
  if (!ownerDm || ownerDm.chatId !== scope.chatId || ownerDm.senderId !== scope.actorId ||
      ownerDm.threadId !== scope.threadId) return undefined;
  const answer = ownerDm.answer && stripNewSessionMarker(stripEffortMarker(ownerDm.answer)).trim();
  return agentHandoffSection([{
    agent: source,
    request: handoffExcerpt(probe?.lastUserText, 1600),
    answer: answer === '[[NO_REPLY]]' ? undefined : handoffExcerpt(answer, 2400),
    ledger: answer ? findLedger(answer) : undefined,
    status: 'unknown',
  }]);
}
