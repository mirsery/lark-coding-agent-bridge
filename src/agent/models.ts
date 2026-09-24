import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentKind } from '../config/profile-schema';
import { CODEX_EFFORT_LEVELS, EFFORT_LEVELS, type EffortLevel } from '../config/schema';

/**
 * Sentinel selection meaning "don't pass `--model`; let the agent CLI /
 * account decide". Kept as a real option value (rather than empty string)
 * because Feishu's `select_static` requires `initial_option` to match one of
 * the option `value`s exactly and rejects an empty string.
 */
export const DEFAULT_MODEL = 'default';

export interface ModelOption {
  /**
   * Stored in `preferences.model` and forwarded to the agent's `--model`
   * flag. `DEFAULT_MODEL` is special-cased to omit the flag entirely.
   */
  value: string;
  /** Human-facing label shown in the `/config` picker. */
  label: string;
}

/**
 * Claude Code models. Pinned to concrete version ids (Claude Code's `--model`
 * accepts the full model-id string, not just the `opus`/`sonnet` aliases) so
 * the picker names an exact model. Add new ids here when a generation ships;
 * `opusplan` is kept as the one alias with no versioned equivalent (it runs
 * Opus for planning and Sonnet for execution).
 */
const CLAUDE_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5（最新）' },
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5（最新）' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1（最新）' },
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5（最新）' },
  { value: 'opusplan', label: 'Opus Plan（规划用 Opus，执行用 Sonnet）' },
];

/** One entry of the Codex CLI's own model catalog. */
export interface CodexModelEntry {
  slug: string;
  label: string;
  /** Efforts the model accepts, in the CLI's order; empty when unknown. */
  efforts: EffortLevel[];
}

/**
 * Fallback when the Codex model cache can't be read (Codex never ran on this
 * machine, or the cache format moved). Mirrors the listed models of
 * codex-cli 0.156; the live cache wins whenever it is present.
 */
