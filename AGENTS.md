# lark-channel-bridge 开发约定

把飞书 / Lark 消息桥接到本机 agent CLI（Claude Code、Codex CLI）的 Node.js 服务。本文件是在这个仓库里改代码的权威约定，**Claude Code 与 Codex 共用**：Codex 直接读本文件，Claude Code 经 `CLAUDE.md` 导入本文件。用户向的安装、命令、配置说明在 `README.zh.md` / `README.md`，这里不重复。

维护要求：约定只写在这里，不要在 `CLAUDE.md` 或 `.claude/` 里另起一份；可执行的操作步骤写在 `docs/dev/`（两种 agent 都能读），`.claude/commands/` 只是指向它们的快捷入口。

## 仓库边界

- 这是 boss 自己的 fork，只有一个 remote：`origin` = `git@github.com:mirsery/lark-coding-agent-bridge.git`。上游已移除：不加回 upstream、不往上游推分支 / 开 PR / 提 issue。需求记录开在 `mirsery/lark-coding-agent-bridge`。
- 默认分支 `main`。提交信息、代码注释、PR 描述里不出现任何 AI 工具署名（`Co-Authored-By: Claude …`、`Co-Authored-By: Codex …`、`Generated with …` 之类一律不加）。

## 本机运行形态（改动怎么生效）

- 全局命令 `lark-channel-bridge` 是指向**主 checkout**（`~/workspace/lark-coding-agent-bridge`）的 `npm link`；各 profile 的 daemon（`ai.lark-channel-bridge.bot.<profile>`，以及 `--web-ui` 的 supervisor）只在启动时加载一次 `dist/`。
- 所以：改代码 → 在主 checkout `pnpm build` → 重启对应 daemon 才生效。`pnpm build` 会重写线上 `dist/`，**半成品不要在主 checkout 构建**（见下方迭代流程，用 worktree）。
- **重启由 boss 决定**：默认只构建不重启，回复里写明「需重启生效」。boss 明确要求时才重启，按 [`docs/dev/restart-bridge.md`](docs/dev/restart-bridge.md) 执行——CC（`claude` profile）和 Poki（`codex` profile）都跑在 bridge 里，重启自己所在的 profile 会杀掉当前这轮 run，必须脱离进程树延时执行。
- 判断 daemon 是否落后于代码：`lark-channel-bridge ps` 的「启动」时间 vs `git log -1 --format=%ci`。

## 迭代流程

每个改动按这个顺序走，不跳步：

1. **独立 worktree**：`git -C ~/workspace/lark-coding-agent-bridge worktree add ~/workspace/.worktrees/bridge-<topic> -b <type>/<topic> main`，再 `ln -s ~/workspace/lark-coding-agent-bridge/node_modules node_modules`。不在主 checkout 上直接改。
2. **先读再改**：读受影响模块和离它最近的测试。bug 先复现——agent CLI 的行为以真实输出为准，抓一份真实 stream 样本（Claude：`claude -p --output-format stream-json --verbose --model haiku`；Codex：`codex exec --json`），不要凭文档猜协议。
3. **测试先行**：回归测试要能在修复前失败；新行为配 unit / integration 测试（工具见「测试」）。
4. **门禁**：`pnpm ci:local`（= `git diff --check` + `pnpm test` + `pnpm typecheck` + `pnpm build`），全绿才算过。
5. **提交**：格式见「提交规范」。
6. **合入与构建**：按 [`docs/dev/ship.md`](docs/dev/ship.md)——ff 合回 main、push origin、在主 checkout 构建、清理 worktree。
7. **汇报**：改了什么、门禁结果（失败就贴失败）、是否需要重启。

## 质量门禁

- 通过标准只有一个：`pnpm ci:local` 全绿。迭代中可以先跑 `npx vitest run <文件或目录>` 缩小范围，但交付前必须跑全量。
- 已知噪声：机器负载高时，spawn 真实子进程的用例（`tests/process/`、`tests/unit/agent/*` 里的 fake binary 读流测试）可能撞 vitest 默认 5s 超时。（`tests/integration/ui/server.test.ts` 曾经偶发的 `4999 >= 5000` 是测试自身的时钟先后问题，已修。）处理方式：单独重跑该文件；必要时在未改动的 main 上跑同一文件对照，确认与本次改动无关，并在汇报里写明。不许把失败说成通过。
- CI（`.github/workflows/ci.yml`）在 macOS / Ubuntu / Windows 三平台跑 test + typecheck + build。Windows 上 `claude` 是 `.cmd` shim、经 `cmd.exe` 启动：prompt 和系统提示词不能走 argv（`<` `>` 会被当重定向吃掉），一律走 stdin / 临时文件。

