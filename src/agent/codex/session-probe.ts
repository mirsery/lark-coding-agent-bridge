import { join } from 'node:path';
import { linesBackward } from '../../utils/reverse-lines';
import { extractOwnerDmIdentity, extractUserInputText } from '../prompt';
import type { AgentSessionProbe } from '../session-probe';
import { findRollout } from './thread-usage';

const TOKEN_COUNT = Buffer.from('"token_count"');
const USER_ROLE = Buffer.from('"role":"user"');
const USER_INPUT = Buffer.from('<user_input>');
const TASK_STARTED = Buffer.from('"task_started"');
const TASK_COMPLETE = Buffer.from('"task_complete"');
const MAX_SCAN_BYTES = 16 * 1024 * 1024;

interface RolloutRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: {
    type?: unknown;
    role?: unknown;
    last_agent_message?: unknown;
    content?: unknown;
    info?: { last_token_usage?: { input_tokens?: unknown } } | null;
  };
}

/**
 * Last model call (time and prompt size) and last user request of a Codex
 * thread, read backwards from its rollout
 * (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl`).
 */
export async function probeCodexSession(codexHome: string, threadId: string): Promise<AgentSessionProbe | undefined> {
  const file = await findRollout(join(codexHome, 'sessions'), threadId);
  if (!file) return undefined;
  const probe: AgentSessionProbe = {};
  let haveCall = false;
  let latestTask = true;
  let turnAnswer: string | undefined;
  for (const line of linesBackward(file, { maxBytes: MAX_SCAN_BYTES })) {
    if (!haveCall && line.includes(TOKEN_COUNT)) {
      const rec = parse(line);
      const input = rec?.payload?.type === 'token_count' ? rec.payload.info?.last_token_usage?.input_tokens : undefined;
      if (typeof input === 'number' && input > 0) {
        probe.contextTokens = input;
        const at = typeof rec?.timestamp === 'string' ? Date.parse(rec.timestamp) : Number.NaN;
        if (Number.isFinite(at)) probe.lastActivityAt = at;
        haveCall = true;
      }
    } else if (latestTask && line.includes(TASK_COMPLETE)) {
      const turn = parse(line);
      const answer = turn?.type === 'event_msg' && turn.payload?.type === 'task_complete'
        ? turn.payload.last_agent_message : undefined;
      if (typeof answer === 'string') turnAnswer ??= answer;
    } else if (latestTask && line.includes(TASK_STARTED)) {
      const turn = parse(line);
      if (turn?.type === 'event_msg' && turn.payload?.type === 'task_started') latestTask = false;
    } else if (line.includes(USER_ROLE) && line.includes(USER_INPUT)) {
      const rec = parse(line);
      if (rec?.type === 'response_item' && rec.payload?.type === 'message' && rec.payload.role === 'user') {
        const input = bridgeInput(rec.payload.content);
        if (input) {
          probe.lastUserText = input.request;
          const identity = latestTask ? extractOwnerDmIdentity(input.prompt) : undefined;
          if (identity) probe.ownerDm = { ...identity, answer: turnAnswer };
          break;
        }
      }
    }
  }
  return haveCall || probe.lastUserText ? probe : undefined;
}

function parse(line: Buffer): RolloutRecord | undefined {
  try {
    return JSON.parse(line.toString('utf8')) as RolloutRecord;
  } catch {
    return undefined;
  }
}

function bridgeInput(content: unknown): { prompt: string; request: string } | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown };
    if (b?.type !== 'input_text' || typeof b.text !== 'string') continue;
    const request = extractUserInputText(b.text);
    if (request) return { prompt: b.text, request };
  }
  return undefined;
}
