import { LarkChannelError, type NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  rawWsClient?: { close: ReturnType<typeof vi.fn> };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    im: { v1: { message: { get: ReturnType<typeof vi.fn> } } };
  };
  on(handlers: { message?: (msg: NormalizedMessage) => Promise<void> | void }): void;
  onRawEvent(eventType: string, handler: (payload: unknown) => void | Promise<void>): () => void;
  getAppInfo: ReturnType<typeof vi.fn>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown): Promise<{ messageId: string }>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('startChannel connect', () => {
  it('closes the half-opened socket when the first handshake fails', async () => {
    const wsClient = { close: vi.fn() };
    const h = await createHarness({
      connect: async (channel) => {
        // The SDK builds its WSClient before the handshake and keeps it
        // retrying after `connect()` gives up.
        channel.rawWsClient = wsClient;
        throw new LarkChannelError('not_connected', 'WebSocket handshake did not complete within 15000ms');
      },
    });

    await expect(start(h)).rejects.toThrow(/handshake did not complete/);

    expect(wsClient.close).toHaveBeenCalledTimes(1);
  });

  it('knows the owner before the socket can deliver a message', async () => {
    let atConnect: { state: string; owner?: string } | undefined;
    const h = await createHarness({
      connect: async () => {
        atConnect = { state: h.controls.ownerRefreshState, owner: h.controls.botOwnerId };
      },
    });

    const bridge = await start(h);
    cleanups.push(() => bridge.disconnect());

    expect(atConnect).toEqual({ state: 'ok', owner: 'ou_owner' });
  });
});

async function createHarness(options: {
  connect: (channel: FakeLarkChannel) => Promise<void>;
}) {
  const tmp = await createTmpProfile('channel-connect-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
  });
  const profileConfig = { ...base, workspaces: { ...base.workspaces, default: workspace } };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const channel = createFakeLarkChannel(options.connect);
  sdkMock.channel = channel;
  const controls: {
    profile: string;
    profileConfig: typeof profileConfig;
    cfg: typeof profileConfig;
    ownerRefreshState: 'unknown' | 'ok' | 'failed';
    botOwnerId?: string;
    configPath: string;
    processId: string;
    refreshOwner(): Promise<void>;
    restart(): Promise<void>;
    exit(): Promise<void>;
  } = {
    profile: 'claude',
    profileConfig,
    cfg: profileConfig,
    ownerRefreshState: 'unknown',
    configPath: '/tmp/config.json',
    processId: 'proc_test',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
  };
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    profileConfig,
    sessions,
    workspaces,
    controls,
    agent: new FakeAgentAdapter({ events: [] }),
  };
}

function start(h: Awaited<ReturnType<typeof createHarness>>) {
  return startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
}

function createFakeLarkChannel(connect: (channel: FakeLarkChannel) => Promise<void>): FakeLarkChannel {
  const channel: FakeLarkChannel = {
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      im: { v1: { message: { get: vi.fn(async () => ({ data: { items: [] } })) } } },
    },
    on() {},
    onRawEvent() {
      return () => {};
    },
    getAppInfo: vi.fn(async () => ({ ownerId: 'ou_owner' })),
    connect: () => connect(channel),
    async disconnect() {},
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send() {
      return { messageId: 'om_sent' };
    },
  };
  return channel;
}
