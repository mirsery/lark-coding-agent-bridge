import { formatTokens, type UsageTotals } from '../runtime/usage-ledger';
import { humanIdle, humanTokens, type RotationReason } from '../session/smart-session';

interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

/** A div rendered verbatim — no markdown, so `*`, `_` and backticks stay as typed. */
function divText(content: string): object {
  return { tag: 'div', text: { tag: 'plain_text', content } };
}

function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function workspacesCard(current: string | undefined, named: Record<string, string>): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(divMd(`当前 cwd：\`${escapeCode(current ?? '(未设置)')}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('暂无命名工作目录。'));
    elements.push(
      divMd('💡 发送 `/ws save <name>` 把当前 cwd 存为命名工作目录'),
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? '  ← 当前' : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: '切换到此处', value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: '删除', value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  return shell('📂 工作目录', elements);
}

export interface StatusInfo {
  profileName: string;
  cwd?: string;
  sessionId?: string;
  emptySessionText?: string;
  sessionStale: boolean;
  /** Size and age of the conversation the next message would resume. */
  context?: {
    tokens?: number;
    idleMinutes?: number;
    /** Set when 会话智能压缩 will start the next message in a fresh conversation. */
    rotateReason?: RotationReason;
  };
  agentName: string;
  runtimeAccess: {
    label: string;
    value: string;
  };
  larkCliStatus?: 'app' | 'user-ready' | 'user-missing' | 'check-failed';
  /** One-line git summary of `cwd`; absent when it is not a repository. */
  git?: string;
  /** One-line knowledge summary (memory counts, skills, sync state). */
  knowledge?: string;
  activeRun: boolean;
  /** What this scope's run is doing right now, when one is running. */
  activeRunDetail?: string;
  /** A stopped task waiting to be resumed in this scope. */
  autoResume?: string;
  /** The scope's process is still running background tasks after its last turn. */
  backgroundRun?: boolean;
  activeScopes?: string[];
  activeCommentScopes?: string[];
  queue?: { active: number; waiting: number; cap: number };
  ownerState: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
}

const ROTATE_REASON_TEXT: Record<RotationReason, string> = {
  'agent-done': '上一件事已完成',
  'idle-long': '空闲太久',
  'idle-large': '缓存已过期且上下文偏大',
};

function contextLine(context: NonNullable<StatusInfo['context']>): string {
  const parts: string[] = [];
  if (context.tokens !== undefined) parts.push(`约 ${humanTokens(context.tokens)} token`);
  if (context.idleMinutes !== undefined) parts.push(`上次对话 ${humanIdle(context.idleMinutes)}前`);
  if (context.rotateReason) parts.push(`下一条消息会自动开新会话（${ROTATE_REASON_TEXT[context.rotateReason]}）`);
  return parts.join(' · ');
}

/** `/status` for people other than admins: only how this chat's task is doing. */
export function taskStatusCard(info: { activeRun?: string; autoResume?: string }): object {
  const lines = [
    `🏃 **当前任务**: ${info.activeRun ? escapeMd(info.activeRun) : '没有正在运行的任务'}`,
    ...(info.autoResume ? [`⏸ **自动续跑**: ${escapeMd(info.autoResume)}`] : []),
  ];
  return shell('📊 当前状态', [divMd(lines.join('\n'))]);
}

export function statusCard(info: StatusInfo): object {
  const sessionLine = info.sessionId
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ 旧 cwd，下一条会新建' : ''}`
    : (info.emptySessionText ?? '(无)');
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` _（话题独立 session）_`
      : `\`${escapeCode(info.scope)}\``;
  const cwdLine = info.cwd ? `\`${escapeCode(info.cwd)}\`` : '(未设置)';
  const queueLine = info.queue
    ? `${info.queue.active}/${info.queue.cap} active, ${info.queue.waiting} waiting`
    : 'unknown';
  const lines = [
    `🧭 **scope**: ${scopeLine}`,
    `🧩 **profile**: ${escapeMd(info.profileName)}`,
    `📁 **cwd**: ${cwdLine}`,
    ...(info.git ? [`🌿 **git**: ${info.git}`] : []),
    ...(info.knowledge ? [`📚 **knowledge**: ${info.knowledge}`] : []),
    `🔗 **session**: ${sessionLine}`,
    ...(info.context ? [`🧠 **context**: ${contextLine(info.context)}`] : []),
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
    `🛡 **${escapeMd(info.runtimeAccess.label)}**: ${escapeMd(info.runtimeAccess.value)}`,
    ...(info.larkCliStatus ? [`🔐 **lark-cli**: ${info.larkCliStatus}`] : []),
    `🏃 **active run**: ${info.activeRun ? (info.activeRunDetail ? escapeMd(info.activeRunDetail) : 'yes') : 'no'}`,
    ...(info.autoResume ? [`⏸ **auto resume**: ${escapeMd(info.autoResume)}`] : []),
    ...(info.backgroundRun ? ['🧵 **background tasks**: running（`/stop` 可停止）'] : []),
    ...(info.activeScopes && info.activeScopes.length > 0
      ? [
          `🏃 **active scopes**: ${info.activeScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    ...(info.activeCommentScopes && info.activeCommentScopes.length > 0
      ? [
          `📝 **comment runs**: ${info.activeCommentScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    `🚦 **queue**: ${queueLine}`,
    `👤 **owner API**: ${escapeMd(info.ownerState)}`,
  ];
  return shell('📊 当前状态', [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: '🆕 新会话', value: { cmd: 'new' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '💡 帮助', value: { cmd: 'help' } },
    ]),
  ]);
}

export interface ResumeEntry {
  sessionId: string;
  displayId?: string;
  preview: string;
  relTime: string;
  lineCount?: number;
  detail?: string;
  current?: boolean;
}

export function resumeCard(cwd: string, entries: ResumeEntry[]): object {
  const elements: object[] = [];
  elements.push(divMd(`当前 cwd：\`${escapeCode(cwd)}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('此 cwd 下没有历史会话。'));
    return shell('🔁 恢复历史会话', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← 当前' : '';
    const detail = e.detail ?? `${e.lineCount ?? 0} 条`;
    const displayId = e.displayId ?? e.sessionId;
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${displayId.slice(0, 8)}…\` · ${e.relTime} · ${escapeMd(detail)}`,
      ),
    );
    elements.push(
      actions([
        {
          text: e.current ? '已是当前会话' : '▸ 恢复此会话',
          value: { cmd: 'resume.use', arg: e.sessionId },
          style: e.current ? 'default' : 'primary',
        },
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell('🔁 恢复历史会话', elements);
}

/**
 * Tinted section block for the help card — the same `column_set` + tinted
 * column the `/config` card uses, so the two read as one family instead of
 * "the old card and the new card".
 */
function helpSection(background: string, title: string, lines: string[]): object {
  return {
    tag: 'column_set',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        padding: '10px 12px 12px 12px',
        background_style: background,
        vertical_spacing: '6px',
        elements: [
          { tag: 'markdown', content: `**${title}**` },
          { tag: 'markdown', content: lines.join('\n') },
        ],
      },
    ],
  };
}

/** One row of callback buttons, laid out as equal-width columns. */
function helpButtonRow(buttons: Array<{ text: string; cmd: string; primary?: boolean }>): object {
  return {
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: buttons.map((button) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: button.text },
          ...(button.primary ? { type: 'primary' } : {}),
          width: 'fill',
          behaviors: [{ type: 'callback', value: { cmd: button.cmd } }],
        },
      ],
    })),
  };
}

