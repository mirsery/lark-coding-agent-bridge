# guest guard 改动前回放（guard replay）

Claude Code 与 Codex 共用。改了 `bin/bridge-guard.mjs`（或 `src/policy/owner-guard.ts` 里给它的配置）就要跑，合入前做完。hook 每次工具调用都从主 checkout 现读这个文件，**合入 main 即对所有访客任务生效，不等重启**，所以误拦和漏拦都要在合入前看清楚。

## 做什么

`tests/replay/guard-replay.test.ts` 读本机 `~/.claude/projects/**/*.jsonl` 里所有会被 hook 检查的工具调用（Bash、Read、Edit、Write、Glob、Grep…，去重后约三万条），按本机真实 profile 的访客配置（`config.json` 的 `access` 段，只读这一段）分别交给 base 版本和当前 worktree 的 `decide()` 判一遍，报告：

- **newly refused**：当前版本新拦下的调用。每一条都要确认是本来就该拦的写入；有一条不该拦就是误判，先修。
- **newly allowed**：当前版本新放行的调用。`refusedInGuestRuns` 是真实访客任务里被拦过的（修掉的误判），`others` 要抽查有没有真正的写入被放过（漏拦）。
- **stillRefusedInGuestRuns**：真实访客任务里被拦、现在仍拦的调用——剩余误判藏在这里。
- `throws`（必须为空）和最慢一次判断的耗时（hook 每次工具调用都跑，应在几毫秒内）。

完整报告写到 `$TMPDIR/guard-replay.json`（或 `GUARD_REPLAY_OUT`），终端只打摘要和前 30 条。

## 步骤

1. 在 worktree 里改完、单测通过后：
   ```bash
   GUARD_REPLAY=1 npx vitest run tests/replay
   ```
   默认和本地 `main` 比；比别的版本用 `GUARD_REPLAY_BASE=<ref>`。
2. 有 newly refused 时测试失败。逐条看：该拦的，确认后加 `GUARD_REPLAY_ACCEPT=1` 重跑通过；不该拦的，回去修 guard 并补单测（`tests/unit/policy/owner-guard.test.ts`）。
3. 抽查 newly allowed 的 `others`：新放行的写入（重定向、`git` 写操作、解释器内联代码写文件等）就是漏拦，同样修掉再跑。
4. 提交信息里写回放结果：比对的 base、新拦 / 新放行条数，以及新拦的都是哪类写入。

## 其他参数

- `GUARD_REPLAY_PROFILE`：按哪个 profile 的访客配置（默认 `activeProfile`）。
- `GUARD_REPLAY_HOME`：bridge 配置根目录（默认 `~/.lark-channel`）。
- `GUARD_REPLAY_TRANSCRIPTS`：转录目录（默认 `~/.claude/projects`）。

回放用的是 base 和当前两个版本的 hook、同一份**当前**配置；改的是 `ownerOnlyGuard` 生成配置的逻辑时，回放只反映 hook 这一侧，配置侧的变化靠单测覆盖。每条调用按转录里记录的 cwd 判断；访客任务的 Bash 每次都回到会话工作目录，主人会话里在仓库目录下直接跑的命令在回放里会比真实访客场景宽松。
