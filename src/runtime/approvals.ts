import { randomBytes } from 'node:crypto';
import { log } from '../core/logger';

/** Who a gated run acts for and where its answers go — refreshed per turn. */
export interface GateContext {
  actor: { id: string; name?: string };
  source: string;
  scopeId: string;
  chatId?: string;
  threadId?: string;
  /** The message that started the current turn (approval notices reply to it). */
  originMessageId?: string;
  /** Human label for where the request came from: a group's name, 私聊, 云文档评论… */
  where?: string;
  agent: string;
}

/** One side-effecting step the agent wants to take. */
export interface ApprovalRequest {
  tool: string;
  /** What it will do, for humans: the command, or the files it writes. */
  summary: string;
  /** Classified by the caller as harmless (e.g. a read-only shell command). */
  readOnly?: boolean;
}

export interface ApprovalAnswer {
  decision: 'allow' | 'deny';
  /** Told to the agent, so it can explain or adapt. */
  reason: string;
}

export type ApprovalOutcome =
  | { kind: 'allowed'; by: string; allowTurn: boolean }
  | { kind: 'denied'; by: string; byRequester: boolean }
  | { kind: 'timeout' }
  | { kind: 'cancelled'; reason: string };

export interface PendingApproval {
  id: string;
  request: ApprovalRequest;
  gate: GateContext;
  createdAt: number;
  /** Cards the notifier sent for this approval, to update once it settles. */
  notices: Array<{ messageId: string; audience: 'approver' | 'requester' }>;
}

/** Delivers approval prompts to people; implemented by the IM channel. */
export interface ApprovalNotifier {
  announce(pending: PendingApproval): Promise<void>;
  settled(pending: PendingApproval, outcome: ApprovalOutcome): Promise<void>;
}

/** What a run's adapter uses to ask; returned by {@link ApprovalBroker.openGate}. */
export interface ApprovalGate {
  token: string;
  decide(request: ApprovalRequest): Promise<ApprovalAnswer>;
}

export interface AuditSink {
  append(entry: Record<string, unknown>): void;
}

export type DecisionResult = 'ok' | 'not-found' | 'forbidden';

/**
 * Tools a gated (non-admin) run may use without asking: reading, searching,
 * planning, and the agent's own bookkeeping. Anything else — shell commands,
 * file writes, MCP tools (which can write to Jira, Feishu…) — waits for an
 * admin.
 */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'TodoRead',
  'ToolSearch',
  'Task',
  'Agent',
  'Skill',
  'BashOutput',
  'TaskOutput',
  'TaskCreate',
  'TaskList',
  'TaskGet',
  'TaskUpdate',
  'ExitPlanMode',
  'AskUserQuestion',
]);

export function needsApproval(tool: string): boolean {
  return !READ_ONLY_TOOLS.has(tool);
}

