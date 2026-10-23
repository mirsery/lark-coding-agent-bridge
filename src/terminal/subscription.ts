import type { ProfileConfig } from '../config/profile-schema';
import { readAgentSubscription, type AgentSubscription } from '../agent/subscription';

export interface MonitorSubscription extends AgentSubscription { loading: boolean }

/** Slow CLI probes run in the background and are shared by all cards for a profile. */
export function createSubscriptionReader(fetch = readAgentSubscription, ttlMs = 60_000) {
  const cache = new Map<string, { key: string; at: number; value: AgentSubscription; pending?: Promise<void> }>();
  return async (profile: string, config: ProfileConfig, profileDir: string, now: number, wait = false): Promise<MonitorSubscription> => {
    const key = JSON.stringify([config.agentKind, config.codex, profileDir]);
    let hit = cache.get(profile);
    if (!hit || hit.key !== key) {
      hit = { key, at: -Infinity, value: {} };
      cache.set(profile, hit);
    }
    if (!hit.pending && now - hit.at >= ttlMs) {
      const entry = hit;
      entry.at = now;
      entry.pending = fetch(config, profileDir).then(value => { entry.value = value; }, () => { entry.value = {}; })
        .finally(() => { entry.pending = undefined; });
    }
    if (wait) await hit.pending;
    return { ...hit.value, loading: Boolean(hit.pending) };
  };
}
