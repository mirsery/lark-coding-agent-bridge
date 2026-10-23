#!/usr/bin/env node
// Codex PreToolUse hook that lark-channel-bridge installs on Codex runs. Every
// hooked run gets this one command (src/agent/codex/hooks.ts), so Codex has to
// trust it only once; what it does comes from the run's environment:
//
// - LARK_CHANNEL_GUARD (a run the bot owner didn't start): the guest guard of
//   bin/bridge-guard.mjs, Codex's tools read as the Claude ones it checks.
//   `Bash` runs where the call's `workdir` says, which the hook input leaves
//   out. A call the model made directly is in the session transcript by now,
//   `workdir` and all; one a code-mode cell (`exec`) made is not, so it is
//   judged as run in the session directory and pinned there (`updatedInput`
//   with `cd <dir> &&` in front — the cell's `workdir` no longer matters).
//   `apply_patch` writes every file its patch adds, updates, deletes or moves
//   to; `view_image` reads its `path`.
//   Refused calls are logged to LARK_CHANNEL_HOOK_REFUSALS when set.
// - LARK_CHANNEL_READ_HOOK (the owner's runs): the knowledge library's skill
//   Read hook, handed each SKILL.md a shell command names — Codex reads files
//   with the shell. Never blocks.
//
// The input is Claude-shaped (`tool_name`, `tool_input`, `cwd`) plus
// `transcript_path` and `tool_use_id`. Exit 2 with the reason on stderr
// refuses the call; a pinned call is allowed as rewritten through stdout
// (an allow does not skip Codex's own approvals). Changes to how calls are
// read here go through the guard replay too: docs/dev/guard-replay.md.

import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { decide, refusal } from './bridge-guard.mjs';

// The call was appended just before the hook ran: it sits near the end.
const TAIL_BYTES = 1 << 20;

const expandHome = (path) => path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());
const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Files an `apply_patch` patch touches, each with the lines it adds there. */
export function patchFiles(patch) {
  const files = [];
  let current;
  for (const line of String(patch ?? '').split(/\r?\n/)) {
    const header = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/.exec(line);
    if (header) {
      current = { path: header[1].trim(), content: '' };
      files.push(current);
    } else if (current && line.startsWith('+')) {
      current.content += `${line.slice(1)}\n`;
    }
  }
  return files;
}

