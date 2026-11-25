import pkg from '../../package.json';
import { startChannel as realStartChannel, type BridgeChannel } from '../bot/channel';
import type { Controls } from '../commands';
import { resolveAppPaths, type AppPaths } from '../config/app-paths';
import { isComplete, type AppConfig } from '../config/schema';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import type { AgentAdapter } from '../agent/types';
import { log } from '../core/logger';
import { refreshOwnerControls } from '../policy/owner';
import { SessionStore } from '../session/store';
import { SessionCatalog } from '../session/catalog';
import { WorkspaceStore } from '../workspace/store';
import { preFlightChecks } from '../cli/preflight';
import { getServiceAdapter, type ServiceAdapter } from '../daemon/service-adapter';
import { SUPERVISOR_SERVICE_ID } from '../daemon/paths';
import {
  agentConversationPaths,
  probeSwitchTarget,
  readFailoverProfile,
  switchProfileAgent,
  withAgentSwitchLock,
  writeFailoverProfile,
  type AgentSwitchPhase,
  type AgentSwitchRequest,
} from './agent-failover';
import { listenForAgentSwitch, requestAgentSwitch } from './agent-switch-socket';
import {
  assertReconnectAgentKindUnchanged,
  checkRuntimeAgentAvailability,
  createRuntimeAgent,
  releaseRuntimeLocks,
} from './agent-runtime';
import {
  acquireAppRuntimeLock,
  acquireProfileRuntimeLock,
  checkRuntimeLock,
  type AcquiredRuntimeLock,
} from './locks';
import { resolveProfileRuntime } from './profile-runtime';
import {
  isAlive,
  readAndPrune,
  register,
  unregister,
  unregisterSync,
  updateEntry,
  type ProcessEntry,
} from './registry';

type StartChannelFn = typeof realStartChannel;

export interface SupervisorOptions {
  /** Root config path (config.json). */
  configPath: string;
  /** LARK_CHANNEL_HOME root; undefined = default. */
  rootDir?: string;
  /** Injectable for tests (defaults to the real startChannel). */
  startChannelFn?: StartChannelFn;
  /** Run lark-cli preflight per profile (default true; tests pass false). */
  runPreflight?: boolean;
  /** Override system service lookup for tests without touching host daemons. */
  serviceAdapter?: (profile: string) => Pick<ServiceAdapter,
    'fileExists' | 'isRunning' | 'stop' | 'start' | 'waitUntilStopped'> | null;

}

export interface ManagedStatus {
  profile: string;
  agentKind: AgentKind;
  online: boolean;
  pid: number;
  startedAt?: string;
  botName?: string;
  appId?: string;
}

/**
 * One profile's live bridge inside the supervisor. Owns its locks, registry
 * entry, stores, channel and `controls`. `stop()` tears down ONLY this profile
 * (no process.exit) so the supervisor keeps hosting the others.
 */
class ManagedProfile {
  bridge!: BridgeChannel;
  controls!: Controls;
  locks: AcquiredRuntimeLock[] = [];
  entry!: ProcessEntry;
  startedAt = '';
  private restarting = false;
  private switchSocket?: Awaited<ReturnType<typeof listenForAgentSwitch>>;
  private connected = false;

  constructor(
    readonly profile: string,
    private appPaths: AppPaths,
    private configPath: string,
    private cfg: AppConfig,
    private profileConfig: ProfileConfig,
    private agent: AgentAdapter,
    private sessions: SessionStore,
    private sessionCatalog: SessionCatalog,
    private workspaces: WorkspaceStore,
    private startChannelFn: StartChannelFn,
    private onExitCommand: (profile: string) => void,
    private onSwitchAgent: NonNullable<Controls['switchAgent']>,
    private onConfigureStandby: (kind: AgentKind | null) => Promise<void>,
  ) {}

  get appId(): string {
    return this.cfg.accounts.app.id;
  }

  get online(): boolean {
    return this.connected;
  }

  get botName(): string | undefined {
    return this.bridge?.channel.botIdentity?.name;
  }

