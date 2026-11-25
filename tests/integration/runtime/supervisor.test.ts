import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { listenForAgentSwitch, requestAgentSwitch } from '../../../src/runtime/agent-switch-socket';
import { register, readAndPrune } from '../../../src/runtime/registry';
import { Supervisor } from '../../../src/runtime/supervisor';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const roots: string[] = [];
const started: string[] = [];
const disconnected: string[] = [];
let root: string;
let sup: Supervisor;

function app(id: string) {
  return { id, secret: '${APP_SECRET}', tenant: 'feishu' as const };
}

// Stub startChannel — no network, records lifecycle, returns a minimal bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stubStartChannel: any = async (deps: any) => {
  started.push(deps.appPaths.profile);
  return {
    channel: { botIdentity: { name: `bot-${deps.appPaths.profile}` } },
    disconnect: async () => {
      disconnected.push(deps.appPaths.profile);
    },
  };
};

beforeEach(async () => {
  started.length = 0;
  disconnected.length = 0;
  root = await mkdtemp(join(tmpdir(), 'bridge-sup-'));
  roots.push(root);
  const configPath = join(root, 'config.json');

  // claude (cli_a), work (cli_b), dup (cli_b — same app as work).
  await mkdir(join(root, 'profiles', 'claude'), { recursive: true });
  await saveRootConfig(
    createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: app('cli_a') } })),
    configPath,
  );
  const rc = (await loadRootConfig(configPath))!;
  for (const [name, id] of [['work', 'cli_b'], ['dup', 'cli_b']] as const) {
    await mkdir(join(root, 'profiles', name), { recursive: true });
    rc.profiles[name] = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: app(id) } });
  }
  await saveRootConfig(rc, configPath);

  sup = new Supervisor({ configPath, rootDir: root, runPreflight: false, startChannelFn: stubStartChannel });
});

