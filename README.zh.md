# dsh-update-copilot

[![License: MIT](https://img.shields.io/badge/license-MIT-0B7285?style=flat-square)](LICENSE)
[![DSH core](https://img.shields.io/badge/DSH-%3E%3D%200.1.0--rc.6-5B4CF0?style=flat-square)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![Zero build](https://img.shields.io/badge/zero--build-no%20bundler-2EA44F?style=flat-square)](lib)
[![GitHub stars](https://img.shields.io/github/stars/hezhongtang/dsh-update-copilot?style=flat-square&logo=github)](https://github.com/hezhongtang/dsh-update-copilot/stargazers)

**[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 的更新助手：追踪 dsh 本体、官方 bundle 和每个 profile 已装插件的版本状态 —— 先帮你决策，确认后才更新。**

<p align="center">
  <img src="assets/popup.png" width="480" alt="更新助手弹窗：核心包列表、落后项优先的插件行、已最新项折叠。" />
</p>

[English](README.md) | 中文

## 为什么做这个

DSH 迭代很快，插件生态同样如此。每个 profile 通过 pnpm spec 安装插件——npm 版本号、GitHub commit 锁定、本地 `link:` 目录——每种通道各有各的过期方式。手动检查意味着挨个仓库跑一遍；无脑全自动升级则等于把环境交给第三方代码。

这个插件走中间路线：**全部检测、汇总变更、只更新你确认过的。** DSH 本体刻意设计为*只报告不执行*——升级 harness 会重启所有会话，这个决定必须留给人。

## 功能

| | |
|---|---|
| 🔭 **全量雷达** | 一次扫描覆盖 dsh 本体 + 官方 bundle（`dsh-base`、`dsh-web-app`）+ 所有 profile 的插件依赖 |
| 🔄 **双通道** | npm registry 版本（完整 semver 比较，含 prerelease）+ git 上游（pinned commit vs HEAD，`link:` 目录走只读 `ls-remote`） |
| 🧭 **决策简报** | 逐项给出：semver 跨度、风险分级（major → 高、minor → 中、patch → 低）、变更材料——npm 版本列表 / GitHub compare 提交 / Release 说明 / 本地 `git log` |
| 🤖 **Agent 工具** | `update_copilot_scan` / `update_copilot_brief` / `update_copilot_update`——对 Agent 说一句「有没有更新」，得到有数据支撑的回答 |
| 🖥 **Web 界面** | 设置按钮旁的侧栏入口（带懒加载徽章：首次打开弹窗后才显示落后插件数——不做后台轮询）打开紧凑雷达弹窗——落后项优先、已最新折叠；完整页面仍在 设置 → 更新助手，含内联简报与两步确认更新 |
| 🛡 **更新护栏** | 同源 POST + 显式 `confirm`、严格目标 allowlist、单并发锁、5 分钟超时；拒绝 `link:`/`file:` 与官方 `@deepseek-ai/*` 包 |

## 安装

```sh
dsh plugin --profile web add github:hezhongtang/dsh-update-copilot
```

重启 `dsh web`，打开 **Settings → 更新助手**。其他 profile 用法相同（`--profile <name>`）。

## 使用

### 问你的 Agent

> 「帮我看看插件有没有更新」

Agent 会调用 `update_copilot_scan`，对每个落后项生成决策简报、先呈现风险，然后等你拍板。更新工具在没有 `confirm: true` 时直接拒绝执行。

### 或者用弹窗 / 面板

**设置旁的侧栏按钮**打开紧凑雷达弹窗（ESC 或点击遮罩关闭；URL 带 `?duc=1` 会自动打开一次——截图和测试很好用）。**设置 → 更新助手** 是完整页面：核心状态（附可复制的升级命令——只展示、绝不执行）、每个 profile 的插件当前 → 最新版本、内联决策简报、两步确认更新按钮。更新完成后的重启横幅会提醒你：插件更新需重启 `dsh` 生效。

### Agent 工具一览

| 工具 | 读/写 | 用途 |
|---|---|---|
| `update_copilot_scan` | 读 | 全量扫描：核心 + 所有 profile（10 分钟缓存，`force` 强制刷新） |
| `update_copilot_brief` | 读 | 单项的 semver 跨度、风险、变更材料与建议 |
| `update_copilot_update` | 写 | 通过官方 `dsh plugin` CLI 执行一次**已确认**的更新 |

## 工作原理

每个依赖 spec 先分类到通道，每个通道有自己的比较方式：

| 通道 | spec 示例 | 当前版本 | 最新版本 |
|---|---|---|---|
| npm | `^0.1.4` | 已装 `package.json` 的版本 | registry 全量文档中的最新版 |
| github | `github:owner/repo#sha` | `pnpm-lock.yaml` 锁定的 commit | GitHub API 查询的上游 HEAD |
| linked | `link:../my-plugin` | 本地 `git rev-parse HEAD` | `git ls-remote origin HEAD`（只读） |

npm 通道刻意不信任 `latest` dist-tag：monorepo 子包的这个 tag 常年滞后，会把实际比 tag 更新的安装误报为落后。版本比较采用完整 semver 优先级（含 prerelease），因此 `0.1.0-rc.6 > 0.1.0-rc.5`、`1.0.0 > 1.0.0-rc.1` 都成立。

更新只通过 `dsh plugin --profile <p> add <target>` 执行——和人手动输入的是同一条路径——目标字符串经过 allowlist 校验，任何情况下都不拼接 shell。

## 安全性

- 唯一的变更路由是 `POST /dsh-update-copilot/update`：强制同源 + 必须显式 `confirm: true`。
- 官方 `@deepseek-ai/*` 包和 dsh 本体绝不自动更新；本体的升级命令只展示、不执行。
- 所有上游查询均为只读（`registry.npmjs.org`、`api.github.com`、`git ls-remote`）且带硬超时；单项查询失败只降级该项，不影响整体扫描。

## 限制

- 插件更新需重启 `dsh` 生效（不做热挂载）。
- GitHub API 未认证时限流 60 次/小时——简报会优雅降级为基础版本列表。
- 裸 `git+https://` spec 只报告、不提供比较通道。

## 参与贡献

欢迎提 Issue 和 PR：[hezhongtang/dsh-update-copilot](https://github.com/hezhongtang/dsh-update-copilot)。代码库刻意保持小巧、零依赖——host 是纯 ESM，浏览器端是手写 CJS bundle，无需搭建任何构建环境。

## 许可

[MIT](LICENSE) © 2026 hezhongtang