/**
 * `/help` — grouped by what you are trying to do rather than by one long
 * alphabetical list. The command set outgrew a single bullet list once the
 * git / knowledge / scheduler commands landed; grouping is what keeps it
 * scannable on a phone.
 */
export function helpCard(agentName = 'Agent'): object {
  const escapedAgentName = escapeMd(agentName);
  return {
    schema: '2.0',
    config: { width_mode: 'fill', summary: { content: '使用帮助' } },
    header: {
      title: { tag: 'plain_text', content: '使用帮助' },
      subtitle: { tag: 'plain_text', content: `其他内容直接交给 ${agentName}` },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'help_outlined' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 16px 12px',
      vertical_spacing: '10px',
      elements: [
        helpSection('yellow-50', '📌 置顶 · eli5 讲给小白听', [
          '`/eli5 <话题>` — 把话题讲给完全不懂的人：生成一页 HTML 图解，图大、字少，作为附件发回会话',
          '适合给非技术同事、客户、管理层解释概念，或排障汇报、方案评审前先对齐；讲得刻意浅，不能代替技术文档',
          '例：`/eli5 DNS 是怎么工作的`、`/eli5 为什么线程池占满会导致 504`',
        ]),
        helpSection('blue-50', '🗣 会话', [
          '`/new` `/reset` — 清空当前会话',
          '`/new chat [名字]` — 新建群 + 新会话，自动拉你进群',
          '`/resume [N]` — 列出并恢复本会话用过的历史会话（管理员 `/resume all` 看全部）',
          '`/stop` — 结束正在跑的任务（也可点卡片上的 ⏹ 终止）；任务等待自动续跑时，取消续跑',
          '`/timeout [N|off|default]` — 本会话的探活分钟数',
          '`/effort [档位|default]` — 本会话的推理强度（管理员），`/new` 后恢复默认；不设时 agent 会按需自动切档',
        ]),
        helpSection('turquoise-50', '📂 工作目录与 Git', [
          '`/cd <路径>` — 切换工作目录（会重置会话）',
          '`/ws list|save|use|remove <名字>` — 命名工作目录',
          '`/diff [staged|<ref>]` — 看改动，长 patch 附带文件',
          '`/worktree [add|use|remove]` — 任务级 worktree，会话自动跟着切',
          '`/pr [编号|链接]` — 当前分支的 PR、CI 与评审状态',
        ]),
        helpSection('violet-50', '🧠 记忆与 skills', [
          '`/memory [add|forget|clear]` — 跨会话记忆，`--global` 写到全局',
          '`/skills [show <名字>]` — skill 索引，agent 按需读取正文',
          '`/skills lib [add|sync|update|rm]` — 共享 skill 库（git 仓库，管理员；`--external` 加第三方库）',
          '`/knowledge [bind|sync]` — 记忆与 skill 的 git 同步，绑定后定时自动同步',
          '`/knowledge lib` — 订阅部门共享等其他知识库，周会时才可写（仅 bot 主人）',
          '`/dream [run|cancel|prs|diff|revert]` — 梦境整理：把已结束的会话整理成待审核的 Draft PR，可撤销已合并的批次（管理员私聊）',
        ]),
        helpSection('green-50', '🧪 联调', [
          '`/joint-debug <单号>` — 把 JIRA 单合入 devops、触发 Jenkins 部署到联调环境（8.221）并走 web 冒烟，如 `/joint-debug ANTELOPE-6747`',
        ]),
        helpSection('orange-50', '⏰ 定时任务', [
          '`/cron add <时间> | <任务>` — 新建，如 `0 9 * * 1-5`、`@daily`、`in 30m`',
          '`/cron list|show|run|pause|resume|remove` — 管理已有任务',
        ]),
        helpSection('grey-50', '⚙️ 运维与诊断', [
          '`/status` — 当前 profile、会话、工作目录、git、知识库状态',
          '`/accounts` — Claude 订阅账户表：各账户用量、重置时间、切换线；`/accounts switch [名字]` 切换账户',
          '`/config` — 偏好、访问控制、lark-cli 身份策略',
          '`/account` — 查看当前应用；`/account change` 换 appId/secret',
          '`/ps` · `/exit <id|#>` — 列出 / 关掉本机的 bot',
          '`/reconnect` — 强制重连（网络抖动后没反应时用）',
          `\`/doctor [描述]\` — 把日志交给 ${escapedAgentName} 自助诊断`,
          '`/usage [today|week|month]` — 用量统计；管理员私聊可看所有人',
          '`/audit [拦截] [N]` — 最近谁让 bot 执行了什么、审批结果；加「拦截」只看被拦下的访客操作（管理员私聊）',
        ]),
        { tag: 'hr' },
        helpButtonRow([
          { text: '📊 状态', cmd: 'status', primary: true },
          { text: '📚 知识库', cmd: 'knowledge' },
          { text: '⏰ 定时任务', cmd: 'cron.list' },
        ]),
        helpButtonRow([
          { text: '🔍 改动', cmd: 'diff' },
          { text: '📂 工作目录', cmd: 'ws.list' },
          { text: '🆕 新会话', cmd: 'new' },
        ]),
        {
          tag: 'markdown',
          content:
            "<font color='grey'>管理员专用：`/invite` `/remove` 管访问名单 · " +
            '`/stop comment:<hash>`、`/timeout comment:<hash> N` 管云文档评论任务 · ' +
            "`/coffee` 来一杯 ☕</font>",
        },
      ],
    },
  };
}

