import { createInterface } from 'node:readline';
import { isAbsolute } from 'node:path';
import { spawnProcess } from '../../platform/spawn';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability } from '../preflight';
import { isAlive, listDescendants, signalAll } from '../process-tree';
import { agentDescriptor } from '../registry';
import type { AgentAdapter, AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '../types';

const descriptor = agentDescriptor('agy');

export class AgyAdapter implements AgentAdapter {
  readonly id = descriptor.kind;
  readonly displayName = descriptor.displayName;
  private identity?: AgentBotIdentity;

  constructor(private readonly opts: { binary: string; larkChannel?: LarkChannelEnvContext }) {}

  setBotIdentity(identity: AgentBotIdentity): void {
    this.identity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  checkAvailability() {
    return checkAgentAvailability({
      agentId: this.id,
      agentName: this.displayName,
      command: descriptor.command,
      binaryPath: this.opts.binary,
    });
  }

  run(options: AgentRunOptions): AgentRun {
    if (!options.cwd || !isAbsolute(options.cwd)) throw new Error('Antigravity ACP 需要绝对工作目录');
    if (options.guard || options.approvals || (options.sandbox && options.sandbox !== 'danger-full-access')) {
      throw new Error('当前 Antigravity ACP 只支持主人私聊和完整的 bridge 权限级别');
    }

    const child = spawnProcess(this.opts.binary, ['acp'], {
      cwd: options.cwd,
      env: { ...process.env, ...buildLarkChannelEnv(this.opts.larkChannel) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdin = child.stdin!;
    const stdout = child.stdout!;
    const lines = createInterface({ input: stdout, crlfDelay: Infinity });
    child.stderr?.resume();
    let processError: Error | undefined;
    let closed = false;
    const exited = new Promise<void>((resolve) => {
      child.once('error', (error) => { processError = error; });
      child.once('close', () => {
        closed = true;
        resolve();
      });
    });
    stdin.on('error', (error) => { processError ??= error; });

    let sessionId: string | undefined;
    let promptPending = false;
    let stopRequested = false;
    let stopping: Promise<void> | undefined;
    const send = (message: Message): void => {
      if (!stdin.destroyed && !stdin.writableEnded) {
        stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
      }
    };
    const request = (id: number, method: string, params: Message) => send({ id, method, params });
    const systemPrompt = buildBridgeSystemPrompt(this.identity);
    const waitForExit = async (timeoutMs: number): Promise<boolean> => {
      if (closed) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          exited.then(() => true),
          new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    async function* events(): AsyncGenerator<AgentEvent> {
      const tools = new Map<string, boolean>();
      let terminal: AgentEvent | undefined;
      let pendingId = 1;
      try {
        if (!stopRequested) request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
        for await (const line of lines) {
          if (!line.trim()) continue;
          const message = object(JSON.parse(line));
          if (typeof message.method === 'string' && message.id != null) {
            const params = object(message.params);
            if (message.method === 'session/request_permission' && params.sessionId === sessionId && promptPending) {
              const options = Array.isArray(params.options) ? params.options : [];
              const rejectId = options.map(object).find((entry) => entry.kind === 'reject_once')?.optionId;
              const outcome = !stopRequested && typeof rejectId === 'string'
                ? { outcome: 'selected', optionId: rejectId }
                : { outcome: 'cancelled' };
              send({ id: message.id, result: { outcome } });
            } else {
              send({ id: message.id, error: { code: -32601, message: 'Method not supported by the bridge' } });
            }
            continue;
          }
          if (message.method === 'session/update') {
            const params = object(message.params);
            if (promptPending && params.sessionId === sessionId && !stopRequested) {
              yield* turnUpdate(object(params.update), tools);
            }
            continue;
          }
          if (message.id !== pendingId) continue;
          const error = object(message.error);
          if (message.error) throw new Error(rpcErrorMessage(error));
          const result = object(message.result);
          if (stopRequested || pendingId === 3) {
            terminal = stopRequested ? finish(sessionId, true) : finishPrompt(sessionId, result.stopReason);
            break;
          }
          if (pendingId === 1) {
            if (result.protocolVersion !== 1) throw new Error('Antigravity ACP 协议版本不兼容');
            const capabilities = object(result.agentCapabilities);
            const extension = object(object(object(capabilities._meta).antigravity).systemPrompt);
            if (extension.append !== true) {
              throw new Error('当前 agy 缺少 ACP 系统提示词支持，请升级 Antigravity CLI');
            }
            if (options.sessionId && !object(capabilities.sessionCapabilities).resume) {
              throw new Error('当前 agy 缺少 ACP 会话恢复能力，请升级 Antigravity CLI');
            }
            pendingId = 2;
            request(2, options.sessionId ? 'session/resume' : 'session/new', {
              cwd: options.cwd,
              mcpServers: [],
              ...(options.sessionId ? { sessionId: options.sessionId } : {}),
              _meta: { antigravity: { systemPrompt: { append: systemPrompt } } },
            });
          } else {
            sessionId = options.sessionId ?? (typeof result.sessionId === 'string' ? result.sessionId : undefined);
            if (!sessionId) throw new Error('Antigravity ACP 没有返回会话 ID');
            pendingId = 3;
            promptPending = true;
            request(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: options.prompt }] });
            yield { type: 'system', sessionId, cwd: options.cwd };
          }
        }
        if (!terminal && !stopRequested) {
          throw processError ?? new Error('Antigravity ACP 在返回结果前退出');
        }
      } catch (error) {
        if (!stopRequested) {
          const message = error instanceof Error ? error.message : String(error);
          terminal = { type: 'error', message, terminationReason: 'failed' };
        }
      } finally {
        promptPending = false;
        lines.close();
        stdin.end();
      }
      yield terminal ?? finish(sessionId, true);
    }

    const stop = async (): Promise<void> => {
      stopRequested = true;
      if (closed) return;
      const descendants = child.pid ? listDescendants(child.pid) : [];
      const grace = options.stopGraceMs ?? 5000;
      const cancelGrace = promptPending && sessionId ? Math.min(grace, 1000) : 0;
      if (cancelGrace) {
        send({ method: 'session/cancel', params: { sessionId } });
        if (await waitForExit(cancelGrace) && !descendants.some(isAlive)) return;
      }
      if (!closed) child.kill('SIGTERM');
      signalAll(descendants.filter(isAlive), 'SIGTERM');
      await waitForExit(Math.max(0, grace - cancelGrace));
      const survivors = new Set(descendants.filter(isAlive));
      if (!closed && child.pid) {
        for (const pid of listDescendants(child.pid)) survivors.add(pid);
        child.kill('SIGKILL');
      }
      signalAll([...survivors], 'SIGKILL');
    };

    return {
      runId: options.runId,
      pid: child.pid,
      events: events(),
      stop: () => stopping ??= stop(),
      waitForExit,
    };
  }
}

type Message = Record<string, unknown>;

function object(value: unknown): Message {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Message : {};
}

function rpcErrorMessage(error: Message): string {
  const message = typeof error.message === 'string' ? error.message : 'Antigravity ACP 请求失败';
  if (error.code === -32000 && message === 'Authentication required') {
    return 'Antigravity 需要登录，请在运行 bridge 的机器上执行 agy acp --login。';
  }
  return message;
}

function finish(sessionId: string | undefined, interrupted: boolean): AgentEvent {
  return { type: 'done', sessionId, terminationReason: interrupted ? 'interrupted' : 'normal' };
}

function finishPrompt(sessionId: string | undefined, reason: unknown): AgentEvent {
  switch (reason) {
    case 'end_turn':
    case 'refusal':
      return finish(sessionId, false);
    case 'cancelled':
      return finish(sessionId, true);
    case 'max_tokens':
    case 'max_turn_requests':
      return { type: 'error', message: 'Antigravity 本轮已达到模型运行上限。', terminationReason: 'failed' };
    default:
      throw new Error('Antigravity ACP 返回了无效的回合结束状态');
  }
}

function* turnUpdate(update: Message, tools: Map<string, boolean>): Generator<AgentEvent> {
  const content = object(update.content);
  if (content.type === 'text' && typeof content.text === 'string') {
    if (update.sessionUpdate === 'agent_message_chunk') yield { type: 'text', delta: content.text };
    if (update.sessionUpdate === 'agent_thought_chunk') yield { type: 'thinking', delta: content.text };
  }

  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
  const id = update.toolCallId;
  if (typeof id !== 'string' || tools.get(id)) return;
  if (!tools.has(id)) {
    tools.set(id, false);
    const name = typeof update.title === 'string' && update.title ? update.title : 'Antigravity';
    yield { type: 'tool_use', id, name, input: update.rawInput ?? {} };
  }
  if (update.status !== 'completed' && update.status !== 'failed') return;
  tools.set(id, true);
  const output = typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput ?? '');
  yield { type: 'tool_result', id, output, isError: update.status === 'failed' };
}
