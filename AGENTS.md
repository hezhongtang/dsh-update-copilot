# AGENTS.md

dsh-update-copilot — DeepSeek Harness 的更新插件（零依赖，host 纯 ESM，client 为手写 CJS bundle，无构建步骤）。

## 收尾（普通变更）

每次代码或文档修改完成后，按顺序收尾，完成标志：`git status` 干净，且 GitHub 仓库（hezhongtang/dsh-update-copilot）的 main 分支包含本次提交。处于共享的活动合并工作树时，以任务指令为准：解决冲突、运行验证并暂存合并结果，不自行创建 merge commit、push 或修改任何 DSH profile。

1. **commit** — 一处改动一个提交，提交信息写清改了什么。
2. **push** — 推送到 GitHub 仓库的 main 分支。
3. **npm 发布按版本计数** — 自上次 `npm publish` 起累计递增 3 个小版本时，发布一次 npm。

## 提问（需要用户输入时）

凡需要用户确认、选择或补充信息，统一使用问答交互工具（`ask_user_question`）发起结构化提问，并给出可选项；等待用户作答后再继续。
