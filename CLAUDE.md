# lark-channel-bridge 开发约定

把飞书 / Lark 消息桥接到本机 agent CLI（Claude Code、Codex CLI）的 Node.js 服务。本文件是在这个仓库里改代码的权威约定；用户向的安装、命令、配置说明在 `README.zh.md` / `README.md`，这里不重复。

## 仓库边界

- 这是 boss 自己的 fork，只有一个 remote：`origin` = `git@github.com:mirsery/lark-coding-agent-bridge.git`。上游已移除：不加回 upstream、不往上游推分支 / 开 PR / 提 issue。需求记录开在 `mirsery/lark-coding-agent-bridge`。
- 默认分支 `main`。提交信息、代码注释、PR 描述里不出现任何 AI 工具署名（`Co-Authored-By: Claude …`、`Generated with …` 之类一律不加）。

## 本机运行形态（改动怎么生效）

- 全局命令 `lark-channel-bridge` 是指向**主 checkout**（`~/workspace/lark-coding-agent-bridge`）的 `npm link`；各 profile 的 daemon（`ai.lark-channel-bridge.bot.<profile>`，以及 `--web-ui` 的 supervisor）只在启动时加载一次 `dist/`。
- 所以：改代码 → 在主 checkout `pnpm build` → 重启对应 daemon 才生效。`pnpm build` 会重写线上 `dist/`，**半成品不要在主 checkout 构建**（见下方迭代流程，用 worktree）。
- **重启由 boss 决定**：默认只构建不重启，回复里写明「需重启生效」。boss 明确要求时才重启，用 `/restart-bridge`（`.claude/commands/restart-bridge.md`）——重启 CC 自己所在的 profile 会杀掉当前这轮 run，必须脱离进程树延时执行。
- 判断 daemon 是否落后于代码：`lark-channel-bridge ps` 的「启动」时间 vs `git log -1 --format=%ci`。

## 迭代流程

每个改动按这个顺序走，不跳步：

1. **独立 worktree**：`git -C ~/workspace/lark-coding-agent-bridge worktree add ~/workspace/.worktrees/bridge-<topic> -b <type>/<topic> main`，再 `ln -s ~/workspace/lark-coding-agent-bridge/node_modules node_modules`。不在主 checkout 上直接改。
2. **先读再改**：读受影响模块和离它最近的测试。bug 先复现——agent CLI 的行为以真实输出为准，用 `--model haiku` 跑一遍抓 stream 样本，不要凭文档猜协议。
3. **测试先行**：回归测试要能在修复前失败；新行为配 unit / integration 测试（工具见「测试」）。
4. **门禁**：`pnpm ci:local`（= `git diff --check` + `pnpm test` + `pnpm typecheck` + `pnpm build`），全绿才算过。
5. **提交**：格式见「提交规范」。
6. **合入与构建**：`/ship`（`.claude/commands/ship.md`）——ff 合回 main、push origin、在主 checkout 构建、清理 worktree。
7. **汇报**：改了什么、门禁结果（失败就贴失败）、是否需要重启。

## 质量门禁

- 通过标准只有一个：`pnpm ci:local` 全绿。迭代中可以先跑 `npx vitest run <文件或目录>` 缩小范围，但交付前必须跑全量。
- 已知噪声：机器负载高时，spawn 真实子进程的用例（`tests/process/`、`tests/unit/agent/*` 里的 fake binary 读流测试、`tests/integration/ui/server.test.ts`）可能撞 vitest 默认 5s 超时。处理方式：单独重跑该文件；必要时在未改动的 main 上跑同一文件对照，确认与本次改动无关，并在汇报里写明。不许把失败说成通过。
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
- **run 在第一个 `done` 结束。** executor 随后给 2s 宽限期等进程退出，超时就杀（日志 `post-done-exit-timeout`）；进程里还在跑的后台任务一起被杀。Claude 下一轮 `--resume` 时会先为这个残留任务的通知单独吐一个 `num_turns: 0` 的 `result`——adapter 暂存它，不当成 `done`（否则用户那轮会被吞，只剩 "No response requested."）。改 `stream-json` / adapter 时保持这个行为，相关测试在 `tests/unit/agent/claude-stream-json.test.ts`。
- **新增斜杠命令要过三处**：`handlers` 表；是否进 `ADMIN_COMMANDS`；帮助卡（`src/card/templates.ts`）。别名（如 `/reset` 之于 `/new`）要和本名一起进权限表，否则就是绕过。卡片按钮走 `runCommandHandler`，同样受管理员检查。
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
