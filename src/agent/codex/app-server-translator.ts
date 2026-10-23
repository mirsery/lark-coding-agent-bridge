import { log } from '../../core/logger';
import type { AgentEvent } from '../types';
import { isUsageLimitMessage, USAGE_LIMIT_ERROR_INFO } from './rate-limit';
import type { CodexCall } from './blocked-calls';

/**
 * Turns `codex app-server` notifications for one turn into bridge events,
 * with the same shape the `codex exec --json` translator produces: command
 * runs as `command_execution` tool calls, every agent message but the last
 * as progress text, the last one as `final_text`, then usage and `done`.
 *
 * Unlike `exec`, the app-server reports usage per model call
 * (`thread/tokenUsage/updated.last`); the turn's usage is their sum.
 */
export class CodexAppServerTranslator {
  private readonly threadId: string;
  private pendingAgentMessage: string | undefined;
  private lastError: string | undefined;
  private usageLimitMessage: string | undefined;
  private terminal = false;
  /** Tool items announced with `tool_use` and still waiting for their result. */
  private readonly openTools = new Set<string>();
  /** Which of them are sub-agent (collab) calls. */
  private readonly collabTools = new Set<string>();
  private planUpdates = 0;
  private readonly usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  private sawUsage = false;
  /** The call a PreToolUse hook blocked, looked up by id (it never becomes an item). */
  private readonly blockedCall: ((callId: string) => CodexCall | undefined) | undefined;

  constructor(threadId: string, blockedCall?: (callId: string) => CodexCall | undefined) {
    this.threadId = threadId;
    this.blockedCall = blockedCall;
  }

  /**
   * Count an earlier turn's usage as this turn's: a follow-up turn the
   * bridge started on its own (unread supplements) is still the same reply.
   */
  carryUsage(usage: Extract<AgentEvent, { type: 'usage' }>): void {
    this.sawUsage = true;
    this.usage.inputTokens += usage.inputTokens ?? 0;
    this.usage.cachedInputTokens += usage.cachedInputTokens ?? 0;
    this.usage.outputTokens += usage.outputTokens ?? 0;
    this.usage.reasoningOutputTokens += usage.reasoningOutputTokens ?? 0;
  }

  /** The turn's opening event: the session handle the bridge resumes later. */
  start(): AgentEvent[] {
    return [{ type: 'system', threadId: this.threadId }];
  }

  get done(): boolean {
    return this.terminal;
  }

  /** The plan's quota refused the turn: Codex's wording, which says when it resets. */
  get usageLimit(): string | undefined {
    return this.usageLimitMessage;
  }

  notification(method: string, params: Record<string, unknown>): AgentEvent[] {
    if (this.terminal) return [];
    switch (method) {
      case 'item/started':
        return this.prependPending(this.itemStarted(record(params.item)));
      case 'item/completed':
        return this.itemCompleted(record(params.item));
      case 'item/reasoning/summaryTextDelta': {
        const delta = str(params.delta);
        return delta ? [{ type: 'thinking', delta }] : [];
      }
      case 'turn/plan/updated':
        return this.prependPending(this.planUpdated(params));
      case 'hook/completed':
        return this.prependPending(this.hookBlocked(record(params.run)));
      case 'thread/tokenUsage/updated':
        this.addUsage(record(record(params.tokenUsage)?.last));
        return [];
      case 'error': {
        const error = record(params.error);
        const message = str(error?.message);
        this.noteUsageLimit(error);
        if (message) {
          this.lastError = message;
          log.warn('codex-app-server', 'error_event', { message: message.slice(0, 500), willRetry: params.willRetry === true });
        }
        return [];
      }
      case 'turn/completed':
        return this.turnCompleted(record(params.turn));
      default:
        return [];
    }
  }