afterEach(async () => {
  await sup.shutdown();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('Supervisor', () => {
  it('starts a profile in-process and lists it online', async () => {
    await sup.startProfile('claude');
    expect(sup.isOnline('claude')).toBe(true);
    expect(started).toContain('claude');
    const list = sup.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ profile: 'claude', online: true, pid: process.pid, botName: 'bot-claude' });
  });

  it('hosts multiple profiles at once', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('work');
    expect(sup.list().map((s) => s.profile).sort()).toEqual(['claude', 'work']);
  });

  it('stops one profile without affecting others or the process', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('work');
    await sup.stopProfile('claude');
    expect(sup.isOnline('claude')).toBe(false);
    expect(disconnected).toContain('claude');
    expect(sup.isOnline('work')).toBe(true); // supervisor + other profile still up
  });

  it('refuses to bring up two profiles sharing one app id', async () => {
    await sup.startProfile('work'); // cli_b
    await expect(sup.startProfile('dup')).rejects.toThrow(/已被 profile/);
    expect(sup.isOnline('dup')).toBe(false);
  });

  it('startProfile is idempotent', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('claude');
    expect(started.filter((p) => p === 'claude')).toHaveLength(1);
  });

  it('switches the same profile without overlapping channels and restores its preferences', async () => {
    const configPath = join(root, 'config.json');
    const rc = (await loadRootConfig(configPath))!;
    rc.profiles.claude!.preferences.model = 'opus';
    await saveRootConfig(rc, configPath);
    const order: string[] = [];
    sup = new Supervisor({
      configPath, rootDir: root, runPreflight: false,
      startChannelFn: async (deps) => {
        order.push(`start:${deps.agent.id}:${deps.appPaths?.runsFile}`);
        return {
          ...await stubStartChannel(deps),
          prepareAgentSwitch: async (force) => {
            order.push(`prepare:${force}`);
            return () => {};
          },
          disconnect: async () => { order.push(`stop:${deps.agent.id}`); },
        };
      },
    });
    await sup.startProfile('claude');
    await sup.configureStandby('claude', 'agy');
    await sup.switchAgent('claude', { expected: 'claude', target: 'agy', interrupt: false });
    expect(sup.list()[0]).toMatchObject({ agentKind: 'agy', appId: 'cli_a' });
    expect((await loadRootConfig(configPath))!.profiles.claude!.preferences.model).toBeUndefined();
    await sup.switchAgent('claude', { expected: 'agy', target: 'claude', interrupt: true });
    expect((await loadRootConfig(configPath))!.profiles.claude!.preferences.model).toBe('opus');
    expect(order.map((entry) => entry.split(':').slice(0, 2).join(':'))).toEqual([
      'start:claude', 'prepare:false', 'stop:claude', 'start:agy',
      'prepare:true', 'stop:agy', 'start:claude',
    ]);
  });

  it('rolls back when the replacement channel cannot connect', async () => {
    const configPath = join(root, 'config.json');
    sup = new Supervisor({
      configPath, rootDir: root, runPreflight: false,
      startChannelFn: async (deps) => {
        if (deps.agent.id === 'agy') throw new Error('socket unreachable');
        return stubStartChannel(deps);
      },
    });
    await sup.startProfile('claude');
    await sup.configureStandby('claude', 'agy');

    await expect(sup.switchAgent('claude', { expected: 'claude', target: 'agy', interrupt: false }))
      .rejects.toThrow(/socket unreachable.*已恢复原配置.*原 bot 已连接/);
    expect(sup.list()[0]).toMatchObject({ agentKind: 'claude', appId: 'cli_a' });
    expect((await loadRootConfig(configPath))!.profiles.claude?.agentFailover?.standby).toBe('agy');
    expect(started).toEqual(['claude', 'claude']);
  });

  it('starts the original profile via its existing daemon when it is offline', async () => {
    const configPath = join(root, 'config.json');
    const paths = resolveAppPaths({ rootDir: root, profile: 'work' });
    const startKinds: string[] = [];
    sup = new Supervisor({
      configPath, rootDir: root, runPreflight: false, startChannelFn: stubStartChannel,
      serviceAdapter: (profile) => profile === 'work' ? {
        fileExists: () => true,
        isRunning: () => false,
        stop: () => ({ ok: true, stderr: '' }),
        waitUntilStopped: async () => true,
        start: async () => {
          const config = (await loadRootConfig(configPath))!.profiles.work!;
          startKinds.push(config.agentKind);
          await register({
            appId: config.accounts.app.id, tenant: 'feishu', profileName: 'work',
            configPath, version: 'test', ready: true, agentKind: config.agentKind,
            registryFile: paths.userRegistryFile,
          });
          return { ok: true, stderr: '' };
        },
      } : null,
    });
    await sup.configureStandby('work', 'agy');
    await sup.switchAgent('work', { expected: 'claude', target: 'agy', interrupt: false });

    expect(startKinds).toEqual(['agy']);
    expect(started).toEqual([]);
    expect(readAndPrune(paths.userRegistryFile)[0]).toMatchObject({
      appId: 'cli_b', ready: true, agentKind: 'agy', profileName: 'work',
    });
  });

  it('rejects overlapping online switches and stale requests', async () => {
    const configPath = join(root, 'config.json');
    sup = new Supervisor({
      configPath, rootDir: root, runPreflight: false, startChannelFn: stubStartChannel,
    });
    await sup.startProfile('claude');
    await sup.configureStandby('claude', 'agy');
    const request = { expected: 'claude', target: 'agy', interrupt: false } as const;
    const first = sup.switchAgent('claude', request);
    await expect(sup.switchAgent('claude', request)).rejects.toThrow(/正在切换/);
    await first;
    await expect(sup.switchAgent('claude', request)).rejects.toThrow(/已变更/);
  });

  it('authenticates cross-process commands with the per-profile key', async () => {
    const profileDir = join(root, 'profiles', 'claude');
    const requests: unknown[] = [];
    const socket = await listenForAgentSwitch(profileDir, async (request) => { requests.push(request); });
    try {
      const path = join(profileDir, 'agent-switch.key');
      const key = await readFile(path, 'utf8');
      const request = { expected: 'claude', target: 'agy', interrupt: false } as const;
      await writeFile(path, '00'.repeat(32));
      await expect(requestAgentSwitch(profileDir, socket.path, request)).rejects.toThrow(/授权无效/);
      await writeFile(path, key);
      await requestAgentSwitch(profileDir, socket.path, request);
      expect(requests).toEqual([request]);
    } finally {
      await socket.close();
    }
  });

  it('keeps the known owner across a same-app restart', async () => {
    // restart() checks the agent binary unconditionally.
    const bin = join(root, 'bin');
    await writeVersionExecutable(bin, 'claude', '2.1.0');
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`;
    try {
      await sup.startProfile('claude');
      sup.controlsFor('claude')!.botOwnerId = 'ou_owner';

      await sup.restartProfile('claude');

      expect(started.filter((p) => p === 'claude')).toHaveLength(2);
      expect(sup.controlsFor('claude')!.botOwnerId).toBe('ou_owner');
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
