import { readFile } from 'node:fs/promises';
import { findSecret } from '../dream/secrets';
import { git } from '../git/exec';

/**
 * The git hooks of a knowledge library's writable clone
 * (`knowledge-libraries/<name>.work/`). The agent commits and pushes there
 * with plain git, the way the repository's own contributing guide describes;
 * these checks are what keep that inside the rules:
 *
 * - only while the write window is open (a weekly-meeting job is running, or
 *   the owner opened it with `/knowledge lib write`);
 * - straight to the default branch only under the bot's own directory —
 *   anything else goes on a branch and through a pull request;
 * - nothing that looks like a credential, an SN, an IP, an e-mail address, a
 *   ticket number or an internal host name, in the content or the message;
 * - no AI attribution lines in commit messages.
 *
 * Hooks are not a sandbox (`--no-verify` skips them): they stop the plain way
 * of doing it, and the agent is told the same rules in its system prompt.
 */

export interface WriteHookConfig {
  library: string;
  /** The bot's own directory (`bots/cc`), without a trailing slash. */
  self: string;
  /** `knowledge-libraries/<name>.window.json`. */
  windowFile: string;
  /** Branch that only takes changes under {@link self}. */
  defaultBranch: string;
}

export interface WriteWindow {
  openedAt: number;
  /** Epoch ms the window closes at. */
  until: number;
  /** `cron:<id>` or `owner`. */
  reason: string;
}

export async function readWriteWindow(file: string): Promise<WriteWindow | undefined> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<WriteWindow>;
    if (typeof raw.until !== 'number' || typeof raw.openedAt !== 'number') return undefined;
    return { openedAt: raw.openedAt, until: raw.until, reason: typeof raw.reason === 'string' ? raw.reason : '' };
  } catch {
    return undefined;
  }
}

const CLOSED =
  '部门知识库现在不开放写入：只在周会定时任务运行期间、或 bot 主人用 `/knowledge lib write` 打开窗口时可写。';

async function requireOpenWindow(cfg: WriteHookConfig, now: number): Promise<string | undefined> {
  const window = await readWriteWindow(cfg.windowFile);
  return window && window.until > now ? undefined : CLOSED;
}

/**
 * Shapes the department repository forbids on top of {@link findSecret}.
 * Deliberately broad like that one: a false positive costs a rewording, a
 * miss puts a customer's device or address into shared history.
 */
const SENSITIVE_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  // Device serial numbers: a 2–4 letter prefix and a long run of digits (ALB002024100077).
  { label: 'SN', re: /\b[A-Z]{2,4}\d{10,14}\b/ },
  {
    label: 'IP',
    re: /(?<![\w.])(?!(?:127\.0\.0\.1|0\.0\.0\.0)(?![\w.]))(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\w.])/,
  },
  { label: '邮箱', re: /(?<![\w.+-])(?!git@)[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/ },
  // Jira-style keys. Standards and algorithms share the shape, so those are let through.
  { label: '工单号', re: /\b(?!(?:ISO|SHA|RFC|UTF|CVE|HTTP|TLS|AES|RSA|IEC|IEEE|ANSI|ECMA)-)[A-Z][A-Z0-9]{2,}-\d{2,}\b/ },
  { label: '内部地址', re: /\b[\w-]+(?:\.[\w-]+)*\.(?:internal|local|lan|corp|svc\.cluster\.local)(?![\w-]|\.\w)/i },
];

/** The first forbidden shape in `text` (credentials first), or undefined. */
export function findSensitive(text: string): string | undefined {
  const secret = findSecret(text);
  if (secret) return `凭证（${secret}）`;
  for (const { label, re } of SENSITIVE_PATTERNS) {
    if (re.test(text)) return label;
  }
  return undefined;
}

const ATTRIBUTION =
  /^\s*co-authored-by:.*\b(?:claude|codex|anthropic|openai|gpt|copilot|cursor|gemini)\b|generated (?:with|by) \[?(?:claude|codex|ai)|noreply@anthropic\.com|🤖/im;

/** Why a commit message is refused, or undefined. */
export function checkCommitMessage(message: string): string | undefined {
  if (ATTRIBUTION.test(message)) return '提交信息里不能带 AI 工具署名或生成标记。';
  const sensitive = findSensitive(message);
  if (sensitive) return `提交信息里有疑似${sensitive}，脱敏后再提交。`;
  return undefined;
}

/** Lines a diff adds, with the file each belongs to. */
function addedLines(diff: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) out.push({ file, text: line.slice(1) });
  }
  return out;
}

/** Why the added content is refused, or undefined. Names the file and the kind, never the match itself. */
export function checkAddedContent(diff: string): string | undefined {
  for (const { file, text } of addedLines(diff)) {
    const sensitive = findSensitive(text);
    if (sensitive) return `\`${file}\` 里有疑似${sensitive}的内容，脱敏后再提交（部门库不写密钥、内部地址、客户信息、SN、IP、账号、工单号）。`;
  }
  return undefined;
}

