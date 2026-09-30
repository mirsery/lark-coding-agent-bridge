# lark-channel-bridge agent routing

Codex 等非 Claude agent 的入口。权威约定在 [CLAUDE.md](CLAUDE.md)，改代码前完整读一遍，按其中的「迭代流程」「质量门禁」「不变量与踩过的坑」执行。

要点速记（以 CLAUDE.md 为准）：

- 只推 `origin`（boss 的 fork），不碰上游；提交与 PR 不带 AI 署名。
- 每个改动用独立 worktree；门禁是 `pnpm ci:local` 全绿。
- 主 checkout 的 `dist/` 是线上代码：只在交付时构建；重启由 boss 决定。
- agent 相关分支只走 `src/agent/registry.ts`，不写 `agentKind === '…'` 字面判断。