## 架构地图

入口 `bin/lark-channel-bridge.mjs` → `dist/cli.js`（`src/cli/index.ts`，commander）。

| 目录 | 职责 |
|---|---|
| `src/cli/` | 宿主 CLI：`run` / `start` / `restart` / `ps` / `profile` / `migrate`，首次 bootstrap、agent 自动检测 |
| `src/runtime/` | profile 运行时装配、`run-executor`（提交 run、`done` 后回收进程）、supervisor、运行锁、在线 bot 注册表、adapter 工厂 |
| `src/agent/` | **agent 注册表 `registry.ts`**、各 agent adapter（`claude/`、`codex/`）、capability、模型目录、preflight、系统提示词 |
| `src/bot/` | 飞书消息入口 `channel.ts`（排队、合并、回复投递）、`run-flow.ts`（策略 + 恢复会话 + 提交 run）、云文档评论、进程池、卡片流 |
| `src/commands/` | 飞书内斜杠命令（`handlers` 表、`ADMIN_COMMANDS` 权限表） |
| `src/card/` | 卡片模板、运行卡渲染、配置卡、卡片回调签名与分发 |
| `src/session/` | per-scope `SessionStore`、`SessionCatalog`（按 scope+agent+cwd+策略指纹）、Claude / Codex 历史读取 |
| `src/policy/` | 访问控制（owner / admin / 名单）、run 策略、策略指纹 |
| `src/config/` | profile schema v2、root config 存取、keystore、v1→v2 迁移 |
| `src/scheduler/`、`src/meeting/`、`src/knowledge/` | 定时任务、会议机器人、跨会话记忆与 skill |
| `src/lark-cli/` | 每个 profile 私有的 lark-cli 配置投影与身份策略 |
| `src/ui/` + `web/` | Web 控制台 API（`src/ui`）与 React SPA（`web/`，`pnpm build:web` 产物内联进 `src/ui/generated/`，已 gitignore） |
| `src/daemon/` | launchd / systemd / schtasks 服务定义 |

## 不变量与踩过的坑

