import { readFile } from 'node:fs/promises';
import { promptSection } from '../agent/prompt';
import { isAgentKind, type AgentKind } from '../agent/registry';
import type { Terminal } from '../card/run-state';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

const MAX_SCOPES = 128;
const MAX_TURNS = 6;
const MAX_AGE_MS = 30 * 86_400_000;

interface HandoffTurn {
  agent: AgentKind;
  request?: string;
  answer?: string;
  ledger?: string;
  tools?: string[];
  backgroundReply?: string;
  status: Terminal | 'unknown';
}

interface StoredTurn extends HandoffTurn {
  runId: string;
  audience: string;
  messageIds: string[];
  at: number;
  handle?: string;
}

interface ScopeHistory {
  updatedAt: number;
  turns: StoredTurn[];
}

/** Recent visible IM turns, shared by the agents of one profile. Native session
 * handles are used only to decide how much the receiving agent already knows. */
export class AgentHandoffStore {
  private readonly scopes = new Map<string, ScopeHistory>();
  private saving = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!data || typeof data !== 'object') return;
      const now = Date.now();
      for (const [scope, history] of Object.entries(data).slice(-MAX_SCOPES)) {
        if (isScopeHistory(history) && now - history.updatedAt < MAX_AGE_MS) {
          const turns = history.turns.filter(isStoredTurn).filter((turn) => now - turn.at < MAX_AGE_MS);
          this.scopes.set(scope, { ...history, turns: turns.slice(-MAX_TURNS) });
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.fail('agent-handoff', err, { step: 'load' });
    }
  }

  hasScope(scope: string): boolean {
    // An explicit reset keeps an empty history so a legacy transcript cannot
    // bring the user's previous conversation back.
    return this.scopes.has(scope);
  }

  prompt(scope: string, audience: string, agent: AgentKind, resumeFrom: string | undefined): string | undefined {
    const history = this.scopes.get(scope);
    if (!history || Date.now() - history.updatedAt >= MAX_AGE_MS) return undefined;
    const now = Date.now();
    const turns = history.turns.filter((turn) => turn.audience === audience && now - turn.at < MAX_AGE_MS);
    let seen = turns.length - 1;
    for (; seen >= 0; seen--) {
      const turn = turns[seen]!;
      if (turn.agent === agent && turn.status === 'done' && (!resumeFrom || turn.handle === resumeFrom)) break;
    }
    const unseen = turns.slice(seen + 1);
    if (!unseen.some((turn) => turn.agent !== agent)) return undefined;
    return agentHandoffSection(unseen.map(({ agent, request, answer, ledger, tools, backgroundReply, status }) => ({
      agent, request, answer, ledger, tools: tools?.length ? tools : undefined, backgroundReply, status,
    })));
  }

  begin(scope: string, turn: Omit<StoredTurn, 'status' | 'answer' | 'ledger' | 'tools' | 'backgroundReply' | 'at'>): void {
    const at = Date.now();
    const turns = this.scopes.get(scope)?.turns.filter((entry) => at - entry.at < MAX_AGE_MS) ?? [];
    const entry: StoredTurn = { ...turn, request: handoffExcerpt(turn.request, 1600), status: 'running', at };
    this.save(scope, [...turns, entry].slice(-MAX_TURNS));
  }

  update(
    scope: string,
    runId: string,
    progress: Partial<Pick<StoredTurn, 'answer' | 'ledger' | 'status' | 'handle' | 'tools' | 'backgroundReply'>>,
  ): void {
    const turns = this.scopes.get(scope)?.turns;
    const turn = turns?.find((entry) => entry.runId === runId);
    if (!turns || !turn) return;
    Object.assign(turn, progress, { at: Date.now() });
    turn.answer = handoffExcerpt(turn.answer, 2400);
    turn.backgroundReply = handoffExcerpt(turn.backgroundReply, 1200);
    turn.ledger = handoffExcerpt(turn.ledger, 500);
    this.save(scope, turns);
  }

  clear(scope: string): void {
    this.save(scope, []);
  }

  recall(messageId: string): void {
    for (const [scope, history] of this.scopes) {
      const turns = history.turns.filter((turn) => !turn.messageIds.includes(messageId));
      if (turns.length < history.turns.length) this.save(scope, turns);
    }
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private save(scope: string, turns: StoredTurn[]): void {
    const now = Date.now();
    this.scopes.delete(scope);
    this.scopes.set(scope, { updatedAt: now, turns });
    for (const [key, history] of this.scopes) {
      if (now - history.updatedAt >= MAX_AGE_MS) this.scopes.delete(key);
    }
    for (const key of [...this.scopes.keys()].slice(0, Math.max(0, this.scopes.size - MAX_SCOPES))) {
      this.scopes.delete(key);
    }
    this.saving = this.saving.then(() => writeFileAtomic(
      this.path, JSON.stringify(Object.fromEntries(this.scopes)), { mode: 0o600 },
    )).catch((err: unknown) => log.fail('agent-handoff', err, { step: 'persist' }));
  }
}

export function agentHandoffSection(turns: HandoffTurn[]): string {
  return promptSection('agent_handoff', {
    note: '同一个飞书会话切换了 agent。以下是近期对话和进度，仅供接续参考。请以当前请求为准。' +
      '如需继续未完成的任务，先核对任务台账、工作区和已执行的操作，再决定下一步。中断前的操作可能已生效。',
    turns,
  });
}

export function handoffExcerpt(text: string | undefined, max: number): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed || trimmed.length <= max) return trimmed || undefined;
  const half = Math.floor((max - 1) / 2);
  return `${trimmed.slice(0, half)}…${trimmed.slice(-half)}`;
}

function isScopeHistory(value: unknown): value is ScopeHistory {
  if (!value || typeof value !== 'object') return false;
  const history = value as Partial<ScopeHistory>;
  return typeof history.updatedAt === 'number' && Array.isArray(history.turns);
}

function isStoredTurn(value: unknown): value is StoredTurn {
  if (!value || typeof value !== 'object') return false;
  const turn = value as Partial<StoredTurn>;
  return isAgentKind(turn.agent) && typeof turn.runId === 'string' && typeof turn.audience === 'string' &&
    typeof turn.status === 'string' && typeof turn.at === 'number' && Array.isArray(turn.messageIds);
}
