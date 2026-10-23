import type { SandboxMode } from '../../config/profile-schema';

export interface BuildCodexArgsInput {
  cwd: string;
  sandbox: SandboxMode;
  threadId?: string;
  images?: readonly string[];
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  /** Forwarded to `codex exec --model`. Omitted uses the Codex default. */
  model?: string;
  /**
   * Forwarded as `-c model_reasoning_effort="…"`. Omitted uses the Codex
   * config default. Callers fit it to the model first (`clampCodexEffort`).
   */
  effort?: string;
  /** Native token threshold for smart-session auto-compaction. */
  compactWindowTokens?: number;
  /** More `-c` overrides (the bridge's hook, see hooks.ts). */
  config?: readonly string[];
  /**
   * Run hooks Codex hasn't been told to trust (`--dangerously-bypass-hook-trust`):
   * the bridge's own hook, when it could not be trusted the normal way.
   */
  bypassHookTrust?: boolean;
}

/** Levels `model_reasoning_effort` may carry; anything else is dropped, never quoted into argv. */
const CODEX_REASONING_EFFORT = /^[a-z]+$/;

/** CLI override shared by exec and app-server; omission preserves native defaults. */
export function codexCompactionArgs(tokens: number | undefined): string[] {
  return tokens !== undefined && Number.isSafeInteger(tokens) && tokens > 0
    ? ['-c', `model_auto_compact_token_limit=${tokens}`]
    : [];
}

export function buildCodexArgs(input: BuildCodexArgsInput): string[] {
  if (
    input.sandbox !== 'read-only' &&
    input.sandbox !== 'workspace-write' &&
    input.sandbox !== 'danger-full-access'
  ) {
    throw new Error(`unsafe sandbox mode: ${input.sandbox}`);
  }

  const globalFlags = [
    '--sandbox',
    input.sandbox,
    ...(input.model ? ['--model', input.model] : []),
    ...(input.effort && CODEX_REASONING_EFFORT.test(input.effort)
      ? ['-c', `model_reasoning_effort="${input.effort}"`]
      : []),
    '-c',
    'approval_policy="never"',
    ...codexCompactionArgs(input.compactWindowTokens),
    '-c',
    'shell_environment_policy.inherit="all"',
    ...(input.config ?? []),
    ...(input.ignoreUserConfig === true ? ['--ignore-user-config'] : []),
    ...(input.ignoreRules === false ? [] : ['--ignore-rules']),
    '--skip-git-repo-check',
    '-C',
    input.cwd,
  ];

  const imageFlags = (input.images ?? []).flatMap((path) => ['--image', path]);

  // A top-level flag: before the subcommand.
  const topLevel = input.bypassHookTrust ? ['--dangerously-bypass-hook-trust'] : [];

  if (input.threadId) {
    return [
      ...topLevel,
      'exec',
      ...globalFlags,
      'resume',
      '--json',
      ...imageFlags,
      input.threadId,
      '-',
    ];
  }

  return [
    ...topLevel,
    'exec',
    '--json',
    ...globalFlags,
    ...imageFlags,
    ...(imageFlags.length > 0 ? ['--'] : []),
    '-',
  ];
}