- **agent 分支只走注册表。** 共享代码不写 `agentKind === 'codex'` 这类字面判断（隐含的 else 会把新 agent 当成 Claude）。`tests/static/contracts.test.ts` 会拦；只有 agent 自己的代码（`src/agent/`、codex 配置段所在的 `src/config/` / `src/cli/`、`profile-runtime.ts` 里的历史迁移）可以点名某个 agent。
- **一轮在 `done` 结束，进程不一定。** Claude 以 `--input-format stream-json` 运行：一轮结束时没有后台任务，adapter 关闭 stdin，进程自己退出（executor 按 agent 描述里的 `exitGraceMs` 等它退出（Claude 10s——stdin 关闭后即使没有后台任务也要 1–3s 才退出，2s 会误杀；Codex 30s——`turn.completed` 后它还要花 5–15s 写 memories / thread-state 的 sqlite，过早杀会丢 `/resume` 列表等数据），超时才杀；等待只在后台进行，回复在 `done` 时就发出，下一轮也不等旧进程）；还有后台任务（后台 Bash、后台子 agent、Monitor）时进程留着（`ProcessSession` / `RunExecutor` 的 linger，最长 30 分钟），后台任务触发的续跑轮经 `onBackgroundTurn` 作为补充回复发出，期间同一会话的新消息直接 `send` 进这个进程，不重开、不杀后台任务；运行参数（cwd、model、effort、权限、会话）不一致时才停掉重开。`/stop`、`/new`、`/cd` 会连后台任务一起停。Claude `--resume` 时若有上个进程残留的后台任务通知，会先吐一个 `num_turns: 0` 的 `result`——adapter 暂存它，不当成 `done`。相关测试：`tests/integration/executor/background-linger.test.ts`、`tests/unit/agent/claude-stream-json.test.ts`、`tests/process/claude-adapter.test.ts`。
- **Codex 走 `codex app-server`**（`src/agent/codex/app-server-run.ts`）：一个会话一个常驻进程，`send` 即 `turn/start`，`stop` 先 `turn/interrupt`；空闲按 `idleKeepAliveMs`（10 分钟）后 `endInput` 让它退出——这类「空闲保留」不算后台任务（`/status`、`/stop` 回复、重启通知都不提）。app-server 没有 `--ignore-user-config` / `--ignore-rules`，相关 profile（或 `codex.transport: "exec"`）在 `prepareRun` 里退回 `codex exec`；未经 `prepareRun` 的直接调用也走 exec。协议是 experimental，翻译层测试用的是真实抓包 `tests/fixtures/codex-app-server-turns.json`，升级 codex-cli 后先重新抓包核对。
- **用量按人记账**（`usage.json`，`UsageLedger`）：executor 在每轮的 `usage` 事件上记到 `SubmitRunInput.actor` 名下，后台续跑轮记到最近一次提交的人；Claude 的 `total_cost_usd` 是整个会话的累计值——`--resume` 时 Claude 从转录里最后一条 `cost-state` 恢复此前的总额，同一进程内再逐轮累加——adapter 在 spawn 前读出这条 `cost-state` 作为基线（`claude/session-cost.ts`），逐轮相减；Codex 的 `turn.completed.usage` 是整个 thread 的累计值，adapter 在 `prepareRun` 里从该 thread 的 rollout（`token_count`）读出此前的累计作为基线再相减；`inputTokens` 一律含缓存部分。`/usage` 只有管理员私聊才显示所有人。
- **非管理员的操作审批**（#6，默认关闭，profile 设 `approvals.enabled: true` 才开）：开启时批次里有非管理员的消息即为 gated run（`SubmitRunInput.gate`）。`ApprovalBroker` 管理待审批项（5 分钟超时拒绝，只有管理员能允许、发起人可取消，「本轮都允许」到下一轮失效），`ApprovalNotifier` 把卡片发给主人和管理员私聊、给发起人发等待卡（按钮走 `/approval` 命令）。Claude 用 PreToolUse hook：`bin/approval-hook.mjs` 经 profile 目录下的 `approval.sock`（`ApprovalSocketServer`）问 broker，连不上一律拒绝；hook 设置不了时退回 plan（只读）。Codex app-server 用 `approvalPolicy: untrusted` + 只读沙箱，审批请求交给 `RunApprovals.decide`；exec 兜底只读。gated 与非 gated 的轮次不共用进程（compat key）。只读工具白名单在 `approvals.ts` 的 `READ_ONLY_TOOLS`，其余（Bash、写文件、`mcp__*`…）都要审批。profile 的 `approvals` 配置段：`enabled` 只有显式 `true` 才开（`runNeedsApproval` 是判定是否 gated 的唯一入口，IM 与云文档评论共用），`allowCommands` / `allowTools` 是免审批清单（broker 每次请求现读，按词前缀 / `*` 匹配，`;`、重定向、命令替换照样要审批）。Codex 的审批请求把命令包成 `/bin/zsh -lc "…"`，判定前先用 `unwrapShellCommand` 取出里面的脚本。审计写 `audit.jsonl`（追加、0600、保留 90 天），`/audit` 仅管理员私聊。
- **排队中的消息落盘**（`pending.json`，`PendingStore`）：重启 / 重连后 10 分钟内的自动补处理，更早的回一条通知请对方重发；重启时被停掉的后台任务也会在会话里说明。
- **新增斜杠命令要过三处**：`handlers` 表；是否进 `ADMIN_COMMANDS`；帮助卡（`src/card/templates.ts`）。别名（如 `/reset` 之于 `/new`）的权限要和本名一致：本名进了权限表，别名也要进，否则就是绕过。卡片按钮走 `runCommandHandler`，同样受管理员检查。
- **飞书审核**：消息可能被审核拒（错误码 230028），`reply()` 会退回一句中性文案；卡片里不要放完整邮箱（会被拒），账号只显示 `@` 前的用户名。
- **持久化状态**一律 `writeFileAtomic` + `mode: 0o600`（契约测试守护）。
- **测试隔离**：`tests/setup/clear-bridge-env.ts` 会清掉 `LARK_CHANNEL*` / `LARKSUITE_CLI_CONFIG_DIR`。在 bridge 会话里跑测试时别依赖真实 profile；读宿主配置的代码要显式置空这些变量，不要继承父进程。
- **共享 bot / card / commands 代码不 import `agent/codex` 内部**（契约测试），需要 agent 相关能力走 `src/agent/` 的中立出口。

## 新增一种 agent

注册表 `src/agent/registry.ts` 是唯一名单。步骤：