  /**
   * A notification from a sub-agent's own thread (multi-agent). Its messages
   * and turn end are not this reply's; its steps show as sub-agent activity
   * under the collab tool call that is waiting on it — no command bodies,
   * which may carry credentials.
   */
  childNotification(method: string, params: Record<string, unknown>, childThreadId: string): AgentEvent[] {
    if (this.terminal || method !== 'item/started') return [];
    const item = record(params.item);
    const step = item ? CHILD_STEPS[str(item.type) ?? ''] : undefined;
    if (!item || !step) return [];
    const tool = item.type === 'mcpToolCall' ? `mcp__${str(item.server) ?? 'mcp'}__${str(item.tool) ?? 'tool'}` : step.tool;
    const parent = [...this.openTools].reverse().find((id) => this.collabTools.has(id)) ?? childThreadId;
    return [{ type: 'subagent_activity', parentToolUseId: parent, tool, description: step.description, at: Date.now() }];
  }

  /** The process went away mid-turn. */
  fail(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    const detail = this.lastError && !message.includes(this.lastError) ? `: ${this.lastError}` : '';
    return this.prependPending([{ type: 'error', message: truncate(`${message}${detail}`), terminationReason: 'failed' }]);
  }

  private itemStarted(item: Record<string, unknown> | undefined): AgentEvent[] {
    const id = str(item?.id);
    if (!item || !id) return [];
    if (item.type === 'commandExecution') {
      return [{ type: 'tool_use', id, name: 'command_execution', input: { command: str(item.command) ?? '' } }];
    }
    if (item.type === 'fileChange') {
      const paths = (Array.isArray(item.changes) ? item.changes : [])
        .map((c) => str(record(c)?.path))
        .filter((p): p is string => Boolean(p));
      return [{ type: 'tool_use', id, name: 'file_change', input: { paths } }];
    }
    if (item.type === 'mcpToolCall') {
      // Same name shape as Claude's MCP tools, so cards and approvals read alike.
      const name = `mcp__${str(item.server) ?? 'mcp'}__${str(item.tool) ?? 'tool'}`;
      return this.toolUse(id, name, record(item.arguments) ?? {});
    }
    if (item.type === 'dynamicToolCall') {
      return this.toolUse(id, str(item.tool) ?? 'tool', record(item.arguments) ?? {});
    }
    if (item.type === 'webSearch') {
      // The query is often still empty when the search starts; wait for it.
      const query = str(item.query);
      return query ? this.toolUse(id, 'WebSearch', { query }) : [];
    }
    if (item.type === 'collabAgentToolCall') {
      this.collabTools.add(id);
      return this.toolUse(id, 'Agent', { description: collabDescription(item) });
    }
    return [];
  }

  private toolUse(id: string, name: string, input: Record<string, unknown>): AgentEvent[] {
    this.openTools.add(id);
    return [{ type: 'tool_use', id, name, input }];
  }

  /** A tool item finished: its result, opening it first when its start said too little to show. */
  private toolDone(item: Record<string, unknown>, id: string): AgentEvent[] {
    const failed = item.status === 'failed' || item.success === false;
    const opened = this.openTools.has(id);
    this.openTools.delete(id);
    let output = '';
    let start: AgentEvent[] = [];
    switch (item.type) {
      case 'mcpToolCall':
        output = str(record(item.error)?.message) ?? contentText(record(item.result)?.content);
        break;
      case 'dynamicToolCall':
        output = contentText(item.contentItems);
        break;
      case 'webSearch': {
        const query = str(item.query) ?? '';
        if (!opened) start = [{ type: 'tool_use', id, name: 'WebSearch', input: { query } }];
        output = webSearchAction(record(item.action)) ?? query;
        break;
      }
      case 'collabAgentToolCall':
        output = collabOutput(item);
        break;
    }
    if (!opened && start.length === 0) return [];
    return this.prependPending([...start, { type: 'tool_result', id, output: truncate(output, 4096), isError: failed }]);
  }