export interface CoffeeBrand {
  /** File stem of the brand's logo under `assets/coffee/`. */
  slug: string;
  /** English brand name — the card carries no Chinese brand names. */
  name: string;
  /** Header template — the closest Feishu palette to the brand colour. */
  template: string;
}

/** Head-of-market coffee brands the `/coffee` easter egg rotates through,
 * each tinted with the nearest Feishu palette to its brand colour (Feishu has
 * no black header, so black brands use grey). */
export const COFFEE_BRANDS: readonly CoffeeBrand[] = [
  { slug: 'starbucks', name: 'Starbucks', template: 'green' },
  { slug: 'luckin', name: 'Luckin Coffee', template: 'blue' },
  { slug: 'mstand', name: 'M Stand', template: 'grey' },
  { slug: 'manner', name: 'Manner Coffee', template: 'default' },
  { slug: 'algebraist', name: 'Algebraist', template: 'red' },
  { slug: 'peets', name: "Peet's Coffee", template: 'orange' },
  { slug: 'tims', name: 'Tims', template: 'carmine' },
  { slug: 'costa', name: 'Costa Coffee', template: 'carmine' },
  { slug: 'bluebottle', name: 'Blue Bottle Coffee', template: 'wathet' },
  { slug: 'arabica', name: '% Arabica', template: 'grey' },
];

export function pickCoffeeBrand(random: () => number = Math.random): CoffeeBrand {
  return COFFEE_BRANDS[Math.floor(random() * COFFEE_BRANDS.length)] ?? COFFEE_BRANDS[0]!;
}

export interface CoffeeCardOptions {
  /** People the coffee is for; the card @-mentions each of them. */
  recipients?: readonly { openId: string }[];
  /** Who is treating — the requester's display name. */
  payer?: string;
  /** Uploaded `image_key` of the brand logo; the card goes without one. */
  logoKey?: string;
}

/** Fixed schema-2.0 card — same layout everywhere `/coffee` is sent, unlike
 * the ad-hoc cards an agent session would otherwise improvise per-chat; only
 * the brand (name, colour, logo) changes per cup. */
export function coffeeCard(brand: CoffeeBrand, opts: CoffeeCardOptions = {}): object {
  const title = `${brand.name} 电子咖啡`;
  const elements: object[] = [];
  const recipients = opts.recipients ?? [];
  if (recipients.length > 0) {
    const ats = recipients.map((r) => `<at id=${r.openId}></at>`).join(' ');
    const you = recipients.length > 1 ? '你们' : '你';
    elements.push({ tag: 'markdown', content: `${ats} ${opts.payer ?? ''}请${you}喝一杯` });
  }
  if (opts.logoKey) {
    // `img` has no alignment of its own; a single centered column carries it.
    elements.push({
      tag: 'column_set',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          horizontal_align: 'center',
          elements: [
            {
              tag: 'img',
              img_key: opts.logoKey,
              alt: { tag: 'plain_text', content: brand.name },
              scale_type: 'crop_center',
              size: '64px 64px',
              corner_radius: '8px',
            },
          ],
        },
      ],
    });
  }
  elements.push(
    { tag: 'markdown', content: `**${brand.name} 电子咖啡一杯**` },
    { tag: 'markdown', content: `<font color='grey'>${brand.name} Roast · 现磨现发</font>` },
    HR,
    { tag: 'markdown', content: "<font color='grey'>零卡路里 · 零等待 · 续杯免费 · 熬夜专用</font>" },
  );
  return {
    schema: '2.0',
    config: { width_mode: 'default', summary: { content: title } },
    header: {
      title: { tag: 'plain_text', content: title },
      subtitle: { tag: 'plain_text', content: '不含咖啡因,但管用' },
      template: brand.template,
      icon: { tag: 'standard_icon', token: 'gift_outlined' },
    },
    body: {
      direction: 'vertical',
      padding: '16px 16px 20px 16px',
      vertical_spacing: '10px',
      elements,
    },
  };
}

export interface DiffFileView {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
}

export interface DiffCardView {
  scope: string;
  files: DiffFileView[];
  added: number;
  removed: number;
  untracked: string[];
  /** Inline excerpt of the patch; empty when there is nothing to show. */
  preview: string;
  omittedLines: number;
  /** True when the full patch is being sent as a separate file message. */
  attached: boolean;
}

/** Cap on files listed inline — a long list is unreadable on a phone. */
const DIFF_FILE_LIMIT = 15;

