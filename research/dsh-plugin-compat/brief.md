# Research brief: DeepSeek Harness 升级后新旧插件兼容问题与解决办法

## Refined question

DeepSeek Harness（`@deepseek-ai/dsh`，下称 DSH）已连续升级多版，本地插件 `dsh-update-copilot`（v0.7.0，面向 DSH `>= 0.1.0-rc.7`）可能落后。需要系统性回答：

1. **最新 DSH 代码/版本现状**：当前主线版本、发布节奏、插件相关模块（loader、host 包、client runtime、bundle/patch、`dsh plugin` CLI）近期改了什么。
2. **升级时旧插件 → 新插件的兼容问题**：哪些变更会弄坏已装插件（named export 删除/改名、peer 范围、client inject 面、bundle patch 契约、profile/manifest 形状、CLI 行为），典型故障形态是什么。
3. **解决办法**：兼容层、版本门禁、预检/回滚、迁移策略、生态惯例；对 `dsh-update-copilot` 自身应做哪些改造。

## Audience & decision at stake

- 受众：本插件维护者（hezhongtang）+ 需要评估「现在能不能升 DSH / 插件要不要改」的用户。
- 决策：是否/如何升级 `dsh-update-copilot` 的兼容模型与预检能力；给出可执行的改造优先级。

## Scope

**In**
- DSH 本体与官方周边包（`@deepseek-ai/dsh*`、`@deepseek-ai/cordis`、`dsh-base`、`dsh-web-app`、`dsh-tools`、client-*）的公开版本与变更。
- 插件安装/加载/更新路径（pnpm spec：npm / github: / link: / file:）。
- Host 导出兼容、peerDependencies 范围、bundle patch、client inject、profile manifest。
- GitHub Issues/PR/Releases（DSH 相关仓库 + `hezhongtang/dsh-update-copilot`）。
- 同类「宿主 + 插件」生态中的升级/兼容工具与惯例（Renovate、npm-check-updates、VS Code 扩展更新、Koishi/Cordis、Claude Code/agent 插件更新、Homebrew/包管理器 upgrade 安全护栏等）。

**Out**
- DSH 未公开的内部路线图（若无证据则标为 open question）。
- 与更新无关的 DSH 功能评测（模型能力、对话质量）。
- 本仓库业务功能扩展（除兼容/升级相关）。

## Assumptions（若证据推翻则在报告中更正）

1. DSH 公开发布渠道以 npm `@deepseek-ai/*` 为主，GitHub 可能存在源码/镜像/官方 org。
2. `dsh-update-copilot` 当前契约见 README：peer `@deepseek-ai/cordis >=4.0.0-rc.7 <5.0.0`，`dsh.bundle.patch` + `dsh.client.inject`，官方包只报告不自动更新，预检看 named export / peer range。
3. 「旧插件 vs 新插件」指：在**新 DSH host** 上跑**旧版第三方插件**，以及**新插件**回落到**旧 host** 的双向兼容。
4. 时间窗：重点关注约 2025-09 至 2026-09 的变更；更早仅作背景。

## Depth mode

**deep**（5–8 并行角度，最多 2 轮跟进；sources target 25+）

## Angles

1. **F1 DSH 本体版本与发布轨迹**：`@deepseek-ai/dsh` / dsh-base / dsh-web-app 的 npm 版本列表、dist-tags、changelog/release notes、版本线（rc → stable？）。
2. **F2 插件加载与 Host API 面**：loader、named exports、`@deepseek-ai/cordis`、`dsh-tools`、client inject runtime/locale/ui-settings 的契约变化；什么会导致整棵 plugin tree 挂掉。
3. **F3 GitHub Issues / PRs / Discussions**：`hezhongtang/dsh-update-copilot` 与任何 DSH/插件生态仓库中关于升级、兼容、破坏性变更、热重载、bundle patch 的 issue/PR 讨论。
4. **F4 版本/peer/semver 兼容坑**：prerelease 范围、`^0.x` 语义、peer 冲突、monorepo 子包 dist-tag 滞后、lockfile commit pin vs registry——升级时的典型误判与解法。
5. **F5 同类升级插件/工具的兼容改进**：Renovate、npm-check-updates、update-notifier、pnpm update、VS Code 扩展更新、Koishi/插件市场、agent-skill/plugin updater、Homebrew upgrade 护栏——它们如何做 preflight、canary、rollback、breaking-change 检测、migrate。
6. **F6 社区真实故障与经验**：论坛/博客/issue 中「升级 host 后插件挂了」「export not found」「peer invalid」类案例与修复手法。
7. **F7 官方插件作者文档与迁移指引**：DSH/相关官方文档对 plugin manifest、exports、compat range、breaking change policy 的表述；若有 migration guide 则提取步骤。

## Workspace

`research/dsh-plugin-compat/`（本仓库内）
- `brief.md`（本文件）
- `findings/F1.md` … `F7.md`
- `REPORT.md`

## Date

- Today: **2026-09-22**
- Evidence priority: newer + primary (npm, official docs, GitHub releases) over secondary/community.