/** The arguments of call `id` as the transcript recorded them, or undefined. */
function findCall(transcript, id) {
  let fd;
  try {
    fd = openSync(transcript, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    for (const from of size > TAIL_BYTES ? [size - TAIL_BYTES, 0] : [0]) {
      const buffer = Buffer.alloc(size - from);
      readSync(fd, buffer, 0, buffer.length, from);
      const text = buffer.toString('utf8');
      if (!text.includes(id)) continue;
      for (const line of text.split('\n').reverse()) {
        if (!line.includes(id)) continue;
        let payload;
        try {
          payload = JSON.parse(line)?.payload;
        } catch {
          continue;
        }
        if (payload?.call_id !== id) continue;
        if (payload.type === 'function_call') {
          try {
            const args = JSON.parse(payload.arguments ?? '{}');
            return args && typeof args === 'object' ? args : undefined;
          } catch {
            return undefined;
          }
        }
        if (payload.type === 'local_shell_call') return { workdir: payload.action?.working_directory };
        if (payload.type === 'custom_tool_call') return {};
      }
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Arguments of the call this hook runs for, as the transcript has them;
 * undefined for a call a code-mode cell made (never written there).
 */
export async function callArguments(input) {
  const transcript = input?.transcript_path;
  const id = input?.tool_use_id;
  if (typeof transcript !== 'string' || typeof id !== 'string' || !id) return undefined;
  return findCall(transcript, id);
}

/** Where a shell call runs: its `workdir`, else the session directory. */
function workdirOf(args, cwd) {
  const workdir = typeof args?.workdir === 'string' ? args.workdir.trim() : '';
  return workdir ? resolve(cwd, expandHome(workdir)) : cwd;
}

/**
 * The Claude tool calls a Codex call amounts to, for bridge-guard's `decide`.
 * A shell call whose directory is unknown comes back `pinned`: checked, and
 * then run, as a `cd` to the session directory first.
 */
export async function claudeCalls(input, lookup = callArguments) {
  const toolInput = input?.tool_input ?? {};
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  switch (input?.tool_name) {
    case 'Bash': {
      const command = String(toolInput.command ?? '');
      const args = await lookup(input);
      if (!args) return [{ toolName: 'Bash', toolInput: { command: `cd ${shellQuote(cwd)} && ${command}` }, cwd, pinned: true }];
      const workdir = workdirOf(args, cwd);
      // Running somewhere else is a `cd` there first: the guard checks the
      // place itself and reads relative paths against it.
      const scripted = workdir === cwd ? command : `cd ${shellQuote(workdir)} && ${command}`;
      return [{ toolName: 'Bash', toolInput: { command: scripted }, cwd: workdir }];
    }
    case 'apply_patch':
      return patchFiles(toolInput.command).map((file) => ({
        toolName: 'Write',
        toolInput: { file_path: file.path, content: file.content },
        cwd,
      }));
    case 'view_image':
      return [{ toolName: 'Read', toolInput: { file_path: toolInput.path }, cwd }];
    default:
      return [];
  }
}

/**
 * What the guard makes of the Codex call: `{ refuse }` with the reason,
 * `{ command }` when it may run only as that command (pinned), or null when
 * it may run as it is.
 */
export async function review(input, cfg, lookup = callArguments) {
  const calls = await claudeCalls(input, lookup);
  for (const call of calls) {
    const reason = decide(call.toolName, call.toolInput, cfg, call.cwd);
    if (reason) return { refuse: reason };
  }
  const pinned = calls.find((call) => call.pinned);
  return pinned ? { command: pinned.toolInput.command } : null;
}

/** SKILL.md files a shell command names, home expanded, maybe relative. */
export function skillFiles(command) {
  const words = String(command ?? '').split(/[\s;|&<>()'"`]+/);
  return [...new Set(words.filter((word) => /(?:^|\/)SKILL\.md$/.test(word)).map(expandHome))];
}

/** Hand each SKILL.md the command reads to the skill Read hook, as Claude's Read would. */
async function readSkills(readHook, input) {
  const files = skillFiles(input?.tool_input?.command);
  if (files.length === 0) return;
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const base = files.every((file) => isAbsolute(file)) ? cwd : workdirOf(await callArguments(input), cwd);
  for (const path of files.map((file) => resolve(base, file))) {
    spawnSync(readHook, {
      shell: true,
      input: JSON.stringify({ ...input, tool_name: 'Read', tool_input: { file_path: path } }),
      stdio: ['pipe', 'ignore', 'inherit'],
      timeout: 110_000,
    });
  }
}

/**
 * Note the refused call where the bridge looks it up for the card
 * (`LARK_CHANNEL_HOOK_REFUSALS`): Codex reports a blocked call by id only.
 */
function logRefusal(input) {
  const log = process.env.LARK_CHANNEL_HOOK_REFUSALS;
  if (!log) return;
  try {
    const entry = { id: input?.tool_use_id, tool: input?.tool_name, input: input?.tool_input };
    appendFileSync(log, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // The card misses the call's name; the refusal itself stands.
  }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return 0;
  }
  const guardEnv = process.env.LARK_CHANNEL_GUARD;
  if (guardEnv) {
    let cfg = {};
    try {
      cfg = JSON.parse(guardEnv);
    } catch {
      cfg = {};
    }
    const verdict = await review(input, cfg);
    if (verdict?.refuse) {
      logRefusal(input);
      process.stderr.write(refusal(verdict.refuse, cfg));
      return 2;
    }
    if (verdict?.command) {
      const updatedInput = { ...input.tool_input, command: verdict.command };
      const decision = { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput };
      process.stdout.write(JSON.stringify({ hookSpecificOutput: decision }));
    }
  }
  const readHook = process.env.LARK_CHANNEL_READ_HOOK;
  if (readHook && input?.tool_name === 'Bash') await readSkills(readHook, input);
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().then((code) => process.exit(code));
}
