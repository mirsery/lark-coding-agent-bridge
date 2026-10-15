import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import {
  CLAUDE_DEFAULT_PERMISSION_MODE,
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
} from '../types';
import { restoredSessionCost } from './session-cost';
import { encodeUserMessage, isFailedResult, isNoTurnResult, replayedUuid, translateEvent } from './stream-json';

export interface ClaudeAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
}

type ClaudeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'claude';
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'claude',
      agentName: 'Claude Code',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for ClaudeAdapter.run');
    }

    // The prompt and bridge system prompt must NOT go through argv. On Windows,
    // `claude` resolves to a `claude.cmd` shim and cross-spawn routes it through
    // `cmd.exe /d /s /c`, which interprets `<` and `>` as redirection operators
    // — that silently eats the prompt's `<bridge_context>` XML, so claude runs
    // with an empty request and replies with its default greeting instead of a
    // stream-json response. Pass the prompt via stdin and the appended system
    // prompt via a temp file (the same approach the Codex adapter uses) so no
    // special characters ever reach the shell.
    const systemPromptFile = writeSystemPromptFile(buildBridgeSystemPrompt(this.botIdentity));

    // Streamed input keeps stdin open after the first turn: when the agent
    // leaves background tasks running, the process lives on to run the turns
    // those tasks trigger, and the bridge can hand it the next user message
    // (`send`) instead of killing that work to spawn a new process.
    // `--replay-user-messages` echoes each written message back (same uuid)
    // once the CLI actually reads it — what tells a turn that still has input
    // queued (a mid-run supplement, see `inject`) apart from the real end.
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--replay-user-messages',
      '--verbose',
      '--permission-mode',
      gatedPermissionMode(opts),
      '--append-system-prompt-file',
      systemPromptFile.path,
    ];
    // Gated runs: every tool call first goes through the bridge's approval
    // hook. A settings *file* rather than inline JSON keeps quotes off argv
    // (cmd.exe on Windows).
    const settingsFile = opts.approvals?.hookCommand
      ? writeSettingsFile(approvalHookSettings(opts.approvals.hookCommand, opts.approvals.hookTimeoutSec ?? 330))
      : undefined;
    if (settingsFile) args.push('--settings', settingsFile.path);
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);

    // Read before spawn: the session total Claude is about to restore.
    const costBaseline = opts.sessionId ? (restoredSessionCost(opts.sessionId, opts.cwd) ?? 0) : 0;
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, {
        ...buildLarkChannelEnv(this.larkChannel),
        // 会话智能压缩: Claude Code auto-compacts against this window instead
        // of the model's full (up to 1M-token) one.
        ...(opts.compactWindowTokens ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(opts.compactWindowTokens) } : {}),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ClaudeChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
      effort: opts.effort,
    });

    // Listeners MUST be attached synchronously here, before we return.
    // The 'error' and exit-related events can fire in the next tick; if we
    // defer attachment to the async-generator body, those events fire into
    // the void and the generator hangs.
    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn claude: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
      systemPromptFile.cleanup();
      settingsFile?.cleanup();
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      systemPromptFile.cleanup();
      settingsFile?.cleanup();
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    // stdin stays open only while the CLI still has background tasks: a turn
    // that ends with none left closes it, and the process exits on its own.
    const input = new ClaudeInput(child.stdin);
    let background = 0;
    const closeInput = (): void => input.close();
    child.once('exit', () => input.detach());
    input.write(opts.prompt);
    const onEvent = (evt: AgentEvent): void => {
      if (evt.type === 'background') background = evt.count;
      if (evt.type === 'done' || evt.type === 'error') {
        input.turnOver();
        if (background === 0) closeInput();
      }
    };

    // Default 5s if caller didn't specify — claude often has live
    // subprocesses (lark-cli waiting for OAuth, long Bash, etc.) and the
    // old 500ms was nowhere near enough for them to flush state before the
    // SIGKILL cascade. Callers (channel.ts, /doctor) override per-run with
    // a value derived from preferences.
    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, onEvent, costBaseline, input),
      send: (prompt) => input.write(prompt),
      inject(prompt: string, preview: string): boolean {
        const ok = input.inject(prompt, preview);
        log.info('agent', ok ? 'inject' : 'inject-refused', { pid: child.pid ?? null, promptChars: prompt.length });
        return ok;
      },
      endInput: closeInput,
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