  async bringUp(nowIso: string): Promise<void> {
    this.startedAt = nowIso;
    // Acquire sequentially, pushing as we go: if the app lock throws (e.g. the
    // same app is running elsewhere) the already-held profile lock is still in
    // this.locks and gets released by the catch — otherwise it would leak and
    // a retry in the same process would fail to re-lock.
    this.locks = [];
    try {
      this.locks.push(await acquireProfileRuntimeLock(this.appPaths, this.profileConfig.agentKind));
      this.locks.push(
        await acquireAppRuntimeLock(this.appPaths, this.appId, this.profileConfig.agentKind),
      );
      this.entry = await register({
        appId: this.appId,
        tenant: this.cfg.accounts.app.tenant,
        profileName: this.appPaths.profile,
        agentKind: this.profileConfig.agentKind,
        configPath: this.configPath,
        version: pkg.version,
        ready: false,
        registryFile: this.appPaths.userRegistryFile,
      });
      this.controls = this.makeControls(this.appPaths, this.cfg, this.profileConfig);
      this.bridge = await this.startChannelFn({
        cfg: this.cfg,
        agent: this.agent,
        sessions: this.sessions,
        sessionCatalog: this.sessionCatalog,
        workspaces: this.workspaces,
        controls: this.controls,
        appPaths: agentConversationPaths(this.appPaths, this.profileConfig),
      });
      this.connected = true;
      const botName = this.bridge.channel.botIdentity?.name;
      this.switchSocket = await listenForAgentSwitch(this.appPaths.profileDir, this.onSwitchAgent).catch((err: unknown) => {
        log.warn('supervisor', 'agent-switch-socket-failed', { profile: this.profile, err: String(err) });
        return undefined;
      });
      await updateEntry(this.entry.id, {
        botName,
        ready: true,
        agentSwitchSocket: this.switchSocket?.path,
      }, this.appPaths.userRegistryFile);
    } catch (err) {
      await this.bridge?.disconnect().catch(() => undefined);
      await this.switchSocket?.close().catch(() => undefined);
      this.connected = false;
      // Roll back partial bring-up so a failed start doesn't leak locks/entries.
      if (this.entry) unregisterSync(this.entry.id, this.appPaths.userRegistryFile);
      await releaseRuntimeLocks(this.locks);
      this.locks = [];
      throw err;
    }
  }

  async stop(): Promise<void> {
    try {
      if (this.connected) await this.bridge.disconnect();
    } catch (err) {
      log.warn('supervisor', 'disconnect-failed', { profile: this.profile, err: String(err) });
    }
    this.connected = false;
    await this.switchSocket?.close().catch(() => undefined);
    if (this.entry) {
      await unregister(this.entry.id, this.appPaths.userRegistryFile).catch(() => undefined);
    }
    await releaseRuntimeLocks(this.locks);
    this.locks = [];
  }

  /** Best-effort sync unregister for the process 'exit' hook. */
  unregisterSelfSync(): void {
    if (this.entry) unregisterSync(this.entry.id, this.appPaths.userRegistryFile);
  }

  status(pid: number): ManagedStatus {
    return {
      profile: this.profile,
      agentKind: this.profileConfig.agentKind,
      online: this.connected,
      pid,
      startedAt: this.startedAt,
      botName: this.botName,
      appId: this.appId,
    };
  }

  private makeControls(
    currentPaths: AppPaths,
    currentCfg: AppConfig,
    currentProfileConfig: ProfileConfig,
  ): Controls {
    const self = this;
    const currentControls: Controls = {
      profile: currentPaths.profile,
      profileConfig: currentProfileConfig,
      ownerRefreshState: 'unknown',
      knownChats: [],
      async refreshOwner(channelOverride) {
        const target = channelOverride ?? self.bridge?.channel;
        if (!target) return;
        await refreshOwnerControls(currentControls, target, currentControls.cfg.accounts.app.id);
      },
      configPath: self.configPath,
      cfg: currentCfg,
      processId: self.entry.id,
      async exit() {
        // `/exit` from chat stops THIS profile's channel; the supervisor lives on.
        self.onExitCommand(self.profile);
      },
      switchAgent: self.onSwitchAgent,
      configureStandby: self.onConfigureStandby,
      async restart() {
        await self.restart();
      },
    };
    return currentControls;
  }

