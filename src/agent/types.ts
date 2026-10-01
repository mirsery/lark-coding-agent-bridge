import type { AgentAvailability } from './preflight';
import type { ClaudePermissionMode, CodexSandboxMode } from '../config/permissions';

export type { ClaudePermissionMode } from '../config/permissions';

export type AgentEvent =
  | { type: 'system'; sessionId?: string; threadId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'final_text'; content: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | {
      /**
       * One turn's consumption. `inputTokens` is the whole prompt, the cached
       * part (`cachedInputTokens`) included; `costUsd` is this turn's share
       * (an estimate on subscription logins).
       */
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
    }
  | {
      type: 'done';
      sessionId?: string;
      threadId?: string;
      terminationReason: 'normal' | 'interrupted' | 'timeout';
    }
  | { type: 'error'; message: string; terminationReason: 'failed' | 'interrupted' | 'timeout' }
  /**
   * How many background tasks (backgrounded shell commands, background
   * sub-agents, monitors) the agent process currently has running. While it
   * is above zero after a `done`, the process is still working and will run
   * further turns on its own as those tasks report back.
   */
  | { type: 'background'; count: number };

export const CLAUDE_DEFAULT_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';

/**
 * Present on runs driven by someone who is not an admin: every
 * side-effecting step must be approved first. Each adapter wires it the way
 * its CLI allows — a PreToolUse hook command (Claude) or answering the CLI's
 * own approval requests (Codex app-server).
 */
export interface RunApprovals {
  hookCommand?: string;
  /** How long a hook may block waiting for a decision. */
  hookTimeoutSec?: number;
  decide(request: { tool: string; summary: string; readOnly?: boolean }): Promise<{ decision: 'allow' | 'deny'; reason: string }>;
}

export interface AgentRunOptions {
  runId: string;
  prompt: string;
  cwd?: string;
  sessionId?: string;
  threadId?: string;
  model?: string;
  /**
   * Reasoning effort for adapters whose CLI exposes one (Claude Code's
   * `--effort`, Codex's `model_reasoning_effort`). Adapters without the
   * concept ignore it.
   */
  effort?: string;
  images?: readonly string[];
  sandbox?: CodexSandboxMode;
  permissionMode?: ClaudePermissionMode;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
  */
  stopGraceMs?: number;
  approvals?: RunApprovals;
}

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * stream-json `result` line arrives before claude has actually closed
   * stdout — there's a brief telemetry/cleanup tail in between. Calling
   * stop() in that window forces a SIGTERM and the run exits with code
   * 143 instead of 0; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
  /**
   * Hand the still-running process another user message, as the next turn.
   * Only offered by adapters whose CLI accepts streamed input; returns false
   * once the process no longer takes input (it closed stdin after a turn with
   * no background tasks left, or exited), in which case the caller spawns a
   * fresh run instead.
   */
  send?(prompt: string): boolean;
  /**
   * No more turns are coming: close the process's input so it exits on its
   * own. Offered by adapters whose processes otherwise stay up between turns.
   */
  endInput?(): void;
}

/**
 * The bridge bot's own IM identity, resolved by the channel after the WS
 * handshake (`/open-apis/bot/v3/info`). Injected into adapters so the agent
 * system prompt can state "this open_id is you" with the real value.
 */
export interface AgentBotIdentity {
  openId: string;
  name?: string;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  prepareRun?(opts: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;
  /**
   * Late-bound identity injection: the adapter is constructed before the
   * channel connects, so the channel calls this once botIdentity is known.
   * Adapters that don't bake identity into their prompts may omit it.
   */
  setBotIdentity?(identity: AgentBotIdentity): void;
}
