import { git, isSafeRef } from './exec';

export type DiffTarget =
  /** Everything uncommitted: staged and unstaged, against HEAD. */
  | { kind: 'worktree' }
  /** Only what is staged. */
  | { kind: 'staged' }
  /** What this branch adds relative to `ref` (three-dot, from the merge base). */
  | { kind: 'ref'; ref: string };

export interface DiffFileStat {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
}

export interface DiffSummary {
  target: DiffTarget;
  files: DiffFileStat[];
  added: number;
  removed: number;
  /** Untracked files — invisible to `git diff`, but part of "what changed". */
  untracked: string[];
}

export function parseDiffTarget(input: string): DiffTarget | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { kind: 'worktree' };
  if (trimmed === 'staged' || trimmed === '--staged' || trimmed === '--cached') {
    return { kind: 'staged' };
  }
  if (!isSafeRef(trimmed)) return { error: `不是合法的 ref：${trimmed}` };
  return { kind: 'ref', ref: trimmed };
}

/** The `git diff` arguments for a target, minus the output-shape flags. */
function rangeArgs(target: DiffTarget): string[] {
  if (target.kind === 'staged') return ['--cached'];
  if (target.kind === 'ref') return [`${target.ref}...`];
  return ['HEAD'];
}

export function describeDiffTarget(target: DiffTarget): string {
  if (target.kind === 'staged') return '已暂存的改动';
  if (target.kind === 'ref') return `相对 \`${target.ref}\` 的分支改动`;
  return '未提交的改动';
}

/**
 * Per-file add/remove counts for a target.
 *
 * Returns `undefined` when git refused the request — an unknown ref, or a
 * directory that is not a repository. The caller turns that into a message
 * rather than an empty diff, which would read as "nothing changed".
 */
export async function readDiffStat(
  cwd: string,
  target: DiffTarget,
): Promise<DiffSummary | { error: string }> {
  const result = await git(cwd, ['diff', '--numstat', '--no-color', ...rangeArgs(target)]);
  if (!result.ok) {
    return { error: result.stderr || 'git diff 执行失败' };
  }

  const files: DiffFileStat[] = [];
  let added = 0;
  let removed = 0;
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [a, r, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!path) continue;
    // git prints "-" for both counts on binary files.
    const binary = a === '-' || r === '-';
    const addedCount = binary ? 0 : Number(a ?? 0);
    const removedCount = binary ? 0 : Number(r ?? 0);
    files.push({ path, added: addedCount, removed: removedCount, binary });
    added += addedCount;
    removed += removedCount;
  }

  // Untracked files only matter for the working-tree view; a ref comparison is
  // about committed content.
  let untracked: string[] = [];
  if (target.kind === 'worktree') {
    const ls = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
    if (ls.ok) untracked = ls.stdout.split('\n').filter(Boolean);
  }

  return { target, files, added, removed, untracked };
}

export interface DiffPatch {
  patch: string;
  /** True when the patch was cut short by the byte cap. */
  truncated: boolean;
}

/** Full unified patch for a target, capped so a huge branch cannot eat memory. */
export async function readDiffPatch(
  cwd: string,
  target: DiffTarget,
  maxBytes = 1024 * 1024,
): Promise<DiffPatch | { error: string }> {
  const result = await git(
    cwd,
    ['diff', '--no-color', '--patch', ...rangeArgs(target)],
    { maxBytes, timeoutMs: 20_000 },
  );
  if (!result.ok) return { error: result.stderr || 'git diff 执行失败' };
  return { patch: result.stdout, truncated: result.truncated };
}

/**
 * Trim a patch to something readable on a phone.
 *
 * Cuts on a line boundary and reports how much was dropped, so the reader knows
 * the inline view is partial and the attached file is the real thing.
 */
export function previewPatch(
  patch: string,
  opts: { maxLines?: number; maxChars?: number } = {},
): { text: string; omittedLines: number } {
  const maxLines = opts.maxLines ?? 80;
  const maxChars = opts.maxChars ?? 3500;
  const lines = patch.split('\n');
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (kept.length >= maxLines || chars + line.length + 1 > maxChars) break;
    kept.push(line);
    chars += line.length + 1;
  }
  return { text: kept.join('\n'), omittedLines: Math.max(0, lines.length - kept.length) };
}