  /** Connect-before-disconnect reconnect for this profile (e.g. after /account). */
  private async restart(): Promise<void> {
    if (this.restarting || !this.connected) return;
    this.restarting = true;
    let nextAppLock: AcquiredRuntimeLock | undefined;
    try {
      const nextRuntime = await resolveProfileRuntime({
        config: this.configPath,
        profile: this.appPaths.profile,
        allowBootstrap: false,
      });
      const next = nextRuntime.cfg;
      if (!isComplete(next)) throw new Error('config incomplete after change');
      assertReconnectAgentKindUnchanged(this.profileConfig.agentKind, nextRuntime.profileConfig.agentKind);
      const nextAgent = createRuntimeAgent(nextRuntime.profileConfig, {
        ...nextRuntime.appPaths,
        configPath: nextRuntime.configPath,
      });
      const availability = await checkRuntimeAgentAvailability(nextAgent);
      if (!availability.ok) throw availability.error;

      const appChanged = next.accounts.app.id !== this.cfg.accounts.app.id;
      if (appChanged) {
        nextAppLock = await acquireAppRuntimeLock(
          nextRuntime.appPaths,
          next.accounts.app.id,
          nextRuntime.profileConfig.agentKind,
        );
      }
      const nextControls = this.makeControls(nextRuntime.appPaths, next, nextRuntime.profileConfig);
      // Same app, same owner: if the new channel's first owner lookup fails
      // (the network trouble behind a keepalive restart), it keeps this id.
      if (!appChanged && this.controls.botOwnerId) nextControls.botOwnerId = this.controls.botOwnerId;
      const nextBridge = await this.startChannelFn({
        cfg: next,
        agent: nextAgent,
        sessions: this.sessions,
        sessionCatalog: this.sessionCatalog,
        workspaces: this.workspaces,
        controls: nextControls,
        appPaths: agentConversationPaths(nextRuntime.appPaths, nextRuntime.profileConfig),
      });
      try {
        await this.bridge.disconnect();
      } catch (err) {
        log.warn('supervisor', 'old-disconnect-failed', { profile: this.profile, err: String(err) });
      }
      this.bridge = nextBridge;
      await updateEntry(
        this.entry.id,
        {
          appId: next.accounts.app.id,
          tenant: next.accounts.app.tenant,
          configPath: this.configPath,
          botName: nextBridge.channel.botIdentity?.name,
        },
        this.appPaths.userRegistryFile,
      ).catch((err) => log.warn('registry', 'update-failed', { err: String(err) }));
      if (nextAppLock) {
        const oldAppLock = this.locks.find((l) => l.kind === 'app');
        this.locks = [...this.locks.filter((l) => l.kind !== 'app'), nextAppLock];
        nextAppLock = undefined;
        await oldAppLock?.release().catch(() => undefined);
      }
      this.cfg = next;
      this.profileConfig = nextRuntime.profileConfig;
      this.agent = nextAgent;
      this.controls = nextControls;
    } finally {
      if (nextAppLock) await nextAppLock.release().catch(() => undefined);
      this.restarting = false;
    }
  }
  async switchAgent(request: AgentSwitchRequest, probe: boolean, onPhase?: (phase: AgentSwitchPhase) => void): Promise<void> {
    if (this.restarting || !this.connected) throw new Error('profile 正在重连，请稍后再试');
    if (this.profileConfig.agentKind !== request.expected) {
      throw new Error('运行中的 agent 已变更，请刷新后重试');
    }
    this.restarting = true;
    let resume: (() => void) | undefined;
    try {
      const current = await readFailoverProfile(this.configPath, this.profile);
      const candidate = switchProfileAgent(current, request);
      const target = createRuntimeAgent(candidate, { ...this.appPaths, configPath: this.configPath });
      if (probe) await probeSwitchTarget(target, candidate);

      onPhase?.(request.interrupt ? 'interrupting' : 'waiting');
      resume = await this.bridge.prepareAgentSwitch?.(request.interrupt);
      // Re-read under the config lock so unrelated saves during the probe
      // survive. Do not change the App identity in the middle of a cutover.
      onPhase?.('connecting');
      let previous = current;
      await writeFailoverProfile(this.configPath, this.profile, (latest) => {
        if (latest.accounts.app.id !== this.appId || latest.accounts.app.tenant !== this.cfg.accounts.app.tenant ||
            latest.accounts.app.secret !== current.accounts.app.secret) {
          throw new Error('飞书应用配置已变更，请先重连');
        }
        previous = latest;
        return switchProfileAgent(latest, request);
      });

      const owner = this.controls.botOwnerId;
      try {
        await this.bridge.disconnect({ agentSwitch: true });
        this.connected = false;
        await this.connectCurrentAgent(owner);
      } catch (err) {
        const restored = await restorePreviousAgent(this.configPath, this.profile, previous, request.target);
        const oldConnectionUncertain = this.connected;
        let recovered = false;
        if (!oldConnectionUncertain && restored) {
          try {
            await this.connectCurrentAgent(owner);
            recovered = true;
          } catch (rollbackError) {
            await updateEntry(this.entry.id, { ready: false }, this.appPaths.userRegistryFile).catch(() => undefined);
            log.warn('supervisor', 'agent-switch-reconnect-failed', { profile: this.profile, err: String(rollbackError) });
          }
        }
        const status = recovered ? '原 bot 已连接' : oldConnectionUncertain ? '旧连接状态待确认' : 'profile 仍离线';
        throw new Error(`切换失败（${errorText(err)}）。${restored ? '已恢复原配置' : '配置已被修改'}，${status}`);
      }
    } finally {
      resume?.();
      this.restarting = false;
    }
  }

