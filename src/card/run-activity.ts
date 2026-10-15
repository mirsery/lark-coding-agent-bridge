import type { RunState, ToolEntry } from './run-state';

/** 进度只展示简短说明，不展示可能包含凭据的命令正文。 */
export function runningToolLabel(state: RunState): string | undefined {
  const sub = state.subagent;
  let latest: ToolEntry | undefined;
  let parent: ToolEntry | undefined;
  for (const block of state.blocks) {
    if (block.kind !== 'tool' || block.tool.status !== 'running') continue;
    latest = block.tool;
    if (block.tool.id === sub?.parentToolUseId) parent = block.tool;
  }
  const tool = parent ?? latest;
  if (!tool) return undefined;
  const description = oneLine((tool.input as { description?: unknown } | undefined)?.description);
  const label = description ? `${description}（${tool.name}）` : `正在调用 ${tool.name}`;
  if (!parent || !sub) return label;
  const step = oneLine(sub.description) ?? (sub.tool ? `正在调用 ${sub.tool}` : undefined);
  return step ? `${label} › 子任务：${step}` : label;
}

function oneLine(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const line = raw.replace(/\s+/g, ' ').trim();
  // 中文回复只显示中文说明，英文说明退回工具名。
  if (!/[\u3400-\u9fff]/.test(line)) return undefined;
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}
