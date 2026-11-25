import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';
import { parseAgentSwitch, type AgentSwitchRequest } from './agent-failover';

const MAX_MESSAGE_BYTES = 4096;
const SWITCH_TIMEOUT_MS = 125_000;

/** Private owner-only endpoint for the local web supervisor to reach a
 * profile hosted in a separate daemon. One validated operation per connection. */
export async function listenForAgentSwitch(
  profileDir: string,
  handler: (request: AgentSwitchRequest) => Promise<void>,
): Promise<{ path: string; close(): Promise<void> }> {
  // mkdtemp creates a 0700 directory and keeps Unix paths below Darwin's limit.
  const dir = await mkdtemp(join(tmpdir(), 'lcb-switch-'));
  const path = join(dir, 'control.sock');
  const key = randomBytes(32);
  const keyFile = join(profileDir, 'agent-switch.key');
  const server = createServer((socket) => {
    socket.setTimeout(5_000, () => socket.destroy());
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    let buffer = '';
    const receive = (data: string) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      socket.off('data', receive);
      socket.setTimeout(SWITCH_TIMEOUT_MS, () => socket.destroy());
      void Promise.resolve().then(() => {
        const message = JSON.parse(buffer.slice(0, end)) as { key?: unknown; request?: unknown } | null;
        const supplied = Buffer.from(typeof message?.key === 'string' ? message.key : '', 'hex');
        if (supplied.length !== key.length || !timingSafeEqual(key, supplied)) {
          throw new Error('agent 切换授权无效');
        }
        return handler(parseAgentSwitch(message?.request));
      }).then(
          () => socket.end('{"ok":true}\n'),
          (err: unknown) => socket.end(`${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`),
        );
    };
    socket.on('data', receive);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await writeFileAtomic(keyFile, key.toString('hex'), { mode: 0o600 });
  } catch (err) {
    if (server.listening) server.close();
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    path,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
      await rm(keyFile, { force: true });
    },
  };
}

export async function requestAgentSwitch(profileDir: string, path: string, request: AgentSwitchRequest): Promise<void> {
  const key = await readFile(join(profileDir, 'agent-switch.key'), 'utf8');
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(SWITCH_TIMEOUT_MS, () =>
      socket.destroy(new Error('切换等待超时，请刷新 profile 查看当前状态')),
    );
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify({ key, request })}\n`));
    socket.on('data', (data: string) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        socket.destroy(new Error('无效的切换响应'));
        return;
      }
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      socket.destroy();
      try {
        const result = JSON.parse(buffer.slice(0, end)) as { ok?: boolean; error?: string };
        if (result.ok === true) resolve();
        else reject(new Error(result.error ?? '切换失败'));
      } catch (err) {
        reject(err);
      }
    });
    socket.once('close', () => reject(new Error('profile 控制连接已关闭，请刷新状态')));
  });
}
