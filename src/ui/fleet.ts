import { resolveAppPaths } from '../config/app-paths';
import {
  loadRootConfig,
  saveRootConfig,
  withConfigFileLock,
  writeActiveProfile,
} from '../config/profile-store';
import { listAllProfiles } from '../runtime/profile-discovery';
import { isAlive, readAndPrune } from '../runtime/registry';
import type { AgentKind } from '../config/profile-schema';
import { HttpError } from './http';
import type { UiSupervisor } from './types';

export interface ProfileSummary {
  name: string;
  agentKind: AgentKind;
  active: boolean;
  /** Whether any live process — this console or another (e.g. a per-profile
   * `start` daemon) — currently hosts this profile's channel. */
  running: boolean;
  /** Whether THIS console process hosts it. Only then can start/stop/restart
   * here act on it; when `running` is true and this is false, a separate
   * process owns the profile and the console can only observe it. */
  hostedHere: boolean;
}

export interface BotSummary {
  id: string;
  profileName: string;
  agentKind: AgentKind;
  botName?: string;
  appId?: string;
  pid: number;
  version: string;
  startedAt?: string;
  uptimeMs: number;
}

/** Online channels the supervisor currently hosts (all under one pid). */
export function listBots(supervisor: UiSupervisor, version: string, now: number): BotSummary[] {
  return supervisor.list().map((s) => ({
    id: s.profile,
    profileName: s.profile,
    agentKind: s.agentKind,
    botName: s.botName,
    appId: s.appId,
    pid: s.pid,
    version,
    startedAt: s.startedAt,
    uptimeMs: s.startedAt ? Math.max(0, now - Date.parse(s.startedAt)) : 0,
  }));
}

/**
 * All profiles with agent kind, active flag, and running state. `running`
 * also checks the cross-process registry so a profile kept alive by a
 * separate per-profile daemon (started outside this console) doesn't read as
 * "not running" just because this console isn't the one hosting it.
 */
export async function listProfiles(
  supervisor: UiSupervisor,
  rootDir?: string,
): Promise<ProfileSummary[]> {
  const profiles = await listAllProfiles(rootDir).catch(() => []);
  const registryFile = resolveAppPaths({ rootDir }).userRegistryFile;
  const liveElsewhere = new Set(
    readAndPrune(registryFile)
      .filter((e) => isAlive(e.pid))
      .map((e) => e.profileName),
  );
  return profiles.map((p) => {
    const hostedHere = supervisor.isOnline(p.name);
    return {
      name: p.name,
      agentKind: p.agentKind,
      active: p.active,
      running: hostedHere || liveElsewhere.has(p.name),
      hostedHere,
    };
  });
}

/** Switch the active profile (disk metadata only; does not stop/start channels). */
export async function activateProfile(
  name: string,
  rootDir?: string,
): Promise<{ ok: true; active: string }> {
  const appPaths = resolveAppPaths({ rootDir });
  await withConfigFileLock(appPaths.configFile, async () => {
    const root = await loadRootConfig(appPaths.configFile);
    if (!root?.profiles[name]) throw new HttpError(404, `profile not found: ${name}`);
    root.activeProfile = name;
    await saveRootConfig(root, appPaths.configFile);
  });
  await writeActiveProfile(appPaths.rootDir, name);
  return { ok: true, active: name };
}