  private async connectCurrentAgent(owner: string | undefined): Promise<void> {
    const { cfg, profileConfig, appPaths } = await resolveProfileRuntime({
      config: this.configPath, profile: this.profile, allowBootstrap: false,
    });
    if (!isComplete(cfg) || cfg.accounts.app.id !== this.appId) throw new Error('飞书应用配置已变更');
    const agent = createRuntimeAgent(profileConfig, { ...appPaths, configPath: this.configPath });
    const paths = agentConversationPaths(appPaths, profileConfig);
    const sessions = new SessionStore(paths.sessionsFile);
    const catalog = new SessionCatalog(`${paths.sessionsFile}.catalog.json`);
    await Promise.all([sessions.load(), catalog.load()]);
    const controls = this.makeControls(appPaths, cfg, profileConfig);
    controls.botOwnerId = owner;
    this.bridge = await this.startChannelFn({
      cfg, agent, sessions, sessionCatalog: catalog, workspaces: this.workspaces, controls, appPaths: paths,
    });
    this.connected = true;
    this.cfg = cfg;
    this.profileConfig = profileConfig;
    this.agent = agent;
    this.sessions = sessions;
    this.sessionCatalog = catalog;
    this.controls = controls;
    await updateEntry(this.entry.id, {
      agentKind: profileConfig.agentKind,
      ready: true,
      botName: this.botName,
    }, this.appPaths.userRegistryFile).catch((err) =>
      log.warn('registry', 'update-failed', { step: 'agent-switch', err: String(err) }),
    );
  }

}

/**
 * The single control-plane process: hosts every profile's bridge in one Node
 * process and lets the web console start/stop/restart/configure each in-memory.
 * No `process.exit` here — the CLI entry owns process lifecycle.
 */
export class Supervisor {
  private managed = new Map<string, ManagedProfile>();
  private starting = new Map<string, Promise<void>>();
  private switching = new Map<string, Promise<void>>();

  constructor(private opts: SupervisorOptions) {}

  private get startChannelFn(): StartChannelFn {
    return this.opts.startChannelFn ?? realStartChannel;
  }

  isOnline(profile: string): boolean {
    return this.managed.get(profile)?.online === true;
  }

  controlsFor(profile: string): Controls | undefined {
    return this.isOnline(profile) ? this.managed.get(profile)?.controls : undefined;
  }

  channelFor(profile: string) {
    return this.isOnline(profile) ? this.managed.get(profile)?.bridge.channel : undefined;
  }

  list(): ManagedStatus[] {
    return [...this.managed.values()].filter((m) => m.online).map((m) => m.status(process.pid));
  }

  /** Bring a profile online inside this process. Throws on lock/app conflict. */
  async startProfile(profile: string): Promise<void> {
    if (this.switching.has(profile)) throw new Error('profile 正在切换 agent');
    await this.startProfileOnce(profile);
  }

  private async startProfileOnce(profile: string): Promise<void> {
    const existing = this.starting.get(profile);
    if (existing) return existing;
    if (this.isOnline(profile)) return;
    const started = (async () => {
      const stale = this.managed.get(profile);
      if (stale) {
        this.managed.delete(profile);
        await stale.stop();
      }
      await this.startProfileInternal(profile);
    })();
    this.starting.set(profile, started);
    try {
      await started;
    } finally {
      this.starting.delete(profile);
    }
  }

