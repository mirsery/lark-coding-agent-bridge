import type { RunState, ToolEntry } from './run-state';

const LABEL_MAX = 40;
const HAN_RE = /\p{Script=Han}/u;

/**
 * Short label for the tool the agent is waiting on, for the running footer.
 *
 * Uses the agent's own one-line `description` (Bash and Agent take one) and
 * never the raw command: commands carry hosts, tokens and passwords, and the
 * footer shows even when tool calls are hidden. The description is shown only
 * when it is Chinese — the agent is told to write it in Chinese but doesn't
 * always, and an English line on a Chinese card is exactly what the caller
 * should not see. Otherwise the tool name alone still says which kind of wait
 * this is.
 */
export function runningToolLabel(state: RunState): string | undefined {
  let latest: ToolEntry | undefined;
  for (const block of state.blocks) {
    if (block.kind === 'tool' && block.tool.status === 'running') latest = block.tool;
  }
  if (!latest) return undefined;
  const description = toolDescription(latest.input);
  if (description && HAN_RE.test(description)) return `${description}（${latest.name}）`;
  return `正在调用 ${latest.name}`;
}

function toolDescription(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = (input as { description?: unknown }).description;
  if (typeof raw !== 'string') return undefined;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (!oneLine) return undefined;
  return oneLine.length > LABEL_MAX ? `${oneLine.slice(0, LABEL_MAX)}…` : oneLine;
}