/** Commands that only look: run without asking when nothing in the line can write. */
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'pwd', 'echo', 'printf',
  'sed', 'jq', 'which', 'stat', 'du', 'df', 'sort', 'cut', 'tr', 'diff', 'basename', 'dirname',
  'realpath', 'readlink', 'whoami', 'uname', 'true', 'cd',
]);
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'branch', 'describe', 'shortlog', 'grep']);
/** `sed -n '1,50p'`-style printing scripts — anything else (`w`, `e`…) can write or run. */
const SED_PRINT_SCRIPT = /^['"]?(\d+|\$)?(,(\d+|\$))?p['"]?$/;

/**
 * Whether a shell command can be run without approval: every stage (split on
 * `&&` and `|`) is a known read-only command with no writing flags, and the
 * line has no redirection, `;`, background `&`, `||` or substitution.
 * Conservative — anything unrecognised asks.
 */
export function isReadOnlyCommand(command: string): boolean {
  const line = command.trim();
  if (!line || /[;><`\n\r]|\$\(|\|\||(^|[^&])&([^&]|$)/.test(line)) return false;
  return line
    .split('&&')
    .flatMap((part) => part.split('|'))
    .every((stage) => isReadOnlyStage(stage.trim().split(/\s+/)));
}

function isReadOnlyStage([cmd, ...args]: string[]): boolean {
  if (!cmd || !(READ_ONLY_COMMANDS.has(cmd) || cmd === 'git')) return false;
  switch (cmd) {
    case 'git': {
      // Only `-C dir` / `--no-pager` up front: `-c core.pager=…` and friends can run anything.
      let i = 0;
      while (args[i] === '-C' || args[i] === '--no-pager') i += args[i] === '-C' ? 2 : 1;
      const sub = args[i];
      if (!sub || !READ_ONLY_GIT.has(sub)) return false;
      const rest = args.slice(i + 1);
      if (rest.some((a) => /^--output|^-O|^--open-files-in-pager|^--ext-diff/.test(a))) return false;
      // `git branch NAME` creates; only listing forms are read-only.
      return sub !== 'branch' || rest.every((a) => /^-(a|r|v|vv|l|-list|-all|-remotes|-show-current|-contains|-merged|-no-merged)$/.test(a));
    }
    case 'find':
      return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a));
    case 'sed': {
      // Only `sed -n '<range>p' file…`: the first operand is the script.
      if (args.some((a) => a.startsWith('-') && a !== '-n')) return false;
      const script = args.find((a) => !a.startsWith('-'));
      return args.includes('-n') && script !== undefined && SED_PRINT_SCRIPT.test(script);
    }
    case 'sort':
      return !args.some((a) => /^-o|^--output|^--compress/.test(a));
    case 'rg':
      return !args.some((a) => /^--pre/.test(a));
    default:
      return true;
  }
}

/** A tool call that needs a person's approval (Claude hook input shape). */
export function callNeedsApproval(tool: string, input: Record<string, unknown>): boolean {
  if (!needsApproval(tool)) return false;
  if (tool === 'Bash' && typeof input.command === 'string' && isReadOnlyCommand(input.command)) return false;
  return true;
}

/** A human-readable one-liner for a tool call (Claude hook input shape). */
export function summarizeToolCall(tool: string, input: Record<string, unknown>): string {
  const str = (key: string): string | undefined => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
  const text =
    str('command') ??
    (str('file_path') ? `${tool} ${str('file_path')}` : undefined) ??
    (str('notebook_path') ? `${tool} ${str('notebook_path')}` : undefined) ??
    `${tool} ${JSON.stringify(input)}`;
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * Holds every approval a profile is waiting on. Runs driven by non-admins
 * get a gate; each side-effecting step they want to take is announced to the
 * admins and blocks until an admin allows it, the requester or an admin
 * denies it, or it times out (denied). Admins may allow the rest of the turn
 * in one click.
 */
export class ApprovalBroker {
  private readonly gates = new Map<string, { ctx: GateContext; allowTurn: boolean }>();
  private readonly pending = new Map<
    string,
    PendingApproval & { token: string; resolve: (outcome: ApprovalOutcome) => void }
  >();
  private readonly notifier: ApprovalNotifier;
  private readonly audit: AuditSink | undefined;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: { notifier: ApprovalNotifier; audit?: AuditSink; timeoutMs?: number; now?: () => number }) {
    this.notifier = opts.notifier;
    this.audit = opts.audit;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  get timeoutMinutes(): number {
    return Math.round(this.timeoutMs / 60_000);
  }

  openGate(ctx: GateContext): ApprovalGate {
    const token = randomBytes(18).toString('base64url');
    this.gates.set(token, { ctx, allowTurn: false });
    return { token, decide: (request) => this.request(token, request) };
  }

  /** A new turn on the same process: new requester / origin, and "allow this turn" ends. */
  updateGate(token: string, ctx: GateContext): void {
    if (this.gates.has(token)) this.gates.set(token, { ctx, allowTurn: false });
  }

  /** The gated process is gone: anything it was still waiting on is denied. */
  closeGate(token: string): void {
    this.gates.delete(token);
    for (const [id, p] of [...this.pending.entries()]) {
      if (p.token === token) this.settle(id, { kind: 'cancelled', reason: '这次运行已经结束' });
    }
  }

  async request(token: string, request: ApprovalRequest): Promise<ApprovalAnswer> {
    const gate = this.gates.get(token);
    if (!gate) return { decision: 'deny', reason: '这个运行没有有效的审批通道，操作已拒绝。' };
    if (request.readOnly || !needsApproval(request.tool)) return { decision: 'allow', reason: 'read-only' };
    if (gate.allowTurn) {
      this.record('auto-allowed', gate.ctx, request);
      return { decision: 'allow', reason: '管理员已允许本轮后续操作。' };
    }

    const id = randomBytes(9).toString('base64url');
    let resolve!: (outcome: ApprovalOutcome) => void;
    const settledOutcome = new Promise<ApprovalOutcome>((r) => {
      resolve = r;
    });
    const entry = { id, token, request, gate: { ...gate.ctx }, createdAt: this.now(), notices: [], resolve };
    this.pending.set(id, entry);
    this.record('requested', entry.gate, request, { approvalId: id });

    const timer = setTimeout(() => this.settle(id, { kind: 'timeout' }), this.timeoutMs);
    timer.unref?.();
    try {
      await this.notifier.announce(entry);
    } catch (err) {
      log.warn('approvals', 'announce-failed', { err: err instanceof Error ? err.message : String(err) });
      this.settle(id, { kind: 'cancelled', reason: '审批通知没能发给管理员' });
    }
    const outcome = await settledOutcome;
    clearTimeout(timer);
    if (outcome.kind === 'allowed' && outcome.allowTurn) {
      const current = this.gates.get(token);
      if (current) current.allowTurn = true;
    }
    return answerFor(outcome, this.timeoutMinutes);
  }

  /**
   * A click on an approval card. Allowing needs an admin; the requester or
   * an admin may deny.
   */
  decide(id: string, operatorId: string, action: 'allow' | 'allow-turn' | 'deny', operatorIsAdmin: boolean): DecisionResult {
    const entry = this.pending.get(id);
    if (!entry) return 'not-found';
    if (action === 'deny') {
      const byRequester = operatorId === entry.gate.actor.id;
      if (!operatorIsAdmin && !byRequester) return 'forbidden';
      this.settle(id, { kind: 'denied', by: operatorId, byRequester: byRequester && !operatorIsAdmin });
      return 'ok';
    }
    if (!operatorIsAdmin) return 'forbidden';
    this.settle(id, { kind: 'allowed', by: operatorId, allowTurn: action === 'allow-turn' });
    return 'ok';
  }

  get(id: string): PendingApproval | undefined {
    return this.pending.get(id);
  }

  /** Deny everything still waiting (shutdown). */
  cancelAll(reason: string): void {
    for (const id of [...this.pending.keys()]) this.settle(id, { kind: 'cancelled', reason });
  }

  private settle(id: string, outcome: ApprovalOutcome): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.record(outcome.kind, entry.gate, entry.request, {
      approvalId: id,
      ...('by' in outcome ? { decidedBy: outcome.by } : {}),
      ...(outcome.kind === 'allowed' && outcome.allowTurn ? { allowTurn: true } : {}),
    });
    entry.resolve(outcome);
    void this.notifier.settled(entry, outcome).catch((err) =>
      log.warn('approvals', 'settle-notice-failed', { err: err instanceof Error ? err.message : String(err) }),
    );
  }

  private record(event: string, ctx: GateContext, request: ApprovalRequest, extra: Record<string, unknown> = {}): void {
    this.audit?.append({
      kind: 'approval',
      event,
      actorId: ctx.actor.id,
      ...(ctx.actor.name ? { actorName: ctx.actor.name } : {}),
      source: ctx.source,
      scopeId: ctx.scopeId,
      ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
      agent: ctx.agent,
      tool: request.tool,
      summary: request.summary,
      ...extra,
    });
  }
}

function answerFor(outcome: ApprovalOutcome, timeoutMinutes: number): ApprovalAnswer {
  switch (outcome.kind) {
    case 'allowed':
      return { decision: 'allow', reason: '管理员已允许。' };
    case 'denied':
      return {
        decision: 'deny',
        reason: outcome.byRequester ? '发起人取消了这个操作。' : '管理员拒绝了这个操作，不要换个方式绕过它；需要的话请向用户说明。',
      };
    case 'timeout':
      return { decision: 'deny', reason: `${timeoutMinutes} 分钟内没有管理员审批，操作已拒绝。` };
    case 'cancelled':
      return { decision: 'deny', reason: `操作未执行：${outcome.reason}。` };
  }
}