function underSelf(file: string, self: string): boolean {
  return file === self || file.startsWith(`${self}/`);
}

/** Why committing these paths on `branch` is refused, or undefined. */
export function checkPaths(files: readonly string[], branch: string, cfg: WriteHookConfig): string | undefined {
  if (branch !== cfg.defaultBranch) return undefined;
  const outside = files.filter((file) => !underSelf(file, cfg.self));
  if (outside.length === 0) return undefined;
  return `\`${cfg.defaultBranch}\` 上只能改自己的目录 \`${cfg.self}/\`，这些不行：${outside
    .slice(0, 5)
    .map((file) => `\`${file}\``)
    .join('、')}。改 \`shared/\` 等公共目录要开分支、推分支、发 Draft PR。`;
}

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args, { maxBytes: 8 * 1024 * 1024 });
  if (!result.ok) throw new Error(result.stderr.trim() || `git ${args[0]} 失败`);
  return result.stdout;
}

/** `pre-commit`: window, paths for the current branch, content. */
export async function checkPreCommit(cwd: string, cfg: WriteHookConfig, now = Date.now()): Promise<string | undefined> {
  const closed = await requireOpenWindow(cfg, now);
  if (closed) return closed;
  const branch = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  if (!branch) return '现在不在任何分支上（detached HEAD），先切到分支再提交。';
  const files = (await gitOut(cwd, ['diff', '--cached', '--name-only', '--no-renames', '-z']))
    .split('\0')
    .filter(Boolean);
  return checkPaths(files, branch, cfg) ?? checkAddedContent(await gitOut(cwd, ['diff', '--cached', '--no-color', '-U0', '--no-renames']));
}

/** `commit-msg <file>`. */
export async function checkCommitMsgFile(file: string, cfg: WriteHookConfig, now = Date.now()): Promise<string | undefined> {
  const closed = await requireOpenWindow(cfg, now);
  if (closed) return closed;
  // Comment lines are what git strips before storing the message.
  const message = (await readFile(file, 'utf8'))
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n');
  return checkCommitMessage(message);
}

const ZERO = /^0+$/;

/**
 * `pre-push`: every commit being pushed is checked again — commits made with
 * `--no-verify`, or before the window opened, must not slip through on the
 * way out. `updates` is the hook's stdin.
 */
export async function checkPrePush(
  cwd: string,
  cfg: WriteHookConfig,
  updates: string,
  now = Date.now(),
): Promise<string | undefined> {
  const closed = await requireOpenWindow(cfg, now);
  if (closed) return closed;
  for (const line of updates.split('\n')) {
    const [, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (!localSha || !remoteRef || !remoteSha) continue;
    const branch = remoteRef.replace(/^refs\/heads\//, '');
    if (ZERO.test(localSha)) {
      if (branch === cfg.defaultBranch) return `不能删除 \`${cfg.defaultBranch}\`。`;
      continue;
    }
    if (!remoteRef.startsWith('refs/heads/')) return `只能推分支，不能推 \`${remoteRef}\`。`;
    const range = ZERO.test(remoteSha) ? [localSha, '--not', '--remotes=origin'] : [`${remoteSha}..${localSha}`];
    if (!ZERO.test(remoteSha) && branch === cfg.defaultBranch) {
      // A push that drops commits from the default branch rewrites shared history.
      const ancestor = await git(cwd, ['merge-base', '--is-ancestor', remoteSha, localSha]);
      if (!ancestor.ok) return `不能强推 \`${cfg.defaultBranch}\`：先 \`git pull --rebase\` 再推。`;
    }
    const commits = (await gitOut(cwd, ['rev-list', '--no-merges', ...range])).split('\n').filter(Boolean);
    for (const commit of commits) {
      const files = (await gitOut(cwd, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', commit]))
        .split('\0')
        .filter(Boolean);
      const short = commit.slice(0, 7);
      const refused =
        checkPaths(files, branch, cfg) ??
        checkCommitMessage(await gitOut(cwd, ['log', '-1', '--format=%B', commit])) ??
        checkAddedContent(await gitOut(cwd, ['show', '--format=', '--no-color', '-U0', '--no-renames', commit]));
      if (refused) return `提交 ${short}：${refused}`;
    }
  }
  return undefined;
}

/** Entry point of the hook script: runs one hook, returns why it refuses (or undefined). */
export async function runWriteHook(
  hook: string,
  cfg: WriteHookConfig,
  args: readonly string[],
  stdin: () => Promise<string>,
  cwd = process.cwd(),
): Promise<string | undefined> {
  switch (hook) {
    case 'pre-commit':
      return checkPreCommit(cwd, cfg);
    case 'commit-msg':
      return args[0] ? checkCommitMsgFile(args[0], cfg) : undefined;
    case 'pre-push':
      return checkPrePush(cwd, cfg, await stdin());
    default:
      return undefined;
  }
}