  /**
   * A call a PreToolUse hook refused — the bridge's guest guard, mostly. It
   * never becomes an item, so show it as a failed step the way Claude reports
   * a refused call, which is also what `/audit 拦截` reads (`guardRefusal`).
   */
  private hookBlocked(run: Record<string, unknown> | undefined): AgentEvent[] {
    if (run?.eventName !== 'preToolUse' || run.status !== 'blocked') return [];
    // `pre-tool-use:<n>:<source path>:<call id>`
    const id = str(run.id)?.split(':').at(-1);
    if (!id) return [];
    const reason = (Array.isArray(run.entries) ? run.entries : [])
      .map(record)
      .filter((entry) => entry?.kind === 'feedback' || entry?.kind === 'error')
      .map((entry) => str(entry?.text))
      .filter(Boolean)
      .join('\n');
    const call = this.blockedCall?.(id) ?? { name: 'PreToolUse', input: {} };
    const hook = run.source === 'sessionFlags' ? ' [codex-hook.mjs]' : '';
    return [
      { type: 'tool_use', id, name: call.name, input: call.input },
      { type: 'tool_result', id, output: truncate(`PreToolUse hook${hook}: ${reason || 'blocked'}`), isError: true },
    ];
  }

  /** Codex's step list (`update_plan`), shown like Claude's to-do updates. */
  private planUpdated(params: Record<string, unknown>): AgentEvent[] {
    const steps = (Array.isArray(params.plan) ? params.plan : []).map(record).filter((s): s is Record<string, unknown> => Boolean(s));
    if (steps.length === 0) return [];
    const id = `plan-${++this.planUpdates}`;
    const mark = (status: unknown): string => (status === 'completed' ? '✅' : status === 'inProgress' ? '⏳' : '⬜');
    const output = steps.map((s) => `${mark(s.status)} ${str(s.step) ?? ''}`).join('\n');
    const explanation = str(params.explanation);
    return [
      { type: 'tool_use', id, name: 'update_plan', input: explanation ? { explanation } : {} },
      { type: 'tool_result', id, output, isError: false },
    ];
  }

  private itemCompleted(item: Record<string, unknown> | undefined): AgentEvent[] {
    if (!item) return [];
    if (item.type === 'agentMessage') {
      const text = str(item.text);
      return text ? this.queueAgentMessage(text) : [];
    }
    if (TOOL_ITEMS.has(str(item.type) ?? '')) {
      const id = str(item.id);
      return id ? this.toolDone(item, id) : [];
    }
    if (item.type === 'fileChange') {
      const id = str(item.id);
      if (!id) return [];
      return this.prependPending([
        { type: 'tool_result', id, output: str(item.status) ?? '', isError: item.status !== 'completed' },
      ]);
    }
    if (item.type !== 'commandExecution') return [];
    const id = str(item.id);
    if (!id) return [];
    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
    return this.prependPending([
      {
        type: 'tool_result',
        id,
        output: str(item.aggregatedOutput) ?? '',
        isError: item.status === 'failed' || (exitCode !== undefined && exitCode !== 0),
      },
    ]);
  }

  private turnCompleted(turn: Record<string, unknown> | undefined): AgentEvent[] {
    this.terminal = true;
    const status = str(turn?.status);
    if (status === 'failed') {
      this.noteUsageLimit(record(turn?.error));
      const message = str(record(turn?.error)?.message) ?? this.lastError ?? 'codex turn failed';
      return this.prependPending([{ type: 'error', message: truncate(message), terminationReason: 'failed' }]);
    }
    const events: AgentEvent[] = [];
    if (status === 'interrupted') {
      if (this.pendingAgentMessage) events.push({ type: 'text', delta: this.pendingAgentMessage });
    } else if (this.pendingAgentMessage) {
      events.push({ type: 'final_text', content: this.pendingAgentMessage });
    }
    this.pendingAgentMessage = undefined;
    if (this.sawUsage) events.push({ type: 'usage', ...this.usage });
    events.push({
      type: 'done',
      threadId: this.threadId,
      terminationReason: status === 'interrupted' ? 'interrupted' : 'normal',
    });
    return events;
  }