  private async startProfileInternal(profile: string): Promise<void> {
    const runtime = await resolveProfileRuntime({
      config: this.opts.configPath,
      profile,
      allowBootstrap: false,
    });
    const { cfg, appPaths, profileConfig, configPath } = runtime;
    if (!isComplete(cfg)) throw new Error(`profile 配置不完整：${profile}`);

    // Dedupe by app id — two channels for one app fight over event routing.
    for (const m of this.managed.values()) {
      if (m.appId === cfg.accounts.app.id) {
        throw new Error(`该飞书应用已被 profile「${m.profile}」连接，不能重复上线`);
      }
    }

    if (this.opts.runPreflight !== false) {
      await preFlightChecks({
        bridgeConfig: cfg,
        profileConfig,
        appPaths,
        larkChannel: {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          configPath,
          larkCliConfigDir: appPaths.larkCliConfigDir,
          larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
        },
      });
    }

    const agent = createRuntimeAgent(profileConfig, { ...appPaths, configPath });
    if (this.opts.runPreflight !== false) {
      const availability = await checkRuntimeAgentAvailability(agent);
      if (!availability.ok) throw availability.error;
    }

    const paths = agentConversationPaths(appPaths, profileConfig);
    const sessions = new SessionStore(paths.sessionsFile);
    await sessions.load();
    const sessionCatalog = new SessionCatalog(`${paths.sessionsFile}.catalog.json`);
    await sessionCatalog.load();
    const workspaces = new WorkspaceStore(appPaths.workspacesFile);
    await workspaces.load();

    const managed = new ManagedProfile(
      appPaths.profile,
      appPaths,
      configPath,
      cfg,
      profileConfig,
      agent,
      sessions,
      sessionCatalog,
      workspaces,
      this.startChannelFn,
      (p) => void this.stopProfile(p).catch(() => undefined),
      (request, onPhase) => this.switchAgent(profile, request, onPhase),
      (kind) => this.configureStandby(profile, kind),
    );
    await managed.bringUp(new Date().toISOString());
    this.managed.set(appPaths.profile, managed);
    log.info('supervisor', 'profile-online', { profile: appPaths.profile, appId: cfg.accounts.app.id });
  }

  /** Take a profile offline (in-process). The supervisor keeps running. */
  async stopProfile(profile: string): Promise<void> {
    if (this.switching.has(profile)) throw new Error('profile 正在切换 agent');
    await this.starting.get(profile);
    if (this.switching.has(profile)) throw new Error('profile 正在切换 agent');
    const managed = this.managed.get(profile);
    if (!managed) return;
    this.managed.delete(profile);
    await managed.stop();
    log.info('supervisor', 'profile-offline', { profile });
  }

  async restartProfile(profile: string): Promise<void> {
    const managed = this.managed.get(profile);
    if (!managed) throw new Error(`profile 未在运行：${profile}`);
    await managed.controls.restart();
  }

  async configureStandby(profile: string, standby: AgentKind | null): Promise<void> {
    const paths = resolveAppPaths({ rootDir: this.opts.rootDir, profile });
    await withAgentSwitchLock(paths, () => writeFailoverProfile(this.opts.configPath, profile, (current) => {
      if (standby === current.agentKind) throw new Error('备用 agent 必须与当前 agent 不同');
      return {
        ...current,
        agentFailover: {
          original: current.agentFailover?.original ?? current.agentKind,
          preferences: current.agentFailover?.preferences ?? {},
          ...(standby ? { standby } : {}),
        },
      };
    }));
  }

  async switchAgent(profile: string, request: AgentSwitchRequest, onPhase?: (phase: AgentSwitchPhase) => void): Promise<void> {
    if (this.switching.has(profile)) throw new Error('profile 正在切换 agent');
    const paths = resolveAppPaths({ rootDir: this.opts.rootDir, profile });
    const remote = findLiveProcess(paths);
    if (!this.managed.has(profile) && remote && remote.pid !== process.pid && remote.ready !== false) {
      if (!remote.agentSwitchSocket) throw new Error('独立 profile 需要先升级并重启才能在线切换');
      await requestAgentSwitch(paths.profileDir, remote.agentSwitchSocket, request);
      return;
    }
    const switching = withAgentSwitchLock(paths, async () => {
      await this.starting.get(profile);
      const managed = this.managed.get(profile);
      log.info('supervisor', 'agent-switch-started', { profile, ...request });
      if (managed?.online) {
        await managed.switchAgent(request, this.opts.runPreflight !== false, onPhase);
      } else {
        await this.switchOfflineAgent(paths, request);
      }
      log.info('supervisor', 'agent-switch-completed', { profile, agent: request.target });
    });
    this.switching.set(profile, switching);
    try {
      await switching;
    } finally {
      this.switching.delete(profile);
    }
  }

