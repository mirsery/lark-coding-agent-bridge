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
  agentName: string;
  runtimeAccess: {
    label: string;
    value: string;
  };
  larkCliStatus?: 'app' | 'user-ready' | 'user-missing' | 'check-failed';
  /** One-line git summary of `cwd`; absent when it is not a repository. */
  git?: string;
  activeRun: boolean;
  activeScopes?: string[];
  activeCommentScopes?: string[];
  queue?: { active: number; waiting: number; cap: number };
  ownerState: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
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
    `🔗 **session**: ${sessionLine}`,
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
    `🛡 **${escapeMd(info.runtimeAccess.label)}**: ${escapeMd(info.runtimeAccess.value)}`,
    ...(info.larkCliStatus ? [`🔐 **lark-cli**: ${info.larkCliStatus}`] : []),
    `🏃 **active run**: ${info.activeRun ? 'yes' : 'no'}`,
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

export function helpCard(agentName = 'Agent'): object {
  const escapedAgentName = escapeMd(agentName);
  return shell('💡 使用帮助', [
    divMd(
      [
        '**命令列表**',
        '',
        '- `/new` `/reset` — 清空当前 chat 的会话',
        '- `/new chat [name]` — 新建群+新会话，自动拉你进群',
        '- `/resume [N]` — 列出并恢复历史会话（最多 N 条）',
        '- `/cd <path>` — 切换工作目录（会重置 session）',
        '- `/ws list|save <name>|use <name>|remove <name>` — 工作目录',
        '- `/account` — 查看当前应用；`/account change` 换 appId/secret 并重连',
        '- `/config` — 调整偏好、访问控制和 lark-cli 身份策略',
        '- `/status` — 当前状态',
        '- `/stop` — 结束当前正在跑的任务（也可点卡片底部 ⏹ 终止 按钮）',
        '- `/stop comment:<scopeHash>` — 管理员停止云文档评论任务',
        '- `/timeout [N|off|default]` — 当前 session 的探活分钟数,`/config` 改全局默认',
        '- `/timeout comment:<scopeHash> N` — 管理员设置云文档评论任务探活',
        '- `/diff [staged|<ref>]` — 看当前工作目录的改动，长 patch 会附带文件',
        '- `/worktree [add|use|remove]` — 任务级 worktree，创建后会话自动切过去',
        '- `/pr [编号|链接]` — 当前分支的 PR、CI 与评审状态',
        '- `/ps` — 列出本机所有 bot,标识当前正在回复的那个',
        '- `/exit <id|#>` — 关掉指定 bot(用 `/ps` 看 id/序号)',
        '- `/reconnect` — 强制重连 WebSocket(网络抖动后 bot 没反应时用)',
        `- \`/doctor [描述]\` — 把日志和描述交给 ${escapedAgentName} 自助诊断`,
        '- `/coffee` — 来一杯电子咖啡 ☕',
        '- `/help` — 本帮助',
        '',
        `其他内容直接交给 ${escapedAgentName}。`,
      ].join('\n'),
    ),
    HR,
    actions([
      { text: '📊 状态', value: { cmd: 'status' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '🔍 改动', value: { cmd: 'diff' } },
      { text: '🆕 新会话', value: { cmd: 'new' } },
    ]),
  ]);
}

/** Fixed schema-2.0 card — same output everywhere `/coffee` is sent, unlike
 * the ad-hoc cards an agent session would otherwise improvise per-chat. */
export function coffeeCard(): object {
  return {
    schema: '2.0',
    config: { width_mode: 'default', summary: { content: '☕ Antelope 电子咖啡' } },
    header: {
      title: { tag: 'plain_text', content: '☕ Antelope 电子咖啡' },
      subtitle: { tag: 'plain_text', content: 'Antelope · 不含咖啡因,但管用' },
      template: 'orange',
      icon: { tag: 'standard_icon', token: 'gift_outlined' },
    },
    body: {
      direction: 'vertical',
      padding: '16px 16px 20px 16px',
      vertical_spacing: '10px',
      elements: [
        {
          tag: 'column_set',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              padding: '24px',
              background_style: 'orange-50',
              elements: [
                { tag: 'markdown', content: '# ☕', text_align: 'center' },
                { tag: 'markdown', content: '**Antelope 电子咖啡一杯**', text_align: 'center' },
                {
                  tag: 'markdown',
                  content: "<font color='grey'>🦌 Antelope Roast · 现磨现发</font>",
                  text_align: 'center',
                  text_size: 'notation',
                },
              ],
            },
          ],
        },
        HR,
        {
          tag: 'markdown',
          content: "<font color='grey'>零卡路里 · 零等待 · 续杯免费 · 熬夜专用</font>",
        },
      ],
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

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
