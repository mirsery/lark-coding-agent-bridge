import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';

// Where the bridge finds a Codex call its PreToolUse hook blocked: such a call
// never becomes an item, and the hook's notification names only its id.

/** A Codex tool call as cards and the audit show it. */
export interface CodexCall {
  name: string;
  input: Record<string, unknown>;
}

// The call was recorded just before its hook ran: it sits near the end.
const TAIL_BYTES = 1 << 20;

/**
 * Call `callId` as the thread's rollout recorded it, named the way the
 * translators name Codex's steps; undefined when it isn't there. Codex writes
 * a call to the rollout before its PreToolUse hook runs, so a call the hook
 * blocked — which never becomes an item — can still be shown.
 */
export function rolloutCall(rollout: string, callId: string): CodexCall | undefined {
  let fd: number;
  try {
    fd = openSync(rollout, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    for (const from of size > TAIL_BYTES ? [size - TAIL_BYTES, 0] : [0]) {
      const buffer = Buffer.alloc(size - from);
      readSync(fd, buffer, 0, buffer.length, from);
      const text = buffer.toString('utf8');
      if (!text.includes(callId)) continue;
      for (const line of text.split('\n').reverse()) {
        if (!line.includes(callId)) continue;
        let payload: Record<string, unknown> | undefined;
        try {
          payload = record(record(JSON.parse(line))?.payload);
        } catch {
          continue;
        }
        if (payload?.call_id !== callId) continue;
        const name = typeof payload.name === 'string' ? payload.name : undefined;
        if (payload.type === 'custom_tool_call') return codexCall(name ?? 'tool', { input: payload.input });
        if (payload.type === 'function_call') return codexCall(name ?? 'tool', parseArguments(payload.arguments));
        if (payload.type === 'local_shell_call') {
          const action = record(payload.action) ?? {};
          return codexCall('shell', { command: action.command, workdir: action.working_directory });
        }
      }
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Call `callId` as the bridge's hook logged it when refusing it
 * (`LARK_CHANNEL_HOOK_REFUSALS`, one JSON line per refusal) — the only record
 * of a call a code-mode cell made, which the rollout never has.
 */
export function refusedCall(log: string, callId: string): CodexCall | undefined {
  let text: string;
  try {
    text = readFileSync(log, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of text.split('\n').reverse()) {
    if (!line.includes(callId)) continue;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (entry?.id !== callId || typeof entry.tool !== 'string') continue;
    const input = record(entry.input) ?? {};
    // Hook tool names: the shell is `Bash`, its command `command`; a patch's text is `command` too.
    if (entry.tool === 'Bash') return { name: 'command_execution', input: { command: String(input.command ?? '') } };
    if (entry.tool === 'apply_patch') return codexCall('apply_patch', { input: input.command });
    return codexCall(entry.tool, input);
  }
  return undefined;
}

/** Codex's tool and arguments as the bridge's step: shell runs and patches read as the items they'd have become. */
export function codexCall(name: string, args: Record<string, unknown>): CodexCall {
  const workdir = typeof args.workdir === 'string' && args.workdir ? args.workdir : undefined;
  const script = typeof args.cmd === 'string' ? args.cmd : Array.isArray(args.command) ? args.command.map(String).join(' ') : undefined;
  if (script !== undefined) {
    return { name: 'command_execution', input: { command: workdir ? `cd ${workdir} && ${script}` : script } };
  }
  if (name === 'apply_patch') return { name: 'file_change', input: { paths: patchPaths(String(args.input ?? '')) } };
  if (name === 'view_image' && typeof args.path === 'string') return { name, input: { file_path: args.path } };
  return { name, input: args };
}

/** Files an `apply_patch` patch adds, updates, deletes or moves to. */
function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const header = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/.exec(line);
    if (header?.[1]) paths.push(header[1].trim());
  }
  return paths;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return record(value) ?? {};
  try {
    return record(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