const CODEX_FALLBACK_CATALOG: CodexModelEntry[] = [
  { slug: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: [...CODEX_EFFORT_LEVELS] },
  { slug: 'gpt-6-sol', label: 'GPT-6-Sol', efforts: [...CODEX_EFFORT_LEVELS] },
  { slug: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: [...EFFORT_LEVELS] },
  { slug: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: [...CODEX_EFFORT_LEVELS] },
  { slug: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', efforts: [...CODEX_EFFORT_LEVELS] },
  { slug: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: [...EFFORT_LEVELS] },
  { slug: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
];

/** Where Codex keeps `models_cache.json` — the same home a profile inherits by default. */
function codexHomeDir(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/**
 * Parse Codex's `models_cache.json` into picker entries: only models the CLI
 * itself lists (`visibility: "list"`), in its priority order. Returns `[]`
 * for anything unreadable so callers fall back rather than fail.
 */
export function parseCodexModelsCache(raw: string): CodexModelEntry[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return [];
  }
  const models = (doc as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  return models
    .filter(
      (m): m is Record<string, unknown> =>
        typeof m === 'object' && m !== null && typeof (m as { slug?: unknown }).slug === 'string',
    )
    .filter((m) => m.visibility === undefined || m.visibility === 'list')
    .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))
    .map((m) => ({
      slug: m.slug as string,
      label: typeof m.display_name === 'string' && m.display_name ? m.display_name : (m.slug as string),
      efforts: Array.isArray(m.supported_reasoning_levels)
        ? (m.supported_reasoning_levels as unknown[])
            .map((l) => (typeof l === 'object' && l !== null ? (l as { effort?: unknown }).effort : l))
            .filter((e): e is EffortLevel => CODEX_EFFORT_LEVELS.includes(e as EffortLevel))
        : [],
    }));
}

let codexCatalogCache: { at: number; entries: CodexModelEntry[] } | undefined;
const CODEX_CATALOG_TTL_MS = 60_000;

/**
 * The Codex model catalog: the CLI's live cache when readable, else the
 * pinned fallback. Re-read at most once a minute, so a Codex upgrade shows
 * up in `/config` without restarting the bridge.
 */
export function codexModelCatalog(now: number = Date.now()): CodexModelEntry[] {
  if (codexCatalogCache && now - codexCatalogCache.at < CODEX_CATALOG_TTL_MS) {
    return codexCatalogCache.entries;
  }
  let entries: CodexModelEntry[] = [];
  try {
    entries = parseCodexModelsCache(readFileSync(join(codexHomeDir(), 'models_cache.json'), 'utf8'));
  } catch {
    entries = [];
  }
  if (entries.length === 0) entries = CODEX_FALLBACK_CATALOG;
  codexCatalogCache = { at: now, entries };
  return entries;
}

/** Test hook: forget the memoized Codex catalog. */
export function resetCodexModelCatalogCache(): void {
  codexCatalogCache = undefined;
}

/** Codex CLI models. Forwarded to `codex exec --model`. */
function codexModels(): ModelOption[] {
  return [
    { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
    ...codexModelCatalog().map((m) => ({ value: m.slug, label: m.label })),
  ];
}

/** The model picker options for a profile's agent kind. */
export function supportedModels(agentKind: AgentKind): ModelOption[] {
  return agentKind === 'codex' ? codexModels() : CLAUDE_MODELS;
}

/** The effort picker options for a profile's agent kind, in the CLI's order. */
export function supportedEfforts(agentKind: AgentKind): readonly EffortLevel[] {
  return agentKind === 'codex' ? CODEX_EFFORT_LEVELS : EFFORT_LEVELS;
}

/** True when the selection means "use the agent default" (no `--model`). */
export function isDefaultModel(value: string | undefined): boolean {
  return !value || value === DEFAULT_MODEL;
}

/**
 * Coerce a stored model preference into a value guaranteed to be one of the
 * current agent's picker options — Feishu's `select_static` requires
 * `initial_option` to match an option value exactly. Unknown / cross-agent
 * values (e.g. a Claude alias left over after switching a profile to Codex)
 * fall back to {@link DEFAULT_MODEL}.
 */
export function normalizeModelSelection(
  agentKind: AgentKind,
  value: string | undefined,
): string {
  if (isDefaultModel(value)) return DEFAULT_MODEL;
  return supportedModels(agentKind).some((m) => m.value === value)
    ? (value as string)
    : DEFAULT_MODEL;
}

/**
 * Resolve the concrete model string to hand the agent, or `undefined` to omit
 * the `--model` flag. Cross-agent / unknown values are treated as "default".
 */
export function resolveModelArg(
  agentKind: AgentKind,
  value: string | undefined,
): string | undefined {
  const normalized = normalizeModelSelection(agentKind, value);
  return normalized === DEFAULT_MODEL ? undefined : normalized;
}

/**
 * Resolve the concrete effort to hand the agent, or `undefined` to omit it.
 * Validated against the agent's own levels ({@link supportedEfforts}): a
 * Codex-only level such as `ultra` never reaches Claude's `--effort`.
 * Unknown levels (hand-edited config, a level a future CLI drops) fall back
 * to the CLI default rather than failing the run.
 */
export function resolveEffortArg(
  agentKind: AgentKind,
  value: string | undefined,
): EffortLevel | undefined {
  return supportedEfforts(agentKind).includes(value as EffortLevel)
    ? (value as EffortLevel)
    : undefined;
}

/**
 * Fit a Codex effort to what the chosen model accepts. Models differ
 * (e.g. GPT-5.5 stops at `xhigh`), and Codex rejects a level the model
 * lacks, so an over-high pick steps down to the model's highest supported
 * level instead of failing the run. With no explicit model (Codex config
 * decides) or a model the catalog doesn't know, the level passes through.
 */
export function clampCodexEffort(
  model: string | undefined,
  effort: EffortLevel | undefined,
  catalog: CodexModelEntry[] = codexModelCatalog(),
): EffortLevel | undefined {
  if (!effort || !model) return effort;
  const supported = catalog.find((m) => m.slug === model)?.efforts ?? [];
  if (supported.length === 0 || supported.includes(effort)) return effort;
  const rank = CODEX_EFFORT_LEVELS.indexOf(effort);
  const fitting = supported.filter((e) => CODEX_EFFORT_LEVELS.indexOf(e) <= rank);
  return fitting.length > 0 ? fitting[fitting.length - 1] : supported[0];
}

/** Picker label for a stored value, for display in the saved-config card. */
export function modelLabel(agentKind: AgentKind, value: string | undefined): string {
  const normalized = normalizeModelSelection(agentKind, value);
  return supportedModels(agentKind).find((m) => m.value === normalized)?.label ?? normalized;
}
