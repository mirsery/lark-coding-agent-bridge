# lark-channel-bridge

把飞书 / Lark 消息和本地 Claude Code 或 Codex CLI 打通的轻量 bot。用一条命令启动，扫码绑定 PersonalAgent 应用，然后在飞书里和本机编程助手对话，让它读图、处理文件、改代码。

[English README](./README.md)

关于能实现的效果，详情可以阅读[飞书文档](https://larkcommunity.feishu.cn/docx/OaRIdFIRFoLM3xxTmKwcetHqn5e)

## 主要功能

- 在飞书私聊直接发消息，或在群里 `@bot`，把任务转给本机 Claude Code / Codex CLI。
- **流式卡片**：文本回复和工具调用实时更新在同一张卡片上。
- **COT 过程消息**：可选先发一条过程消息展示 agent 的阶段性文本和工具调用，再单独发送最终答案。
- **会话延续**：每个聊天、话题或文档评论有自己的会话，不会互相串。
- **排队与消息合并**：短时间连续发送的消息会合并处理；任务运行中收到的普通消息会排队到下一轮，`/new`、`/cd`、`/ws use`、`/stop` 这类命令可以中断当前任务。
- **多工作空间**：用 `/cd` 切换当前项目，用 `/ws` 保存和复用常用项目目录。
- **图片 / 文件**：直接发给 bot，bridge 下载到本地后交给本机 agent 处理。
- **卡片按钮**：`/help`、`/ws list`、`/status` 返回可点击的交互卡片。

## 前置条件

- Node.js **>= 20.12.0**
- 本机至少安装并登录一个 agent：
  - Claude Code：`claude`，安装说明：https://docs.anthropic.com/en/docs/claude-code/quickstart
  - Codex CLI：`codex`，安装说明：https://developers.openai.com/codex/cli
- 一个飞书 / Lark PersonalAgent 应用。首次启动的扫码向导可以帮你创建并绑定。

## 安装（本 fork：源码构建 + npm link）

本仓库是 [`mirsery/lark-coding-agent-bridge`](https://github.com/mirsery/lark-coding-agent-bridge) 的定制 fork，包含卡片 Sponsor 署名、任务面板、联调帮助分组等 npm 包里没有的改动。**不要用 `npm i -g lark-channel-bridge` 安装**，否则跑的是上游发布版，本 fork 的改动全部不生效。

```bash
git clone git@github.com:mirsery/lark-coding-agent-bridge.git ~/workspace/lark-coding-agent-bridge
cd ~/workspace/lark-coding-agent-bridge
pnpm install        # prepare 脚本会顺带执行一次 build
pnpm build          # 构建 web 控制台 + dist/
npm link            # 全局 lark-channel-bridge 软链到本仓库
```

确认全局命令指向本仓库，而不是 npm 安装版：

```bash
readlink -f "$(command -v lark-channel-bridge)"
# 期望输出：~/workspace/lark-coding-agent-bridge/bin/lark-channel-bridge.mjs
```

> 如果用 nvm 管理 Node，`npm link` 装在当前 Node 版本的全局目录下。切换 Node 版本后需要重新 `npm link`，并同步更新 launchd plist 里的 node 路径。

## 首次启动

首次绑定 PersonalAgent 应用时在前台跑，并显式指定 profile 和 agent：

```bash
lark-channel-bridge run --profile claude --agent claude
```

第一次运行会进入扫码向导：

1. 终端渲染二维码。
2. 用飞书 App 扫码。
3. 选择或创建 PersonalAgent 应用。
4. 成功后配置写入 `~/.lark-channel/config.json`。

如果已经有 PersonalAgent app，可以加 `--app-id cli_xxx` 跳过创建应用流程，命令会提示输入 App Secret。Lark 国际版应用加 `--tenant lark`。

确认能在飞书里正常收发消息后，`Ctrl-C` 停掉前台进程，改用下面的后台服务。

## 本机启动方式

本机常驻两个 launchd 用户服务，都随登录自动启动，并由 `KeepAlive` 保活：

| launchd Label | 启动命令 | 作用 |
|---|---|---|
| `ai.lark-channel-bridge.bot.claude` | `lark-channel-bridge run --profile claude` | 飞书 bot「CC」，接 Claude Code |
| `ai.lark-channel-bridge.bot.supervisor` | `lark-channel-bridge run --web-ui` | 本地 web 控制台 |

两个服务都设置了 `LARK_CHANNEL_HOME=~/.lark-channel`，PATH 里带上 nvm 的 Node bin 目录。

首次安装服务：

```bash
lark-channel-bridge start --profile claude   # 生成并加载 ai.lark-channel-bridge.bot.claude
lark-channel-bridge start --web-ui           # 生成并加载 ai.lark-channel-bridge.bot.supervisor
```

日常查看与启停：

```bash
lark-channel-bridge status --profile claude
lark-channel-bridge restart --profile claude
lark-channel-bridge stop --profile claude
```

控制台端口每次启动随机分配，地址（含 token）记录在 `~/.lark-channel/ui.json`。用 `ui` 命令打开或打印：

```bash
lark-channel-bridge ui           # 在浏览器打开控制台
lark-channel-bridge ui --print   # 只打印地址
```

注意：`claude` profile 由自己的 per-profile daemon 托管，控制台拿不到它的运行锁，可能会把它显示为未运行。以 `status --profile claude` 和飞书实际收发为准，详见下文「Web 控制台」。

### 改代码后生效

daemon 只在启动时加载一次 `dist/`，改了源码必须先构建再重启：

```bash
cd ~/workspace/lark-coding-agent-bridge
pnpm build
lark-channel-bridge restart --profile claude
lark-channel-bridge status --profile claude
```

判断正在运行的 daemon 是否落后于代码：比较 `git log -1 --format=%ci` 和 `ls -la dist/cli.js` 的时间，构建早于最新提交就说明没生效。重启会让 bot 断线几秒，挑没有任务在跑的时候做，可以先在飞书发 `/show-tasks` 确认。

### 日志与数据

- bot 日志：`~/.lark-channel/profiles/claude/logs/daemon/daemon-{stdout,stderr}.log`
- 控制台日志：`~/.lark-channel/profiles/supervisor/logs/daemon/`
- 结构化日志：`~/.lark-channel/profiles/claude/logs/bridge-YYYYMMDD.jsonl`
- 会话与运行中任务：`~/.lark-channel/profiles/claude/sessions.json`、`runs.json`

## 后台运行

`run` 适合首次配置和前台调试。确认 bot 能正常收发消息后，先用 `Ctrl-C` 停掉前台进程，再用系统服务常驻后台：

```bash
lark-channel-bridge start
lark-channel-bridge status
lark-channel-bridge stop
```

服务层命令必须先全局安装，不能直接用 `npx`。daemon 的 launchd plist / systemd unit / Windows 任务会记录 bridge CLI 的路径；如果这个路径来自 npm 临时缓存，缓存清掉后 daemon 就起不来。`run` 用 `npx` 单次启动没问题。

服务层命令按 profile 注册，每个 profile 有独立服务：

```bash
lark-channel-bridge start [--profile <name>]
lark-channel-bridge stop [--profile <name>]
lark-channel-bridge restart [--profile <name>]
lark-channel-bridge status [--profile <name>]
lark-channel-bridge unregister [--profile <name>]
```

平台映射：
- **macOS**：launchd 用户代理 `ai.lark-channel-bridge.bot.<profile>`
- **Linux**：systemd 用户单元 `lark-channel-bridge.bot.<profile>.service`
- **Windows**：Task Scheduler 任务 `LarkChannelBridge.Bot.<profile>`，launcher 是 `.cmd`

daemon 日志在 `~/.lark-channel/profiles/<profile>/logs/daemon/`。

### Web 控制台（`--web-ui`）

`--web-ui` 是上面单 profile 后台服务的**替代方案**，不是可以叠加使用的附加项。给 `start` 加上它，会启动一个"全机唯一"的 supervisor 进程，统一托管所有 profile，并提供本地 web 控制台来启动/停止/配置它们：

```bash
lark-channel-bridge start --web-ui
```

同一台机器上，两种模式二选一：
- **单 profile 后台服务**（`start [--profile <name>]`，不带 `--web-ui`）——就是上面几条命令建立的方式，没有 web 控制台。
- **Supervisor 控制台**（`start --web-ui`）——一个进程托管所有 profile，控制台展示的状态直接来自这个进程自身。

⚠️ **不要对同一个 profile 同时用这两种方式。** 如果某个 profile 已经有单 profile 后台服务在跑，这时又单独起了 `run --web-ui` / `start --web-ui`，控制台会尝试去接管这个 profile，但拿不到它的 runtime lock（已经被前一个进程持有），于是静默失败并把它显示为**未运行**——即便原来那个 daemon 其实还活着、还在正常收发消息。控制台目前只能感知自己托管的 profile，感知不到被其他进程保活的 profile。想用控制台的话，先停掉单 profile 后台服务（`lark-channel-bridge stop --profile <name>`），再让控制台来接管启动。

### 多 profile：分别运行 Claude 和 Codex

默认情况下，bridge 使用当前激活的 profile；可以通过 `profile use <name>` 切换。每个 profile 会维护独立的应用凭据、会话、工作目录和日志。只有在需要同时连接多个 PersonalAgent 应用，或分别运行 Claude 和 Codex 时，才需要创建多个 profile：

```bash
lark-channel-bridge start --profile claude --agent claude
lark-channel-bridge start --profile codex --agent codex
```

例如只重启 Codex bot：

```bash
lark-channel-bridge restart --profile codex
lark-channel-bridge status --profile codex
```

#### 用已有机器人新建 profile

如果机器人已经在飞书 / Lark 开放平台建好了（不走扫码创建），用它的 App ID 建 profile，再作为后台服务启动：

```bash
# 1. 先登录 agent CLI（以 Codex 为例；Claude 用 claude 自己的登录）
codex login --device-auth

# 2. 用已有应用建 profile。不要写 --app-secret：
#    命令会提示输入，Secret 不会留在 shell 历史里
lark-channel-bridge profile create codex \
  --agent codex \
  --app-id cli_xxxxxxxxxxxx \
  --workspace ~/workspace

# 3. 以系统托管的后台服务启动（登录后自启）
lark-channel-bridge start --profile codex

# 4. 查看状态
lark-channel-bridge status --profile codex
lark-channel-bridge profile list
```

执行第 2 步之前，先在开放平台确认：

- 已开启 **机器人** 能力。
- **事件订阅** 选 **长连接**，并订阅「接收消息」（`im.message.receive_v1`），否则机器人收不到任何消息。
- 这个应用 **没有被别的 profile 占用**。一个应用接两个 profile，两边会消费同一批事件，同一条消息会被回复两次。

Lark 国际版应用加 `--tenant lark`。日常管理和其他 profile 一样：`restart` / `stop --profile codex`，或用 `lark-channel-bridge ui` 打开网页控制台。

### 重启 `npm link` 出来的本地开发副本

如果 `PATH` 里的 `lark-channel-bridge` 是 `npm link` 到本仓库某个本地 checkout 的（`npm ls -g lark-channel-bridge` 显示的是软链到仓库目录，而不是一个带版本号的 npm 安装），那正在跑的 daemon 只反映它**启动那一刻** `dist/` 里的内容——Node 进程启动时把编译好的 JS 一次性加载进内存，不会热更新。之后改源码、甚至跑了 `pnpm build`，对这个已经在跑的 daemon 都不生效。

```bash
pnpm build                                    # 用当前源码重新编译 dist/
lark-channel-bridge restart --profile <name>  # 让正在跑的 daemon 重新加载
lark-channel-bridge status --profile <name>   # 确认起来了
```

最容易踩的坑是漏掉 `pnpm build` 这一步——单独跑 `restart` 只是拿磁盘上现成的 `dist/` 重新拉起 daemon，如果忘了先编译，加载的还是旧代码，而且不会报错提示你。想不重启就先确认是否过期：对比 `git log -1`（最新 commit 时间）和 `ls -la dist/cli.js`（上次编译时间）——编译时间早于最新 commit，说明该重启了。重启会让 daemon 的在线连接断几秒，launchd/systemd 服务里的 `KeepAlive` 会自动拉起，但最好挑一个手头没有任务正在进行的时间点执行。

## 命令速查

### 宿主 CLI

```text
lark-channel-bridge run [--profile <name>] [--agent claude|codex] [--workspace <path>] [-c <config>]
lark-channel-bridge migrate [--profile <name>] [--agent claude|codex]
lark-channel-bridge ps
lark-channel-bridge kill <id|#>
lark-channel-bridge --help
```

`profile use <name>` 会切换后续默认启动使用的 profile。需要同时跑 Claude / Codex 两个 bot、连接多套 PersonalAgent 应用，或做脚本化部署时，再使用这些 profile 管理命令：

```bash
lark-channel-bridge profile create claude --agent claude
lark-channel-bridge profile create codex --agent codex
lark-channel-bridge profile list
lark-channel-bridge profile use <name>
lark-channel-bridge profile remove <name>
lark-channel-bridge profile remove <name> --purge --yes
lark-channel-bridge profile export <name> [--output ./profile.json] [--force]
lark-channel-bridge profile export <name> --include-secrets --yes
```

`profile remove` 默认归档本地状态，也可以删除当前激活的 profile。若还剩其他 profile，会自动切到下一个；若这是最后一个 profile，会清空 root config，之后可以用同名重新创建。只有加 `--purge --yes` 才会永久删除。`profile export` 默认脱敏 app secret；只有加 `--include-secrets --yes` 才会导出敏感配置。

如果某个 profile 被建成了错误的 agent 类型，先 `stop` 或 `unregister --profile <name>` 清理对应后台服务，再 `profile remove <name>`，然后用正确的 `--agent` 重新创建。

### 飞书内斜杠命令

| 命令 | 作用 |
|---|---|
| `/new`, `/reset` | 清空当前会话 |
| `/cd <path>` | 切换工作目录并重置会话 |
| `/ws list` | 列出命名工作空间 |
| `/ws save <name>` | 把当前工作目录保存为命名工作空间 |
| `/ws use <name>` | 切换到命名工作空间 |
| `/ws remove <name>` | 删除命名工作空间 |
| `/resume` | 恢复同 agent、工作目录、权限模式兼容的历史会话 |
| `/status` | 查看 profile、agent、工作目录、会话、lark-cli 身份和运行状态 |
| `/config` | 调整展示偏好、访问控制和 lark-cli 身份策略 |
| `/invite user @某人` | 允许用户私聊使用 bot |
| `/invite admin @某人` | 添加访问控制管理员 |
| `/invite group` | 允许当前群使用 bot |
| `/invite group restricted @某人...` | 允许当前群使用 bot，但只对 @ 到的人生效 |
| `/invite member @某人` | 把这个人加进当前群的专属名单 |
| `/invite all group` | 允许 bot 所在的所有群使用 |
| `/remove user @某人`, `/remove admin @某人`, `/remove group`, `/remove member @某人` | 移除访问控制条目 |
| `/stop` | 停止当前 run，也可点卡片停止按钮 |
| `/timeout [N\|off\|default]` | 设置或清除当前会话的 idle watchdog |
| `/memory [add\|forget\|clear]` | 跨会话记忆，`--global` 写到全局 |
| `/skills [show <名字>]` | agent 按需读取的 skill 索引 |
| `/knowledge [bind\|sync\|unbind]` | 记忆与 skill 的 git 同步 |
| `/diff [staged\|<ref>]` | 查看工作目录的改动，patch 过长时附带完整文件 |
| `/worktree [add\|use\|remove]` | 管理任务级 worktree，会话自动跟着切 |
| `/pr [编号\|链接]` | 当前分支的 PR、CI 与评审状态 |
| `/cron add <时间> \| <任务>` | 新建定时任务 |
| `/cron list\|show\|run\|pause\|resume\|remove` | 管理定时任务 |
| `/ps` | 列出本机 bridge 进程 |
| `/exit <id\|#>` | 停止指定 bridge 进程 |
| `/reconnect` | 强制 WebSocket 重连 |
| `/doctor [描述]` | 执行低敏诊断 |
| `/help` | 帮助卡片 |

私聊不需要 @。群和话题群默认必须 `@bot`；`@all` 会被忽略。支持的云文档评论里 @bot 就会触发回复。

## 记忆与 skills

每个 profile 有一份跨会话的知识目录——你在一次对话里教会它的约定，不会因为会话重置就消失。

每轮运行都会注入一个 `<bridge_knowledge>` 块：

- **全局记忆**：这个 profile 下所有会话共享的约定。
- **会话记忆**：只属于当前会话／话题的上下文。两者冲突时以会话记忆为准。
- **skill 索引**：每个 `SKILL.md` 的名字、一句话描述和路径——**只有索引**。正文由 agent 在需要时自己打开，所以十几个 skill 每轮只花几十 token，而不是几千。

```text
/memory                       # 当前生效的记忆
/memory add <内容>            # 记到本会话
/memory add --global <内容>   # 记到全局（管理员）
/memory forget <id>
/memory clear [--global]
/skills                       # skill 索引
/skills show <名字>
```

能在某个会话里用 bot 的人都能写这个会话的记忆；全局记忆和知识仓库是管理员权限，普通成员也无法靠猜 id 删掉一条全局记忆。

### 存在哪里，怎么同步

```text
~/.lark-channel/profiles/<profile>/knowledge/
  MEMORY.md                 # 全局记忆
  chats/<scope>.md          # 按会话的记忆
  skills/<名字>/SKILL.md    # 可复用的指令
```

全是 `0600` 的纯 Markdown，随便哪个编辑器都能改——这正是设计目的：这个目录就是一个 git 仓库。

```text
/knowledge                       # 条数、远端、同步状态
/knowledge bind <git 地址>       # 绑定远端并拉取已有内容
/knowledge sync                  # 提交本地改动、拉取、推送
/knowledge unbind                # 解绑但保留本地内容
```

绑定是合并而不是覆盖，所以绑之前写的记忆不会丢。同一个仓库可以给多个 profile、多台机器共用——靠各自的 `/knowledge sync` 搬运内容，凭据用的还是那台机器上已有的 git 配置。`/status` 里有一行展示条数与同步状态。

Claude 和 Codex 读的是同一份 skill 索引，一个文件同时服务两种 agent。定时自动同步还没接上——先手动 `/knowledge sync`，等调度层落地后可以排成定时任务。


## Git 能力

当会话的工作目录是 git 仓库时，bridge 不再对它一无所知。

- **`/status`** 多一行 git 信息：分支、与上游的偏离（`↑2 ↓1`）、未提交的内容，以及当前目录是不是一个 linked worktree。
- **`/diff [staged|<ref>]`** 把改动渲染成卡片：逐文件的 `+`/`-` 数、未跟踪文件，以及一段 patch 摘录。`/diff` 是全部未提交改动，`/diff staged` 只看已暂存，`/diff main` 看这个分支相对 `main`（从共同祖先算起）新增了什么。摘录放不下时，完整 patch 会作为 `.patch` 文件紧跟着发出来，随手就能拿去别处打开。
- **`/worktree`** 管理任务级 worktree。`/worktree add <分支> [起点]` 会在仓库**旁边**创建（`../.worktrees/<仓库>-<分支>`，不放在仓库里面，免得污染父仓库的 status 和文件扫描），然后把会话切过去并重置会话——和 `/cd` 是同一套约定。`/worktree use <分支|路径>` 在已有的之间切换，`/worktree remove <分支|路径> [--force]` 删除。主 checkout 和会话当前所在的那个都受保护。
- **`/pr [编号|链接]`** 展示当前分支的 PR：标题、`head → base`、评审结论、CI 汇总（含失败的 check 名字），还有一个刷新按钮。

`/pr` 走本机的 [GitHub CLI](https://cli.github.com)，用的是**你自己**的 `gh` 登录态，bridge 不需要也不保存任何 GitHub token。没装 `gh` 或没登录时会直接说明，而不是静默失败。其余能力只依赖 `git`；工作目录不是仓库时，一切照旧。

从聊天里传进来的 ref 会先做校验再交给 git，一条消息不可能变成另一个 git 命令。
## 定时任务

`/cron` 按计划执行一段 prompt，并把结果发回创建它的会话——每天巡检日志、发版前自检、或者一个真的会动手的提醒。

```text
/cron add 0 9 * * 1-5 | 总结昨天 CI 的失败
/cron add @daily | 扫一遍 error 日志，挑出新增的问题
/cron add in 30m | 看看那次部署完成没有
/cron add at 2026-10-01 09:30 | 起草月报
```

- **时间写法**：标准 5 字段 cron（分 时 日 月 周，支持列表、区间和 `*/步长`）、`@hourly` / `@daily` / `@weekly` / `@monthly` 别名，以及一次性的 `in <时长>` 和 `at <时刻>`。全部按宿主机本地时区计算。`|` 用来分隔时间和任务内容。
- **每个任务独立 scope**：任务跑在自己的会话 scope（`cron:<id>`）里，工作目录取创建时的当前目录，不会和聊天本身的会话互相干扰。加 `--continue` 可以让多次运行复用同一个会话，默认每次都是新会话。
- **结果投递**：结果以一条完成后的消息发出（卡片或 markdown，跟随 `/config`），不是实时流——任务触发时不一定有人在看。在话题里创建的任务会回到那个话题里。
- **权限**：`/cron` 仅管理员可用，并且每次触发都会重新校验创建者的权限——把某人移出名单，他留下的任务也会随之停摆。任务只能在创建它的会话里管理。
- **触发时机**：只有持有该 profile 的进程会 tick 调度器，所以任务不会重复触发；bridge 没在跑的时候不会执行。错过超过 6 小时的 cron 触发会跳过而不是补跑（笔记本睡过 09:00、10:00 醒来仍会执行）；一次性任务即使迟到也一定会执行。
- **失败处理**：失败会在会话里报出来，连续失败 5 次自动暂停任务，`/cron resume <id>` 恢复并清空失败计数。
- **中断**：`/cron pause <id>` 和 `/cron remove <id>` 会顺带中断该任务正在执行的那一次——定时任务跑在自己的 scope 里，聊天里的 `/stop` 够不到它。

任务按 profile 存在 `jobs.json`（见数据目录）。


## 回复展示与 COT

`/config` 可以调整三类展示选项：

- **消息回复方式**：`消息卡片` 流式更新最终回复；`纯文本` 在 run 完成后一次性发送。
- **工具调用显示**：控制最终回复卡片 / markdown 中是否展示工具块。
- **COT 过程消息**：`关闭` 只发送最终回复；`简略` 先用 COT 消息展示 agent 的过程文本和工具摘要；`详细` 还会展示工具参数和截断后的输出。

开启 COT 后，bridge 会把过程消息和最终答案拆成两条消息。过程消息用于追踪 agent 做了什么；最终答案仍由 agent 原始文本生成，bridge 不做启发式过滤。若 agent 把最终答案也作为普通流式文本输出，COT 过程消息中可能会出现对应片段。

## lark-cli 身份策略

每个 profile 都使用当前 profile 的 lark-cli 目录：`~/.lark-channel/profiles/<profile>/lark-cli`。agent 子进程会收到指向这个目录的 `LARKSUITE_CLI_CONFIG_DIR`，所以一个 profile 里的个人授权不会共享给另一个 profile。

默认策略是 `bot-only`：lark-cli 使用应用 / bot 身份，不访问个人资源。当用户为了日历、邮箱、云盘等个人资源完成授权后，当前 profile 可以切到 `user-default`，保留应用身份，同时允许已授权的用户身份。owner/admin 可以在 `/config` 查看或切换这个策略；`/status` 会用 `lark-cli: app` 或 `lark-cli: user-ready` 展示当前摘要。

## 工作目录

每个 profile 都可以有一个默认工作目录：`workspaces.default`。新建 profile 时可以传 `--workspace <path>` 作为初始目录；没传时 bridge 会创建一个 profile 托管的默认工作目录。

下面只是 profile 里的字段片段，不要整段覆盖 `config.json`；请改对应 profile 下的 `workspaces` 字段。

```json
{
  "workspaces": {
    "default": "/Users/me/.lark-channel-workspaces/claude/default"
  }
}
```

bridge 会检查所选目录存在、是目录，并且不是 `/`、Home 根、系统目录或临时目录根这类范围过大的位置。工作目录只是 agent run 的当前目录，不是文件系统 sandbox；agent 实际能访问哪些文件仍取决于本机 agent 进程及其权限模式。

## 权限模式

推荐给用户配置的是 `permissions.defaultAccess` 和 `permissions.maxAccess`。新 profile 默认两项都是 `full`，以保持 bridge 的本地工具、授权流程、文件写入等能力完整可用。如需收紧权限，可以改成 `workspace` 或 `read-only`；收紧后本地工具执行、登录 / 授权流程、文件写入等能力可能受限。

下面只是 profile 里的字段片段，不要整段覆盖 `config.json`；请改对应 profile 下的 `permissions` 字段。

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

模式映射：

| Bridge access | Claude permission mode | Codex mode |
|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` |
| `workspace` | `acceptEdits` | `workspace-write` |
| `read-only` | `plan` | `read-only` |

旧版 `sandbox` 字段仍可读取。bridge 保存 profile 后，会把该设置迁移为 canonical `permissions`。

## 数据目录

| 路径 | 内容 |
|---|---|
| `~/.lark-channel/config.json` | root config，包含 profiles 和 active profile |
| `~/.lark-channel/active-profile` | 最近选择的 profile |
| `~/.lark-channel/profiles/<profile>/sessions.json` | 会话状态 |
| `~/.lark-channel/profiles/<profile>/sessions.json.catalog.json` | agent-aware 会话索引 |
| `~/.lark-channel/profiles/<profile>/knowledge/` | 记忆与 skills（可作为 git 仓库同步） |
| `~/.lark-channel/profiles/<profile>/jobs.json` | 定时任务（`/cron`） |
| `~/.lark-channel/profiles/<profile>/workspaces.json` | 当前和命名工作空间绑定 |
| `~/.lark-channel/profiles/<profile>/secrets.enc` | profile 本地加密 secret |
| `~/.lark-channel/profiles/<profile>/lark-cli/` | 当前 profile 的 lark-cli 目录 |
| `~/.lark-channel/profiles/<profile>/media/` | 附件缓存 |
| `~/.lark-channel/profiles/<profile>/logs/` | 结构化运行日志 |
| `~/.lark-channel/registry/processes.json` | 本机进程注册表 |
| `~/.lark-channel/registry/locks/` | profile lock 和 app lock |

设置 `LARK_CHANNEL_HOME=/path/to/state` 可以迁移整棵本地状态目录。`LARK_CHANNEL_LOG_DAYS` 可以调整日志保留天数。

## 访问控制

**聊天访问默认是私有的：开箱即用时，只有"你"能在私聊和群聊里用这个 bot。** 这里的"你" = 创建 / 拥有这个飞书应用的人（也就是扫码把 bot 建起来的那位）。bot 会自动从飞书查出谁是应用 owner，所以**一个人用聊天入口完全不用配置**——你私聊它、在任意群里 @它都正常工作，其他人的聊天消息会被静默忽略（bot 不会回"你没权限"，免得暴露自己的存在）。云文档评论按文档权限生效，见下文。

想让别的同事或某些群也能用，就把他们加进下面三类名单：

| 名单 | 控制谁 | 加入 | 移除 |
|------|--------|------|------|
| **允许私聊的用户** | 谁可以私聊 bot | `/invite user @某人` | `/remove user @某人` |
| **响应的群** | bot 在哪些群里响应（默认**群内所有人**，除非设了专属名单——见下文） | `/invite group`（当前群）/ `/invite all group`（bot 所在的全部群） | `/remove group`（当前群） |
| **管理员** | 谁能改设置、并能在任意群用 bot | `/invite admin @某人` | `/remove admin @某人` |

> `/invite`、`/remove` 这些命令只有**你（创建者）和管理员**能发。命令里 @ 的是**对方**（不是 @ bot），bot 会自动把 @ 解析成对应的人，你不用手动去找 ID。

### 只对群内部分人开放

`/invite group` 是把群开放给里面所有人。如果想开放这个群、但只对指定的几个人生效，用群专属名单：

```bash
/invite group restricted @Alice @Bob   # 一步完成：加群 + 设定专属名单
/invite member @Carol                  # 给已经是"仅名单"模式的群追加一个人
/remove member @Alice                  # 只移除这一个人
```

`/invite group restricted` 是原子操作——这个群只会处在"还没加"或"已加且已经限定到这些人"两种状态之一，中间不存在"先对所有人开放、名单还在加"这种过渡态；甚至可以不带任何 @ 直接执行，把群锁定成只有 admin/owner 能用，之后再用 `/invite member` 陆续加人。一个群只要有过专属名单（哪怕当前是空的），单独发 `/invite group` 不会让它重新对所有人开放——想恢复全员开放，得先 `/remove group` 再用普通的 `/invite group` 重新加。`/remove group` 也会顺带清掉这个群的专属名单。

### 两种"畅通无阻"的身份

- **你（创建者）**：不受任何名单限制——私聊、任意群、所有命令都能用，而且**永远锁不死自己**：哪怕名单配乱了，回到 bot 私聊发 `/config` 总能进来。在飞书后台把应用 owner 转给别人后，bot 也会自动跟着切换。
- **管理员**：能私聊、能用 `/config` 等管理命令，而且**不受"响应的群"名单限制**——无论群在不在名单里，bot 都会回他们。适合给一起维护 bot 的同事。

### 几种常见配置

- **只给自己用** → 什么都不用做，默认就是。
- **让某个同事能私聊 bot** → `/invite user @他`
- **让某个工作群里所有人都能用** → 在那个群里发 `/invite group`
- **让某个工作群开放、但只给里面几个人用** → 在那个群里发 `/invite group restricted @某人 @另一个人`
- **第一次配，想把 bot 已经在的群一次性全开放** → 发 `/invite all group` 一键拉取 bot 所在的全部群加入名单，之后再用 `/remove group` 删掉不想要的
- **再拉个人一起当管理员** → `/invite admin @他`

### 还需要知道的

- 改完**下一条消息**就生效，不用重启。
- **群里默认要先 @bot 才会回**（私聊不用 @）。这是另一个独立开关（`/config` →"群里需要 @ bot"），和上面的名单是两回事。
- 陌生人发消息一律静默丢弃，不会有任何回复。唯一的例外：有人在一个还没开放的群里 @bot，bot 会回一句友好提示，告诉他可以让管理员发 `/invite group` 开放这个群。
- 云文档评论按文档权限生效：能在支持的文档里评论并 @bot 的人可以触发回复。

### 高级：直接改配置文件

不想在飞书里点的话，`/invite`、`/config` 背后写的是 `~/.lark-channel/config.json` 中对应 profile 的 `access` 字段。空白名单表示这个名单没人，不表示所有人都能用。下面只是 profile 里的字段片段，不要整段覆盖 `config.json`：

```json
{
  "schemaVersion": 2,
  "profiles": {
    "claude": {
      "agentKind": "claude",
      "access": {
        "allowedUsers": ["ou_xxxxxxxxxxxxx"],
        "allowedChats": ["oc_xxxxxxxxxxxxx"],
        "admins": ["ou_xxxxxxxxxxxxx"],
        "requireMentionInGroup": true
      }
    }
  }
}
```

`allowedUsers` / `admins` 填用户 `open_id`，`allowedChats` 填群 `chat_id`。手动找 ID 最简单的办法：让对方给 bot 发条消息（群里就 @ 它一下），然后看当前 profile 的日志：

```bash
grep '"event":"enter"' ~/.lark-channel/profiles/<profile>/logs/bridge-$(date +%Y%m%d).jsonl | tail -5
```

每行都带 `chatId`（群 / 私聊 ID）和 `senderId`（用户 `open_id`）。手改完后**重启 bridge**，或在允许的 admin 上下文里发 `/reconnect` 让它生效。日常调整还是 `/invite` / `/config` 更省事，直接改文件主要用于部署脚本预填。

## 云文档评论

云文档评论不再需要单独绑定工作目录或维护文档白名单。支持的文档评论里 @bot 后，bridge 会在同一个评论线程里回复。评论运行复用文档级 session key；没有记录过文档 cwd 时回退到用户 home 目录。

## 常见问题

**bot 没反应 / agent 不回复**：通常是本机 `claude` 或 `codex` CLI 没登录，或者当前会话指向了不存在的工作目录。发 `/status` 看当前状态；`/new` 重开会话往往就好。

**agent 子进程假死（卡片停在最后一帧不动）**：支持 idle 探活。agent 一段时间没输出就会被 SIGTERM kill，卡片末尾会标出自动终止原因。默认关闭。开启方式：`/config` 设全局值（分钟），或 `/timeout 10` 只对当前会话生效；`/timeout off` 关掉当前会话的探活；`/timeout default` 清掉会话覆盖，回退到全局设置。

**图片发过去 agent 说看不到**：升级到最新版，0.1.0 之前的版本有文件名去重 bug。

## 测试与 CI

本地检查：

```bash
pnpm test
pnpm typecheck
pnpm build
```

`pnpm test` 包含 unit、integration 和 process-level adapter 测试。CI 在 macOS、Ubuntu、Windows 上执行 `pnpm install --frozen-lockfile`、`pnpm test`、`pnpm typecheck` 和 `pnpm build`。

## 可选：遥测（Telemetry）

默认情况下 bridge **不上报任何数据**：没有指标、没有日志离开你的机器，也不引入任何遥测依赖。下面这个钩子在你主动开启前完全是空操作。

想接自己的监控时，用环境变量指向一个 default export（或导出 `createAdapter`）`AdapterFactory` 的模块：

```bash
LARK_CHANNEL_TELEMETRY_MODULE=your-telemetry-package lark-channel-bridge start
```

该模块会收到每一条 `log.*` 事件，以及错误 / 指标钩子，转发到任何你想要的地方。接口从包根导出：

```ts
import type { AdapterFactory, TelemetryAdapter, TelemetryEvent } from 'lark-channel-bridge';

const createAdapter: AdapterFactory = (meta) => ({
  emit(event) {/* 上报事件 */},
  recordError(err, ctx) {/* 上报异常 */},
  recordMetric(name, value, tags) {/* 上报指标 */},
  flush(timeoutMs) {/* 冲刷缓冲事件 */},
});
export default createAdapter;
```

模块不存在、工厂函数不合法、或者 adapter 抛错，都会降级为空操作——遥测永远不会阻止 bridge 启动，也不会打断日志。

## 许可

[MIT](./LICENSE)

<img src="./assets/feedback-group-qr.png" alt="飞书反馈群二维码" width="360">