  private noteUsageLimit(error: Record<string, unknown> | undefined): void {
    const message = str(error?.message);
    if (error?.codexErrorInfo === USAGE_LIMIT_ERROR_INFO || isUsageLimitMessage(message)) {
      this.usageLimitMessage = message ?? this.usageLimitMessage ?? 'usage limit reached';
    }
  }

  private addUsage(last: Record<string, unknown> | undefined): void {
    if (!last) return;
    this.sawUsage = true;
    this.usage.inputTokens += num(last.inputTokens);
    this.usage.cachedInputTokens += num(last.cachedInputTokens);
    this.usage.outputTokens += num(last.outputTokens);
    this.usage.reasoningOutputTokens += num(last.reasoningOutputTokens);
  }

  private queueAgentMessage(message: string): AgentEvent[] {
    if (message === this.pendingAgentMessage) return [];
    const events: AgentEvent[] = this.pendingAgentMessage ? [{ type: 'text', delta: this.pendingAgentMessage }] : [];
    this.pendingAgentMessage = message;
    return events;
  }

  private prependPending(events: AgentEvent[]): AgentEvent[] {
    if (events.length === 0 || !this.pendingAgentMessage) return events;
    const pending = this.pendingAgentMessage;
    this.pendingAgentMessage = undefined;
    return [{ type: 'text', delta: pending }, ...events];
  }
}

/** A sub-agent's steps, as the progress line names them. */
const CHILD_STEPS: Record<string, { tool: string; description: string }> = {
  commandExecution: { tool: 'command_execution', description: '运行命令' },
  fileChange: { tool: 'file_change', description: '修改文件' },
  mcpToolCall: { tool: 'mcp', description: '调用外部工具' },
  dynamicToolCall: { tool: 'tool', description: '调用工具' },
  webSearch: { tool: 'WebSearch', description: '搜索网页' },
  collabAgentToolCall: { tool: 'Agent', description: '协调子 agent' },
};

/** Item types shown as tool steps besides commands and file changes. */
const TOOL_ITEMS = new Set(['mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabAgentToolCall']);

/** The text parts of an MCP / dynamic tool result. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const rec = record(part);
      return str(rec?.text) ?? (rec?.type === 'inputImage' || rec?.type === 'image' ? '[image]' : '');
    })
    .filter(Boolean)
    .join('\n');
}

function webSearchAction(action: Record<string, unknown> | undefined): string | undefined {
  switch (action?.type) {
    case 'search': {
      const queries = Array.isArray(action.queries) ? action.queries.filter((q): q is string => typeof q === 'string') : [];
      return queries.length > 0 ? queries.join('\n') : str(action.query);
    }
    case 'openPage':
      return str(action.url) ? `open ${str(action.url)}` : undefined;
    case 'findInPage':
      return str(action.url) ? `find "${str(action.pattern) ?? ''}" in ${str(action.url)}` : undefined;
    default:
      return undefined;
  }
}

const COLLAB_TOOLS: Record<string, string> = {
  spawnAgent: '启动子 agent',
  sendInput: '给子 agent 发消息',
  sendMessage: '给子 agent 发消息',
  followupTask: '给子 agent 追加任务',
  resumeAgent: '恢复子 agent',
  wait: '等待子 agent',
  closeAgent: '关闭子 agent',
  interruptAgent: '中断子 agent',
  listAgents: '查看子 agent',
};

function collabDescription(item: Record<string, unknown>): string {
  const tool = str(item.tool) ?? '';
  const label = COLLAB_TOOLS[tool] ?? tool;
  const prompt = str(item.prompt)?.replace(/\s+/g, ' ').trim();
  return prompt ? `${label}：${prompt}` : label;
}

function collabOutput(item: Record<string, unknown>): string {
  const states = record(item.agentsStates) ?? {};
  return Object.values(states)
    .map((state) => {
      const rec = record(state);
      const status = str(rec?.status) ?? '';
      const message = str(rec?.message);
      return message ? `${status}: ${message}` : status;
    })
    .filter(Boolean)
    .join('\n');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function truncate(value: string, max = 4096): string {
  return value.length > max ? value.slice(0, max) : value;
}