1. `AGENT_KINDS` 追加 id，`AGENT_DESCRIPTORS` 补描述（字段含义见类型注释：会话句柄、是否写 scope SessionStore、回复投递方式、图片参数、权限模型、系统提示词注入方式等）。
2. 跑 `pnpm typecheck`，编译器会逐个列出还缺条目的 `Record<AgentKind, …>`，目前是：
   - `src/runtime/agent-runtime.ts` → `ADAPTER_FACTORIES`（构造 adapter）
   - `src/agent/models.ts` → `MODEL_CATALOGS`（模型 / effort 选项、实际模型名展示）
   - `src/agent/account.ts` → `ACCOUNT_NAMES`（回复卡 Sponsor）
   - `src/commands/index.ts` → `RESUME_LISTS`（`/resume` 列表）
3. 新建 `src/agent/<id>/adapter.ts` 实现 `AgentAdapter`（`src/agent/types.ts`）：spawn CLI、prompt 走 stdin、按行解析输出并翻译成 `AgentEvent`；每轮结束恰好一个 `done`（或 `error`），`system` / `done` 事件带上描述里声明的会话句柄字段；实现 `waitForExit` 与带宽限期的 `stop`。
4. 测试：真实输出抓样本 → translator 单测；fake binary 读流测试（参照 `tests/unit/agent/claude-stream-json.test.ts`）；进程级契约测试（参照 `tests/process/`）。
5. 如果新 agent 需要自己的配置段（像 `codex.binaryPath`），在 `src/config/profile-schema.ts` 加类型、校验和默认值，bootstrap 在 `src/cli/profile-bootstrap.ts`。
6. Web 控制台的 agent 选择框和 effort 提示从后端读（`/api/onboard/state` 的 `agents`、配置里的 `effortHint`），不用改前端。

## 测试

- 分层：`tests/unit/`（纯逻辑）、`tests/integration/`（命令 / 消息流 / 存储，走 fake channel 与 fake agent）、`tests/process/`（真实 spawn 的 adapter 契约）、`tests/static/`（架构契约）。
- 常用工具（`tests/helpers/`）：`createFakeChannel`（记录发出的消息 / 卡片）、`createFakeAgent`（脚本化事件流）、`createTmpProfile`（临时 profile 目录）、`fake-executable`（假 CLI 二进制）。命令类测试照 `tests/integration/commands/commands-v1.test.ts` 的 harness 写。
- 断言用户可见文案时只断言关键短语，避免把整句文案钉死。

## 提交规范

```
<type>(<scope>): <中文一句话说明改了什么>

- 为什么改 / 修的是什么现象
- 关键实现取舍
- 新增或调整的测试
```

`type` 用 `feat` / `fix` / `refactor` / `test` / `docs` / `chore`；`scope` 取主要模块（`commands`、`claude`、`card`、`agent`、`preflight`…）。一个提交只做一件事。

## 运行时排查

- 在线 bot：`lark-channel-bridge ps`；单个 profile：`lark-channel-bridge status --profile <name>`。
- 日志：`~/.lark-channel/profiles/<profile>/logs/daemon/daemon-{stdout,stderr}.log`（人读）与 `logs/bridge-YYYYMMDD.jsonl`（结构化，按 `runId` / `traceId` 串起一轮）。
- Claude 会话转录：`~/.claude/projects/<cwd 编码>/<sessionId>.jsonl`，默认工作目录的会话在 `-Users-mac--lark-channel-workspaces-<profile>-default/` 下，`/cd` 过的在对应 cwd 的目录下。排查「消息被吞」「回复为空」先看这里的 `queue-operation` 与 assistant 记录。
- Codex 会话记录：`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`（`codex` profile 继承本机 `~/.codex`），按 thread id 找对应文件。

## 两种 agent 各自的入口

| | Claude Code（CC） | Codex（Poki） |
|---|---|---|
| 自动加载的约定 | `CLAUDE.md` → 导入本文件 | 本文件 |
| 交付 / 重启 | `/ship`、`/restart-bridge`（`.claude/commands/`，内容指向 `docs/dev/`） | 直接按 `docs/dev/ship.md`、`docs/dev/restart-bridge.md` 执行 |
| 权限护栏 | `.claude/settings.json` 的 deny 列表 | 无对应配置，按本文件「仓库边界」自律 |

改动约定时两边都要能用：不写只有一种 agent 才看得懂的步骤（例如只给 slash command 不给文档），新增操作流程先写 `docs/dev/`，需要的话再给 `.claude/commands/` 加一个指向它的入口。
