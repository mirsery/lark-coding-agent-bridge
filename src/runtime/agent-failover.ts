import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_KINDS, agentDescriptor, isAgentKind } from '../agent/registry';
import { agentCapability } from '../agent/capability';
import { resolveModelArg } from '../agent/models';
import type { AgentAdapter } from '../agent/types';
import { agentSessionsFile, type AppPaths } from '../config/app-paths';
import { normalizeProfileConfig, type AgentKind, type ProfileConfig } from '../config/profile-schema';
import { loadRootConfig, saveRootConfig, withConfigFileLock } from '../config/profile-store';
import { evaluateRunPolicy } from '../policy/run-policy';
import { checkRuntimeAgentAvailability } from './agent-runtime';

export type AgentSwitchPhase = 'checking' | 'waiting' | 'interrupting' | 'connecting';

export interface AgentSwitchRequest {
  expected: AgentKind;
  target: AgentKind;
  interrupt: boolean;
}

export function parseAgentSwitch(body: unknown): AgentSwitchRequest {
  const input = body as Partial<AgentSwitchRequest> | null;
  if (!input || !isAgentKind(input.expected) || !isAgentKind(input.target) ||
    typeof input.interrupt !== 'boolean' || input.expected === input.target) {
    throw new Error('切换请求无效，请刷新当前 agent 后重试');
  }
  return { expected: input.expected, target: input.target, interrupt: input.interrupt };
}

export function agentFailoverView(profile: ProfileConfig) {
  return {
    current: profile.agentKind,
    standby: profile.agentFailover?.standby ?? null,
    agents: AGENT_KINDS.map((kind) => {
      const agent = agentDescriptor(kind);
      return { kind, name: agent.displayName, ownerDmOnly: agent.ownerDmOnly === true };
    }),
  };
}

export function switchProfileAgent(profile: ProfileConfig, request: AgentSwitchRequest): ProfileConfig {
  if (profile.agentKind !== request.expected || profile.agentFailover?.standby !== request.target) {
    throw new Error('当前或备用 agent 已变更，请刷新后重试');
  }
  const { model, effort, chatEffort, ...shared } = profile.preferences;
  const next = agentDescriptor(request.target);
  const candidate = normalizeProfileConfig({
    ...profile,
    agentKind: request.target,
    agentFailover: {
      ...profile.agentFailover,
      standby: request.expected,
      preferences: {
        ...profile.agentFailover.preferences,
        [request.expected]: { model, effort, chatEffort },
      },
    },
    preferences: { ...shared, ...profile.agentFailover.preferences[request.target] },
    ...(agentDescriptor(request.target).kind === 'codex' && !profile.codex
      ? { codex: { binaryPath: process.env[next.commandEnv] ?? next.command } }
      : {}),
  });
  // Check the owner's minimum run capability without changing the profile's
  // permissions or touching any workspace. In particular, owner-only ACP
  // cannot satisfy a profile capped at workspace or read-only access.
  const policy = evaluateRunPolicy({
    scope: { source: 'im', chatType: 'p2p', actorId: 'owner' },
    access: { ok: true, reason: 'owner' },
    profileConfig: candidate,
    capability: agentCapability(candidate),
    prompt: '',
    attachments: [],
    requestedCwd: '',
    cwdRealpath: '',
    now: Date.now(),
  });
  if (!policy.ok) throw new Error(policy.rejectReason.userVisible);
  return candidate;
}

export async function readFailoverProfile(configPath: string, profile: string): Promise<ProfileConfig> {
  const config = (await loadRootConfig(configPath))?.profiles[profile];
  if (!config) throw new Error(`profile 不存在：${profile}`);
  return config;
}

/** Update only this profile. Other profiles may be reconfigured during a switch. */
export async function writeFailoverProfile(
  configPath: string,
  profile: string,
  update: (current: ProfileConfig) => ProfileConfig,
): Promise<ProfileConfig> {
  return withConfigFileLock(configPath, async () => {
    const root = await loadRootConfig(configPath);
    const current = root?.profiles[profile];
    if (!root || !current) throw new Error(`profile 不存在：${profile}`);
    const next = update(current);
    root.profiles[profile] = next;
    await saveRootConfig(root, configPath);
    return next;
  });
}

export function withAgentSwitchLock<T>(paths: AppPaths, fn: () => Promise<T>): Promise<T> {
  return withConfigFileLock(join(paths.profileDir, 'agent-switch'), fn);
}

/** Keep native conversation pointers and background resumes with their agent.
 * The original agent continues to use the pre-existing files. */
export function agentConversationPaths(paths: AppPaths, profile: ProfileConfig): AppPaths {
  const origin = profile.agentFailover?.original ?? profile.agentKind;
  if (origin === profile.agentKind) return paths;
  const suffix = `.${profile.agentKind}.json`;
  return {
    ...paths,
    sessionsFile: agentSessionsFile(paths.sessionsFile, profile.agentKind, origin),
    rotationsFile: paths.rotationsFile.replace(/\.json$/, suffix),
    autoResumeFile: paths.autoResumeFile.replace(/\.json$/, suffix),
  };
}

export async function probeSwitchTarget(agent: AgentAdapter, profile: ProfileConfig): Promise<void> {
  const availability = await checkRuntimeAgentAvailability(agent);
  if (!availability.ok) throw availability.error;
  const cwd = await mkdtemp(join(tmpdir(), 'lcb-agent-probe-'));
  try {
    const descriptor = agentDescriptor(profile.agentKind);
    const run = agent.run({
      runId: randomUUID(),
      cwd,
      prompt: 'Connectivity check. Reply exactly OK. Do not use tools or inspect files.',
      model: resolveModelArg(profile.agentKind, profile.preferences.model),
      stopGraceMs: 100,
      // Owner-only ACP rejects sandbox flags and already denies interactive
      // tool permissions. This probe gives it only a temporary empty cwd.
      ...(!descriptor.ownerDmOnly ? {
        sandbox: 'read-only',
        permissionMode: 'plan',
        approvals: { decide: async () => ({ decision: 'deny', reason: 'agent connectivity check' }) },
      } : {}),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([
        (async () => {
          let response = '';
          for await (const event of run.events) {
            if (event.type === 'text') response += event.delta;
            if (event.type === 'final_text') response = event.content;
            if (event.type === 'error' || event.type === 'tool_use' ||
                (event.type === 'rate_limit' && event.blocked)) return false;
            if (event.type === 'done') return event.terminationReason === 'normal' && response.trim() === 'OK';
          }
          return false;
        })(),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 25_000); }),
      ]);
      if (!completed) throw new Error(`${agent.displayName} 未通过应答探测，请检查登录、额度和模型配置`);
    } finally {
      if (timer) clearTimeout(timer);
      await run.stop();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