export function diffCard(view: DiffCardView): object {
  const elements: object[] = [];
  elements.push(
    divMd(`${view.scope} · **${view.files.length}** 个文件 <font color='green'>+${view.added}</font> <font color='red'>-${view.removed}</font>`),
  );

  if (view.files.length === 0 && view.untracked.length === 0) {
    elements.push(divMd('没有改动。'));
    return shell('\u{1f50d} 改动', elements);
  }

  if (view.files.length > 0) {
    elements.push(HR);
    const shown = view.files.slice(0, DIFF_FILE_LIMIT);
    elements.push(
      divMd(
        shown
          .map((f) =>
            f.binary
              ? `\`${escapeCode(f.path)}\` (二进制)`
              : `\`${escapeCode(f.path)}\` <font color='green'>+${f.added}</font> <font color='red'>-${f.removed}</font>`,
          )
          .join('\n'),
      ),
    );
    if (view.files.length > shown.length) {
      elements.push(divMd(`<font color='grey'>… 还有 ${view.files.length - shown.length} 个文件</font>`));
    }
  }

  if (view.untracked.length > 0) {
    elements.push(
      divMd(
        `<font color='grey'>未跟踪 ${view.untracked.length} 个：${view.untracked
          .slice(0, 5)
          .map((p) => escapeMd(p))
          .join('、')}${view.untracked.length > 5 ? ' …' : ''}</font>`,
      ),
    );
  }

  if (view.preview) {
    elements.push(HR);
    elements.push(divMd(`\`\`\`diff\n${escapeCode(view.preview)}\n\`\`\``));
    if (view.omittedLines > 0) {
      elements.push(
        divMd(
          `<font color='grey'>… 还有 ${view.omittedLines} 行${view.attached ? '，完整 patch 见下一条消息' : ''}</font>`,
        ),
      );
    }
  }

  return shell('\u{1f50d} 改动', elements);
}

export interface WorktreeView {
  path: string;
  branch?: string;
  head?: string;
  main: boolean;
  current: boolean;
}