/**
 * How long a `result` that left written input unread may be followed by
 * silence before the turn is ended anyway. The CLI starts the queued turn at
 * once; this only guards against it never doing so.
 */
const NEXT_TURN_GUARD_MS = 30_000;

/**
 * The streamed stdin of one claude process. A supplement (`inject`) carries a
 * uuid that `--replay-user-messages` echoes back once the CLI reads it: one
 * written mid tool call is read at the next tool boundary and folded into the
 * same turn, one written as the turn wraps up gets a turn of its own. So a
 * `result` while a supplement is still unread is not the end of the bridge's
 * turn — the CLI has another one queued for it.
 */
class ClaudeInput {
  /** uuid → preview of each supplement written but not yet read. */
  private readonly unread = new Map<string, string>();
  private open = true;
  /** A user turn is under way: what `inject` may add to. */
  private turn = false;

  constructor(private readonly stdin: Writable) {}

  /** Start a turn with `prompt` (the run's first, or a later `send`). */
  write(prompt: string): boolean {
    if (!this.writable()) return false;
    this.stdin.write(encodeUserMessage(prompt), 'utf8');
    this.turn = true;
    return true;
  }

  /** Add to the turn under way; refused once that turn has ended. */
  inject(prompt: string, preview: string): boolean {
    if (!this.turn || !this.writable()) return false;
    const uuid = randomUUID();
    this.unread.set(uuid, preview);
    this.stdin.write(encodeUserMessage(prompt, uuid), 'utf8');
    return true;
  }

  private writable(): boolean {
    return this.open && !this.stdin.destroyed && !this.stdin.writableEnded;
  }

  /** A replayed message was read; returns its preview when it was a supplement. */
  ack(uuid: string): string | undefined {
    const preview = this.unread.get(uuid);
    this.unread.delete(uuid);
    return preview;
  }

  get unreadCount(): number {
    return this.unread.size;
  }

  /** The bridge's turn ended (`done` / `error` went out). */
  turnOver(): void {
    this.turn = false;
    this.unread.clear();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.turn = false;
    if (!this.stdin.destroyed && !this.stdin.writableEnded) this.stdin.end();
  }

  /** The process is gone: refuse further writes without touching the pipe. */
  detach(): void {
    this.open = false;
    this.turn = false;
  }
}

