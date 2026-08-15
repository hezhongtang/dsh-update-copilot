# dsh-update-copilot

DSH 更新助手 —— 一个 DeepSeek Harness 插件：实时跟进 **DSH 本体、官方 bundle、每个 profile 已装插件**的版本状态，汇总变更信息辅助决策，确认后才执行更新。

English summary: an update copilot plugin for DeepSeek Harness — tracks the dsh core, shipped bundles, and every profile plugin (npm version + git upstream dual channel), builds per-item decision briefs (semver distance, risk, changelog material), and executes plugin updates only after an explicit confirmation.

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-update-copilot
# 或发布后
dsh plugin --profile web add dsh-update-copilot
```

重启 `dsh web`，打开 **Settings → 更新助手（Update Copilot）**。

## 它做什么

### 1. 扫描（只读）

- **DSH 本体 + 官方 bundle**（`@deepseek-ai/dsh`、`dsh-base`、`dsh-web-app`）：对比 npm registry 全量版本表（不信任 `latest` dist-tag——monorepo 子包的 tag 常年滞后，会误报）。
- **每个 profile 的插件依赖**，按通道分类：
  - `npm` — registry 版本对比（完整 semver 优先级比较，含 prerelease）；
  - `github:` / `owner/repo#commit` — lockfile 中的 pinned commit vs 上游 HEAD；
  - `link:` — 本地 checkout 的 `HEAD` vs `origin HEAD`（只读 `ls-remote`，绝不 pull）。

### 2. 决策简报（Agent 辅助决策的核心）

对每个落后项生成 brief：**semver 跨度**（major/minor/patch）、**风险分级**（major→高、minor→中、patch→低、commit 通道→未知）、**变更材料**（npm 版本列表 / GitHub compare 提交列表 / Releases 正文 / 本地 git log）、以及一条明文建议。

### 3. 更新（确认后执行）

- 只走官方 `dsh plugin --profile <p> add <target>` CLI（内部转 pnpm），目标字符串走严格 allowlist，绝不拼接 shell；
- 同源 POST + `confirm: true` 双保险；
- `link:`/`file:` 本地安装拒绝执行（请在其 checkout 内自行 `git pull`）；
- `@deepseek-ai/*` 官方包拒绝执行（跟随 dsh 本体升级，GUI 只展示可复制的升级命令）；
- 单并发锁 + 5 分钟超时；完成后提示重启生效。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `update_copilot_scan` | 全量扫描（10 分钟缓存，`force` 强制刷新） |
| `update_copilot_brief` | 单项决策简报 |
| `update_copilot_update` | 执行一次已获用户确认的更新（`confirm` 必须显式为 true） |

典型对话：「帮我看看插件有没有更新」→ scan → 对每个落后项 brief → 汇报风险 → 你确认后 update。

## 设计说明

- **零构建**：host 为纯 ESM（Node 内置模块 + fetch），client 为手写 CJS bundle（仅外部依赖 `react`）。
- **不发布任何 Cordis 服务**：只消费可选的 `tools` / `webServer`，装进任何 profile 都不会阻塞启动。
- 所有网络查询带超时，单项失败只降级该项（GitHub API 限流时 brief 退化为基础信息）。

## 限制

- 更新插件后需重启 `dsh` 生效（不做热挂载）。
- GitHub API 未认证限流 60 次/小时，密集扫描时 brief 的 commits 部分会降级。
- DSH 本体升级命令只展示不执行 —— 升级 harness 会重启所有会话，这个决定留给人。