export function worktreeCard(entries: WorktreeView[]): object {
  const elements: object[] = [];
  if (entries.length === 0) {
    elements.push(divMd('当前目录不是 git 仓库，或者没有可用的 worktree。'));
    return shell('\u{1f333} Worktree', elements);
  }

  entries.forEach((entry, i) => {
    const label = entry.branch ? `\`${escapeCode(entry.branch)}\`` : `游离 @ ${entry.head ?? '?'}`;
    const marks = [entry.main ? '主 checkout' : '', entry.current ? '← 当前' : ''].filter(Boolean);
    elements.push(
      divMd(`**${label}** ${marks.join(' · ')}\n\`${escapeCode(entry.path)}\``),
    );
    elements.push(
      actions([
        ...(entry.current
          ? []
          : [{ text: '切换到这里', value: { cmd: 'worktree.use', arg: entry.path }, style: 'primary' as const }]),
        ...(entry.main
          ? []
          : [{ text: '删除', value: { cmd: 'worktree.remove', arg: entry.path }, style: 'danger' as const }]),
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell('\u{1f333} Worktree', elements);
}

export interface PullRequestCardView {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  checksLabel: string;
  failingChecks: string[];
  reviewLabel: string;
  mergeable?: string;
}

export function pullRequestCard(view: PullRequestCardView): object {
  const state = view.isDraft ? '草稿' : view.state === 'OPEN' ? '开放' : view.state === 'MERGED' ? '已合并' : '已关闭';
  const elements: object[] = [
    divMd(`[#${view.number} ${escapeMd(view.title)}](${view.url})`),
    divMd(
      [
        `\`${escapeCode(view.headRefName)}\` → \`${escapeCode(view.baseRefName)}\``,
        `${state}${view.author ? ` · @${escapeMd(view.author)}` : ''}`,
        `${view.changedFiles} 个文件 <font color='green'>+${view.additions}</font> <font color='red'>-${view.deletions}</font>`,
      ].join('\n'),
    ),
    HR,
    divMd(`**CI**：${view.checksLabel}\n**评审**：${view.reviewLabel}${view.mergeable === 'CONFLICTING' ? '\n**合并**：⚠️ 有冲突' : ''}`),
  ];
  if (view.failingChecks.length > 0) {
    elements.push(
      divMd(`<font color='red'>失败：${view.failingChecks.map((c) => escapeMd(c)).join('、')}</font>`),
    );
  }
  // `cmd` carries the number as its own segment: the dispatcher turns
  // `pr.123` into `/pr 123`, so the refresh button keeps pointing at this PR.
  elements.push(actions([{ text: '刷新', value: { cmd: `pr.${view.number}` }, style: 'primary' }]));

  return shell(`\u{1f500} PR #${view.number}`, elements);
}

export interface MemoryEntryView {
  id: string;
  text: string;
}

export interface MemoryCardView {
  chat: MemoryEntryView[];
  /** In a topic: the notes of the group it belongs to, which every topic there sees. */
  group?: MemoryEntryView[];
  profile: MemoryEntryView[];
  /** Where the notes live on disk, so a power user can edit them directly. */
  dir: string;
}

export function memoryCard(view: MemoryCardView): object {
  const elements: object[] = [];

  const section = (title: string, entries: MemoryEntryView[], scopeHint: string): void => {
    elements.push(divMd(`**${title}**（${entries.length}）`));
    if (entries.length === 0) {
      elements.push(divMd(`<font color='grey'>暂无。${scopeHint}</font>`));
      return;
    }
    for (const entry of entries) {
      elements.push(divMd(`\`${escapeCode(entry.id)}\` ${escapeMd(entry.text)}`));
      elements.push(
        actions([{ text: '删除', value: { cmd: 'memory.forget', arg: entry.id }, style: 'danger' }]),
      );
    }
  };

  section('本会话记忆', view.chat, '用 `/memory add <内容>` 添加。');
  elements.push(HR);
  if (view.group) {
    section('本群记忆（群里所有话题生效）', view.group, '在话题里用 `/memory add --group <内容>` 添加。');
    elements.push(HR);
  }
  section('全局记忆', view.profile, '管理员可用 `/memory add --global <内容>` 添加。');
  elements.push(HR);
  elements.push(divMd(`<font color='grey'>存放在 \`${escapeCode(view.dir)}\`，可直接用编辑器改</font>`));

  return shell('\u{1f9e0} 记忆', elements);
}

export interface SkillView {
  name: string;
  description: string;
  /** Shared library the skill comes from; absent for the profile's own. */
  source?: string;
  /** The library is a third party's. */
  external?: boolean;
}

/** Card descriptions are a glance, not the full trigger text the agent gets. */
const SKILL_CARD_DESCRIPTION_CHARS = 120;

export function skillsCard(skills: SkillView[], dir: string): object {
  const elements: object[] = [];
  if (skills.length === 0) {
    elements.push(divMd('还没有 skill。'));
    elements.push(
      divMd(
        `在 \`${escapeCode(dir)}\` 下新建 \`<名字>/SKILL.md\` 就行，或者用 \`/knowledge bind <仓库地址>\` 从现成的仓库同步一份；` +
          '共享的 skill 库用 `/skills lib add <git 地址>` 加载。',
      ),
    );
    return shell('\u{1f9f0} Skills', elements);
  }

  elements.push(divMd(`共 **${skills.length}** 个，agent 会按需读取正文。`));
  // The profile's own skills first, then one group per library in index order.
  const groups = new Map<string, SkillView[]>();
  for (const skill of skills) {
    const key = skill.source ?? '';
    groups.set(key, [...(groups.get(key) ?? []), skill]);
  }
  for (const [source, members] of groups) {
    const kind = members[0]?.external ? '第三方库' : 'skill 库';
    elements.push(HR);
    elements.push(
      divMd(source ? `📚 **${kind} \`${escapeCode(source)}\`**（${members.length}）` : `📁 **本 profile**（${members.length}）`),
    );
    for (const skill of members) {
      const description =
        skill.description.length > SKILL_CARD_DESCRIPTION_CHARS
          ? `${skill.description.slice(0, SKILL_CARD_DESCRIPTION_CHARS - 1)}…`
          : skill.description;
      elements.push(
        divMd(`**${escapeMd(skill.name)}**${description ? `\n<font color='grey'>${escapeMd(description)}</font>` : ''}`),
      );
    }
  }
  return shell('\u{1f9f0} Skills', elements);
}

export interface SkillLibraryView {
  name: string;
  /** A third party's library: pinned, never a 梦境整理 target. */
  external?: boolean;
  /** Display-safe: credentials already masked. */
  url: string;
  ref?: string;
  path?: string;
  include?: string[];
  exclude?: string[];
  present: boolean;
  commit?: string;
  /** e.g. "3h 前" — preformatted by the caller. */
  commitAgo?: string;
  lastSyncAgo?: string;
  lastError?: string;
  skills: string[];
  /** Skills of this library hidden by an earlier one with the same name. */
  shadowed: string[];
  /** External libraries: the fetched upstream compared with the pin. */
  pending?: { upstream: string; ahead?: number; added: string[]; removed: string[]; changed: string[] };
}

export function skillLibrariesCard(libraries: SkillLibraryView[], syncIntervalMinutes: number): object {
  const elements: object[] = [];
  if (libraries.length === 0) {
    elements.push(divMd('还没有配置 skill 库。'));
  }
  // The caller passes self libraries first; a heading starts each group.
  let group: boolean | undefined;
  for (const library of libraries) {
    if (elements.length > 0) elements.push(HR);
    const external = library.external === true;
    if (group !== external) {
      group = external;
      elements.push(
        divMd(
          external
            ? "**第三方库**\n<font color='grey'>固定在审过的提交，sync 只拉取看差异，update 才切换；不作为梦境整理的提交目标。</font>"
            : '**我的库**',
        ),
      );
    }
    const lines = [`📚 **${escapeMd(library.name)}**`, `🔗 \`${escapeCode(library.url)}\``];
    const scope = [
      library.ref ? `ref \`${escapeCode(library.ref)}\`` : '默认分支',
      ...(library.path ? [`目录 \`${escapeCode(library.path)}\``] : []),
      ...(library.include ? [`只用 ${library.include.map((n) => `\`${escapeCode(n)}\``).join('、')}`] : []),
      ...(library.exclude ? [`排除 ${library.exclude.map((n) => `\`${escapeCode(n)}\``).join('、')}`] : []),
    ];
    lines.push(`🌿 ${scope.join(' · ')}`);
    if (library.present) {
      lines.push(
        `📌 ${external ? '固定在 ' : ''}\`${escapeCode(library.commit ?? '?')}\`${library.commitAgo ? `（提交于 ${library.commitAgo}）` : ''}` +
          (library.lastSyncAgo ? ` · 上次同步 ${library.lastSyncAgo}` : ''),
      );
      const pending = library.pending;
      if (pending && pending.upstream !== library.commit) {
        const names = (items: string[]) => items.map((n) => `\`${escapeCode(n)}\``).join('、');
        const parts = [
          ...(pending.added.length ? [`新增 ${names(pending.added)}`] : []),
          ...(pending.changed.length ? [`改动 ${names(pending.changed)}`] : []),
          ...(pending.removed.length ? [`删除 ${names(pending.removed)}`] : []),
        ];
        lines.push(
          `<font color='orange'>⬆️ 上游 \`${escapeCode(pending.upstream)}\`` +
            (pending.ahead !== undefined ? ` 领先 ${pending.ahead} 个提交` : '') +
            `${parts.length ? `：${parts.join('；')}` : '，skill 没有变化'}</font>`,
        );
      } else if (pending) {
        lines.push("<font color='grey'>与上游一致</font>");
      }
    } else {
      lines.push("📌 <font color='grey'>还没有拉取成功</font>");
    }
    if (library.lastError) lines.push(`<font color='red'>❌ 上次同步失败：${escapeMd(library.lastError)}</font>`);
    const listed = library.skills.slice(0, 20).map((n) => `\`${escapeCode(n)}\``).join('、');
    lines.push(
      `🧰 skill ${library.skills.length} 个${library.skills.length > 0 ? `：${listed}${library.skills.length > 20 ? ' …' : ''}` : ''}`,
    );
    if (library.shadowed.length > 0) {
      lines.push(
        `<font color='grey'>同名已存在、未载入：${library.shadowed.map((n) => `\`${escapeCode(n)}\``).join('、')}</font>`,
      );
    }
    elements.push(divMd(lines.join('\n')));
  }
  elements.push(HR);
  elements.push(
    divMd(
      [
        `<font color='grey'>${syncIntervalMinutes > 0 ? `每 ${syncIntervalMinutes} 分钟自动同步` : '已关闭定时同步'}，启动时也会同步一次；第三方库同步只拉取、不切换。</font>`,
        '`/skills lib add <git 地址> [名字] [--external] [--ref 分支] [--path 子目录] [--only a,b] [--exclude a,b]`',
        '`/skills lib sync [名字]` · `/skills lib update <名字>` · `/skills lib rm <名字>`',
      ].join('\n'),
    ),
  );
  return shell('\u{1f4da} Skill 库', elements);
}

export interface KnowledgeStatusView {
  dir: string;
  chatMemories: number;
  profileMemories: number;
  skills: number;
  remote?: string;
  branch?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  /** Configured auto-sync interval; `0` = off. */
  autoSyncMinutes?: number;
  /** An automatic round is running right now. */
  autoSyncing?: boolean;
  /** Most recent sync this process ran or saw, automatic or `/knowledge sync`. */
  lastSync?: {
    /** e.g. "3m 前" — preformatted by the caller. */
    ago: string;
    auto: boolean;
    ok: boolean;
    /** Display-safe: credentials already masked. */
    error?: string;
    /** Failed automatic rounds in a row, when more than one. */
    failures?: number;
  };
  /** Subscribed knowledge repositories (`/knowledge lib`). */
  libraries?: KnowledgeLibraryView[];
}

export interface KnowledgeLibraryView {
  name: string;
  /** Display-safe: credentials already masked. */
  url: string;
  present: boolean;
  commit?: string;
  /** Preformatted, e.g. "3m 前". */
  lastSyncAgo?: string;
  lastError?: string;
  entries: number;
  /** `bots/cc`; absent: read-only. */
  self?: string;
  /** Preformatted close time of an open write window. */
  windowUntil?: string;
  weekCommits?: number;
  jobs?: string[];
  /** Skills whose reading opens the window. */
  skills?: string[];
}

function knowledgeLibraryLines(library: KnowledgeLibraryView): string[] {
  const state = !library.present
    ? "<font color='grey'>还没拉取</font>"
    : `\`${escapeCode(library.commit ?? '?')}\` · 索引 ${library.entries} 条${library.lastSyncAgo ? ` · ${library.lastSyncAgo}同步` : ''}`;
  const lines = [`📖 **${escapeMd(library.name)}**：${state}`, `<font color='grey'>${escapeMd(library.url)}</font>`];
  if (library.lastError) lines.push(`<font color='red'>❌ 上次拉取失败：${escapeMd(library.lastError)}</font>`);
  if (!library.self) {
    lines.push("<font color='grey'>只读（没配 `write.self`）</font>");
    return lines;
  }
  const window = library.windowUntil ? `写入窗口开到 ${library.windowUntil}` : '写入窗口关闭';
  const week = library.weekCommits !== undefined ? ` · 本周已写入 ${library.weekCommits} 次` : '';
  const jobs = library.jobs?.length ? ` · 定时任务 ${library.jobs.map((job) => `\`${escapeCode(job)}\``).join('、')} 运行时开放` : '';
  const skills = library.skills?.length ? ` · 读 ${library.skills.map((skill) => `\`${escapeCode(skill)}\``).join('、')} 时开放` : '';
  lines.push(`✍️ \`${escapeCode(library.self)}/\` · ${window}${week}${jobs}${skills}`);
  return lines;
}

export function knowledgeCard(view: KnowledgeStatusView): object {
  const lines = [
    `📁 **目录**：\`${escapeCode(view.dir)}\``,
    `🧠 **记忆**：本会话 ${view.chatMemories} · 全局 ${view.profileMemories}`,
    `🧰 **skills**：${view.skills}`,
  ];
  if (view.remote) {
    const divergence =
      view.ahead !== undefined && view.behind !== undefined ? ` ↑${view.ahead} ↓${view.behind}` : '';
    lines.push(`🔗 **远端**：\`${escapeCode(view.remote)}\``);
    lines.push(`🌿 **分支**：\`${escapeCode(view.branch ?? '?')}\`${divergence}${view.dirty ? ' · 有未同步改动' : ''}`);
    if (view.autoSyncMinutes !== undefined) {
      lines.push(
        view.autoSyncMinutes > 0
          ? `🔄 **自动同步**：每 ${view.autoSyncMinutes} 分钟${view.autoSyncing ? ' · 正在同步' : ''}`
          : "🔄 **自动同步**：<font color='grey'>已关闭，只在 `/knowledge sync` 时同步</font>",
      );
    }
    const last = view.lastSync;
    if (last) {
      const how = last.auto ? '自动' : '手动';
      lines.push(
        last.ok
          ? `🕒 **上次同步**：${last.ago}（${how}）✓`
          : `<font color='red'>❌ 上次同步失败（${last.ago}，${how}${last.failures ? `，自动同步已连续失败 ${last.failures} 次` : ''}）：${escapeMd(last.error ?? '未知错误')}</font>`,
      );
    }
  } else {
    lines.push("🔗 **远端**：<font color='grey'>未绑定，用 `/knowledge bind <仓库地址>` 开启同步</font>");
  }

  const libraries = view.libraries?.length
    ? [divMd(view.libraries.flatMap(knowledgeLibraryLines).join('\n')), HR]
    : [];
  return shell('\u{1f4da} 知识库', [
    divMd(lines.join('\n')),
    HR,
    ...libraries,
    actions([
      { text: '同步', value: { cmd: 'knowledge.sync' }, style: 'primary' },
      { text: '记忆', value: { cmd: 'memory' } },
      { text: 'Skills', value: { cmd: 'skills' } },
    ]),
  ]);
}

export interface CronJobView {
  id: string;
  name?: string;
  schedule: string;
  status: string;
  lastRun?: string;
  prompt: string;
  enabled: boolean;
}

/**
 * `/cron list` panel. Each job carries the three actions worth one tap —
 * run it now, pause/resume it, delete it — so the common edits never need
 * anyone to retype an id.
 */
export function cronCard(jobs: CronJobView[], hint: string): object {
  const elements: object[] = [];

  if (jobs.length === 0) {
    elements.push(divMd('本会话还没有定时任务。'));
    elements.push(divMd(hint));
    return shell('⏰ 定时任务', elements);
  }

  jobs.forEach((job, i) => {
    // lark_md has no inline code and reads `*` as emphasis, so a cron
    // expression like `0 6 * * 6` came out as "`0 6  6`". Everything that
    // carries user or schedule text goes out as plain_text instead.
    elements.push(
      divMd(
        job.name
          ? `**${escapeMd(job.name)}** <font color='grey'>${escapeMd(job.id)}</font>`
          : `**${escapeMd(job.id)}**`,
      ),
    );
    elements.push(divText(`${job.schedule}\n${job.status}`));
    elements.push(divText(job.prompt));
    if (job.lastRun) elements.push(divText(job.lastRun));
    elements.push(
      actions([
        { text: '立即运行', value: { cmd: 'cron.run', arg: job.id }, style: 'primary' },
        job.enabled
          ? { text: '暂停', value: { cmd: 'cron.pause', arg: job.id } }
          : { text: '恢复', value: { cmd: 'cron.resume', arg: job.id } },
        { text: '删除', value: { cmd: 'cron.remove', arg: job.id }, style: 'danger' },
      ]),
    );
    if (i < jobs.length - 1) elements.push(HR);
  });

  return shell('⏰ 定时任务', elements);
}

export interface UsageCardRow {
  name: string;
  self: boolean;
  total: UsageTotals;
}

export interface UsageCardPeriod {
  label: string;
  total: UsageTotals;
  /** Everyone's rows, heaviest first; absent when the viewer only sees their own. */
  rows?: UsageCardRow[];
  /** People with usage in the period (rows may be capped below this). */
  people: number;
}

/** Rows a table carries; it pages them 10 at a time. */
const USAGE_TABLE_ROWS = 50;

function percent(part: number, whole: number): string {
  if (whole <= 0) return '—';
  const p = (part / whole) * 100;
  return p >= 1 || p === 0 ? `${Math.round(p)}%` : '<1%';
}

function usageTile(label: string, value: string): object {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    padding: '10px 12px',
    background_style: 'grey-50',
    vertical_spacing: '2px',
    elements: [
      { tag: 'markdown', content: `<font color='grey'>${label}</font>`, text_size: 'notation' },
      { tag: 'markdown', content: `**${value}**`, text_size: 'heading' },
    ],
  };
}

function usageTiles(t: UsageTotals): object {
  const tiles = [
    usageTile('对话轮次', String(t.turns)),
    usageTile(
      t.cachedInputTokens > 0 ? `输入 · 缓存 ${percent(t.cachedInputTokens, t.inputTokens)}` : '输入',
      formatTokens(t.inputTokens),
    ),
    usageTile('输出', formatTokens(t.outputTokens)),
    ...(t.costUsd > 0 ? [usageTile('估算费用', `$${t.costUsd.toFixed(2)}`)] : []),
  ];
  // Four tiles fold into 2 × 2 on a phone; three still fit on one line.
  return { tag: 'column_set', flex_mode: tiles.length === 4 ? 'bisect' : 'none', horizontal_spacing: '8px', columns: tiles };
}

function usageTable(period: UsageCardPeriod, rows: UsageCardRow[]): object {
  const withCost = period.total.costUsd > 0;
  // Share of the cost; Codex reports none, so fall back to tokens.
  const weight = (t: UsageTotals): number => (withCost ? t.costUsd : t.inputTokens + t.outputTokens);
  const whole = weight(period.total);
  const right = { horizontal_align: 'right', width: 'auto' };
  return {
    tag: 'table',
    page_size: 10,
    row_height: 'low',
    freeze_first_column: true,
    header_style: { text_align: 'left', text_size: 'normal', background_style: 'grey', text_color: 'grey', bold: true, lines: 1 },
    columns: [
      { name: 'who', display_name: '成员', data_type: 'text', width: 'auto' },
      { name: 'turns', display_name: '轮次', data_type: 'number', format: { precision: 0 }, ...right },
      { name: 'input', display_name: '输入', data_type: 'text', ...right },
      { name: 'output', display_name: '输出', data_type: 'text', ...right },
      ...(withCost
        ? [{ name: 'cost', display_name: '估算费用', data_type: 'number', format: { symbol: '$', precision: 2, separator: true }, ...right }]
        : []),
      { name: 'share', display_name: '占比', data_type: 'text', ...right },
    ],
    rows: rows.slice(0, USAGE_TABLE_ROWS).map((row, i) => ({
      who: `${i + 1}. ${row.name}${row.self ? '（你）' : ''}`,
      turns: row.total.turns,
      input: formatTokens(row.total.inputTokens),
      output: formatTokens(row.total.outputTokens),
      ...(withCost ? { cost: Number(row.total.costUsd.toFixed(2)) } : {}),
      share: percent(weight(row.total), whole),
    })),
  };
}

/**
 * `/usage`: per period a row of totals, then — for an admin in private —
 * who used how much as a table. Numbers go in tiles and table cells instead
 * of one long `·`-joined line per person, which was unreadable at a glance.
 */
export function usageCard(view: { periods: UsageCardPeriod[]; everyone: boolean; notes: string[] }): object {
  const elements: object[] = [];
  view.periods.forEach((period, i) => {
    if (i > 0) elements.push(HR);
    const people = view.everyone && period.people > 0 ? ` <font color='grey'>· ${period.people} 人</font>` : '';
    elements.push({ tag: 'markdown', content: `**${period.label}**${people}` });
    if (period.total.turns === 0) {
      elements.push({ tag: 'markdown', content: "<font color='grey'>暂无用量记录。</font>" });
      return;
    }
    elements.push(usageTiles(period.total));
    if (period.rows && period.rows.length > 0) {
      elements.push(usageTable(period, period.rows));
      const hidden = period.people - Math.min(period.rows.length, USAGE_TABLE_ROWS);
      if (hidden > 0) {
        elements.push({ tag: 'markdown', content: `<font color='grey'>另有 ${hidden} 人未列出</font>`, text_size: 'notation' });
      }
    }
  });
  if (view.notes.length > 0) {
    elements.push(HR, {
      tag: 'markdown',
      content: view.notes.map((note) => `<font color='grey'>${note}</font>`).join('\n'),
      text_size: 'notation',
    });
  }
  return {
    schema: '2.0',
    config: { width_mode: 'fill', summary: { content: '用量统计' } },
    header: {
      title: { tag: 'plain_text', content: '用量统计' },
      subtitle: { tag: 'plain_text', content: view.everyone ? '所有人 · 从高到低' : '你自己的用量' },
      template: 'indigo',
      icon: { tag: 'standard_icon', token: 'bar-chart_outlined' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 16px 12px',
      vertical_spacing: '10px',
      elements,
    },
  };
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}

/** One tight quota window as the overload card shows it. */
export interface OverloadCardWindow {
  label: string;
  usedPercent: number;
  limit: number;
  /** Epoch ms of the window's reset. */
  resetAt?: number;
  /** Bots get answered again from this time on (reset minus grace). */
  resumeAt?: number;
}

/**
 * 过载保护's answer to another bot's question while the quota is tight: a
 * one-glance header, then the gauge, when it gets better, and that humans are
 * still served.
 * Mentions the asking bots' owners only (bot ↔ owner table): an @ to a bot would wake it and start a loop.
 */
export function overloadCard(input: {
  windows: readonly OverloadCardWindow[];
  cooldownMinutes: number;
  /** Owners (`ou_…`) of the bots that asked, @-ed at the top — never a bot. */
  owners?: readonly string[];
}): object {
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = (at: number) => {
    const d = new Date(at);
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const gauge = (percent: number) => {
    const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
    return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
  };
  const resume = input.windows.every((w) => w.resumeAt !== undefined)
    ? Math.max(...input.windows.map((w) => w.resumeAt!))
    : undefined;
  return {
    schema: '2.0',
    config: { width_mode: 'default', summary: { content: '🥵 算力过载，暂停回答 bot 的提问' } },
    header: {
      title: { tag: 'plain_text', content: '🔥 算力过载' },
      subtitle: { tag: 'plain_text', content: 'Overload · 额度见底，暂停接 bot 的单' },
      template: 'red',
      icon: { tag: 'standard_icon', token: 'warning_outlined' },
    },
    body: {
      direction: 'vertical',
      padding: '16px 16px 20px 16px',
      vertical_spacing: '10px',
      elements: [
        {
          tag: 'markdown',
          // A plain "@ALL" label, not <at id=all>: a real @所有人 would page the whole group and could wake its bots.
          content: `${(input.owners ?? []).map((id) => `<at id=${id}></at> `).join('')}@ALL`,
        },
        {
          tag: 'column_set',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              padding: '20px',
              background_style: 'red-50',
              elements: [
                { tag: 'markdown', content: '# 🥵', text_align: 'center' },
                { tag: 'markdown', content: '**被问冒烟了，先散会儿热**', text_align: 'center' },
                {
                  tag: 'markdown',
                  content: "<font color='grey'>🧯 过载保护已启动 · 风扇全速中</font>",
                  text_align: 'center',
                  text_size: 'notation',
                },
              ],
            },
          ],
        },
        ...input.windows.map((w) => ({
          tag: 'markdown',
          content: [
            `**${w.label}额度** \`${gauge(w.usedPercent)}\` **${w.usedPercent}%**<font color='grey'>（上限 ${w.limit}%）</font>`,
            w.resetAt !== undefined
              ? `⏳ ${time(w.resetAt)} 重置${w.resumeAt !== undefined ? `，${time(w.resumeAt)} 起恢复回答 bot` : ''}`
              : '⏳ 重置时间读不到，额度回落后恢复',
          ].join('\n'),
        })),
        HR,
        {
          tag: 'markdown',
          content: `这条 bot 的消息我先不处理${resume !== undefined ? `，${time(resume)} 后再来找我` : ''}。人类同事的消息照常回复，急事请让人直接 @ 我。`,
        },
        {
          tag: 'markdown',
          content: `<font color='grey'>额度留给人类同事 · 同一个群 ${input.cooldownMinutes} 分钟内只发一张 · 只 @ bot 的主人，不 @ 任何 bot</font>`,
          text_size: 'notation',
        },
      ],
    },
  };
}