async function* createEventStream(
  child: ClaudeChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  onEvent: (evt: AgentEvent) => void,
  costBaseline: number,
  input: ClaudeInput,
): AsyncGenerator<AgentEvent> {
  // If fork itself failed synchronously, child.pid is undefined. The 'error'
  // event (ENOENT etc.) fires in the next tick, so also check getError().
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn claude: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);
  // A no-turn result (see isNoTurnResult) is held back: yielding it as `done`
  // ends the run ~2s in and the post-done reap kills the turn that actually
  // carries the user's prompt. Replayed only if no real result follows.
  let heldResult: AgentEvent[] | undefined;
  // `total_cost_usd` is the session's running total: restored on resume, then
  // accumulated over every turn a streamed-input process runs. Report each
  // turn's own share. A total below the baseline means Claude restored
  // nothing, so count from zero rather than report a free turn.
  let costSoFar = costBaseline;
  const perTurnCost = (evt: Extract<AgentEvent, { type: 'usage' }>): AgentEvent => {
    if (evt.costUsd === undefined) return evt;
    if (evt.costUsd < costSoFar) costSoFar = 0;
    const turnCost = evt.costUsd - costSoFar;
    costSoFar = evt.costUsd;
    return { ...evt, costUsd: turnCost };
  };
  // A `result` that left a supplement unread is not the end of the bridge's
  // turn: its `done` waits here for the turn the CLI runs next. If that turn
  // never starts, the guard lets the `done` go out anyway.
  let deferredDone: AgentEvent | undefined;
  let guard: ReturnType<typeof setTimeout> | undefined;
  const clearGuard = (): void => {
    if (guard) clearTimeout(guard);
    guard = undefined;
  };
  const lines = rl[Symbol.asyncIterator]();
  // A read the guard raced past stays pending; the next round awaits it
  // rather than asking for another line (which would skip this one).
  let pendingLine: Promise<IteratorResult<string>> | undefined;
  try {
    for (;;) {
      pendingLine ??= lines.next();
      const next = deferredDone
        ? await Promise.race([
            pendingLine,
            new Promise<'guard'>((resolve) => {
              guard = setTimeout(() => resolve('guard'), NEXT_TURN_GUARD_MS);
            }),
          ])
        : await pendingLine;
      clearGuard();
      if (next === 'guard') {
        log.warn('agent', 'next-turn-guard-expired', { pid: child.pid ?? null, unread: input.unreadCount });
        const done = deferredDone!;
        deferredDone = undefined;
        onEvent(done);
        yield done;
        continue;
      }
      pendingLine = undefined;
      if (next.done) break;
      sawStdout = true;
      const trimmed = next.value.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const replayed = replayedUuid(parsed);
      if (replayed !== undefined) {
        const preview = input.ack(replayed);
        if (preview !== undefined) {
          const evt: AgentEvent = { type: 'supplement', preview };
          onEvent(evt);
          yield evt;
        }
        continue;
      }
      if (isNoTurnResult(parsed)) {
        heldResult = [...translateEvent(parsed)];
        continue;
      }
      const moreInput = input.unreadCount > 0 && !isFailedResult(parsed);
      for (const raw of translateEvent(parsed)) {
        const evt = raw.type === 'usage' ? perTurnCost(raw) : raw;
        if (evt.type === 'done') {
          heldResult = undefined;
          if (moreInput) {
            log.info('agent', 'turn-result-more-input', { pid: child.pid ?? null, unread: input.unreadCount });
            deferredDone = evt;
            continue;
          }
          deferredDone = undefined;
        }
        onEvent(evt);
        yield evt;
      }
    }
  } finally {
    clearGuard();
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }
  if (heldResult) yield* heldResult;
  // The process ended before the turn its unread input was queued for.
  if (deferredDone) yield deferredDone;

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield {
      type: 'error',
      message: `claude runtime error: ${earlyRuntimeError.message}`,
      terminationReason: 'failed',
    };
    return;
  }

  // When the child is killed by a signal, exitCode stays null and signalCode
  // carries the name. Both must be checked or we'll attach an 'exit' listener
  // for an event that already fired and hang forever.
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield {
      type: 'error',
      message: `claude exited with code ${exitCode}${detail}`,
      terminationReason: 'failed',
    };
  } else if (runtimeError) {
    yield {
      type: 'error',
      message: `claude runtime error: ${runtimeError.message}`,
      terminationReason: 'failed',
    };
  }
}

/**
 * Persist the appended system prompt to a throwaway temp file so it can be
 * passed via `--append-system-prompt-file` instead of argv. Returns the path
 * plus an idempotent, best-effort cleanup that removes the temp directory.
 */
function writeSystemPromptFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-claude-'));
  const path = join(dir, 'append-system-prompt.md');
  writeFileSync(path, content, 'utf8');
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: the OS will reclaim the temp dir eventually
      }
    },
  };
}

/** A gated run whose approval hook could not be set up stays read-only (plan mode). */
function gatedPermissionMode(opts: AgentRunOptions): string {
  if (opts.approvals && !opts.approvals.hookCommand) return 'plan';
  return opts.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE;
}

/** Claude Code settings that route every tool call through the approval hook. */
export function approvalHookSettings(command: string, timeoutSec: number): object {
  return {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: timeoutSec }] }],
    },
  };
}

function writeSettingsFile(settings: object): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-claude-settings-'));
  const path = join(dir, 'settings.json');
  writeFileSync(path, JSON.stringify(settings), { encoding: 'utf8', mode: 0o600 });
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