  private async switchOfflineAgent(paths: AppPaths, request: AgentSwitchRequest): Promise<void> {
    const { profile } = paths;
    const configPath = this.opts.configPath;
    const current = await readFailoverProfile(configPath, profile);
    const candidate = switchProfileAgent(current, request);
    if (this.opts.runPreflight !== false) {
      await probeSwitchTarget(createRuntimeAgent(candidate, { ...paths, configPath }), candidate);
    }
    const stale = this.managed.get(profile);
    if (stale) {
      this.managed.delete(profile);
      await stale.stop();
    }
    const resolveService = this.opts.serviceAdapter ?? getServiceAdapter;
    const service = profile === SUPERVISOR_SERVICE_ID ? null : resolveService(profile);
    const installed = service?.fileExists() ? service : null;
    const live = findLiveProcess(paths);
    if (live && live.ready !== false) throw new Error('profile 已上线，请刷新后再切换');
    if (installed?.isRunning()) {
      const stopped = await installed.stop();
      if (!stopped.ok || !await installed.waitUntilStopped()) throw new Error('无法停止正在启动的独立 profile');
    }
    const lock = await checkRuntimeLock(paths.profileLockFile);
    if (lock.locked || lock.uncertain) throw new Error('profile 启动或停止中，请稍后再试');
    let previous = current;
    await writeFailoverProfile(configPath, profile, (latest) => {
      previous = latest;
      return switchProfileAgent(latest, request);
    });
    const start = async (kind: AgentKind) => {
      if (!installed) {
        await this.startProfileOnce(profile);
        return;
      }
      const result = await installed.start();
      if (!result.ok) throw new Error('独立 profile 启动请求失败');
      const until = Date.now() + 30_000;
      do {
        const entry = findLiveProcess(paths);
        if (entry?.agentKind === kind && entry.ready === true) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < until);
      throw new Error('等待独立 profile 连接飞书超时');
    };
    try {
      await start(request.target);
    } catch (err) {
      let stopped = true;
      if (installed?.isRunning()) {
        const result = await installed.stop();
        stopped = result.ok && await installed.waitUntilStopped();
      }
      const restored = await restorePreviousAgent(configPath, profile, previous, request.target);
      let recovered = false;
      if (stopped && restored) {
        try {
          await start(request.expected);
          recovered = true;
        } catch (rollbackError) {
          log.warn('supervisor', 'agent-switch-restart-failed', { profile, err: String(rollbackError) });
        }
      }
      throw new Error(`切换失败（${errorText(err)}）。${restored ? '已恢复原配置' : '配置已被修改'}，${recovered ? '原 bot 已连接' : '原 bot 未恢复'}`);
    }
  }

  /** Stop every profile — for process shutdown. */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.switching.values(), ...this.starting.values()]);
    const all = [...this.managed.values()];
    this.managed.clear();
    await Promise.allSettled(all.map((m) => m.stop()));
  }

  /** Sync best-effort unregister of all entries (for the process 'exit' hook). */
  unregisterAllSync(): void {
    for (const m of this.managed.values()) m.unregisterSelfSync();
  }
}


function findLiveProcess(paths: AppPaths) {
  return readAndPrune(paths.userRegistryFile).find((entry) =>
    entry.profileName === paths.profile && isAlive(entry.pid),
  );
}

async function restorePreviousAgent(
  configPath: string, profile: string, previous: ProfileConfig, target: AgentKind,
): Promise<boolean> {
  let restored = false;
  await writeFailoverProfile(configPath, profile, (latest) => {
    if (latest.agentKind !== target) return latest;
    restored = true;
    const { model: _model, effort: _effort, chatEffort: _chatEffort, ...shared } = latest.preferences;
    const { model, effort, chatEffort } = previous.preferences;
    return {
      ...latest,
      agentKind: previous.agentKind,
      agentFailover: previous.agentFailover,
      preferences: { ...shared, model, effort, chatEffort },
    };
  });
  return restored;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
