# dsh-update-copilot

[![License: MIT](https://img.shields.io/badge/license-MIT-0B7285?style=flat-square)](LICENSE)
[![DSH core](https://img.shields.io/badge/DSH-%3E%3D%200.1.0--rc.7-5B4CF0?style=flat-square)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![Zero build](https://img.shields.io/badge/zero--build-no%20bundler-2EA44F?style=flat-square)](lib)
[![GitHub stars](https://img.shields.io/github/stars/hezhongtang/dsh-update-copilot?style=flat-square&logo=github)](https://github.com/hezhongtang/dsh-update-copilot/stargazers)

**[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 的更新助手：追踪 dsh 本体、官方 bundle 和所有已装插件——跨全部 profile 按包合并展示，对符合独立更新条件的安装一键更新。**

<p align="center">
  <img src="assets/popup.png" width="480" alt="更新助手弹窗：核心包列表、落后项优先的插件行、已最新项折叠。" />
</p>

[English](README.md) | 中文

## 为什么做这个

DSH 迭代很快，插件生态同样如此。每个 profile 通过 pnpm spec 安装插件——npm 版本号、GitHub commit 锁定、本地 `link:` 目录——每种通道各有各的过期方式。手动检查意味着挨个仓库跑一遍；无脑全自动升级则等于把环境交给第三方代码。

这个插件走中间路线：**全部检测、汇总变更、只更新你点过的东西。** 更新就是一键——按钮和动作之间没有确认仪式，且只会作用于该包显示出的合格 profile。DSH 本体刻意设计为*只报告不执行*——升级 harness 会重启所有会话，这个决定必须留给人。

## 功能

| | |
|---|---|
| 🔭 **全量雷达** | 一次扫描覆盖 dsh 本体 + 官方 bundle（`dsh-base`、`dsh-web-app`）+ 所有 profile 的插件依赖 |
| 🔄 **双通道** | npm registry 版本（完整 semver 比较，含 prerelease）+ git 上游（pinned commit vs HEAD，`link:` 目录走只读 `ls-remote`） |
| 🧭 **更新要点** | 逐项给出：semver 跨度、风险分级（major → 高、minor → 中、patch → 低）、变更材料——npm 版本列表 / GitHub compare 提交 / Release 说明（正文内联渲染）/ 本地 `git log`；每条材料都可点击跳转（npm 版本页、提交、Release、compare 对比页），每个插件行带 ↗ 直达其仓库——monorepo 子包定位到子目录，解析不出 GitHub 仓库的 npm 插件兜底到其 npm 包页面 |
| 🤖 **Agent 工具** | `update_copilot_scan` / `update_copilot_brief` / `update_copilot_update`——对 Agent 说一句「有没有更新」，得到有数据支撑的回答；扫描按包合并（一个包一行），自动推断的挂载关系只用于展示；官方包只报告，每个直接依赖仍按自身更新策略处理 |
| 🖥 **Web 界面** | 仅 Web host 的设置旁侧栏入口会在挂载时补齐徽章，并在启动扫描后重试；后台扫描在启动时执行一次，之后每 30 分钟执行一次。紧凑雷达弹窗落后项优先、已最新折叠；自动推断的挂载关系始终跟随父行，父行已最新时仍在已最新分组。完整页面仍在 设置 → 更新助手。插件跨 profile 合并成一行，带每个 profile 的当前 → 最新版本；挂载的包可在父行下展开披露，同时保留独立归属和更新操作。子项「更新」只更新子项，父项普通「更新」只更新父项；「更新 bundle」先更新父项，再按序更新当前展示且可独立更新的挂载子项，并报告进度与结果。「一键更新全部」仍是独立的全局操作。更新过程通过 SSE 实时推送进度（解析依赖 / 下载中 / 重试中 / 暂存 / 拉取 / 恢复阶段），直接渲染成每行进度条 |
| 🛡 **更新护栏** | 同源 POST + 显式 `confirm`、严格目标 allowlist、单并发锁、5 分钟超时；npm/github 通道只走官方 `dsh plugin` CLI，`link:` 本地目录走 git pull（自动暂存 → 拉取 → 恢复），冲突一律交还手动处理；`file:` 与官方 `@deepseek-ai/*` 包仍拒绝 |
| 🌐 **完整双语** | 所有面向用户的文案——面板、弹窗、徽章、更新要点、建议、更新错误——跟随界面语言（中/英）；Agent 工具路径保留稳定英文标识 |

## 安装

```sh
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-update-copilot

# 或者直接从 GitHub 仓库安装
dsh plugin --profile web add github:hezhongtang/dsh-update-copilot
```

重启 `dsh web`，打开 **Settings → 更新助手**。其他 profile 用法相同（`--profile <name>`）。

## 使用

### 问你的 Agent

> 「帮我看看插件有没有更新」

Agent 会调用 `update_copilot_scan`，对每个落后项生成更新要点、先呈现风险，然后等你拍板。更新工具在没有 `confirm: true` 时直接拒绝执行。

### 或者用弹窗 / 面板

**设置旁的侧栏按钮**打开紧凑雷达弹窗（ESC 或点击遮罩关闭；URL 带 `?duc=1` 会自动打开一次——截图和测试很好用）。**设置 → 更新助手** 是完整页面：核心状态（附可复制的升级命令——只展示、绝不执行）、全部已装插件跨 profile 合并成一行（每个 profile 的当前 → 最新版本内联展示）、可展开的挂载关系、内联更新要点，以及每行一个**一键「更新」**按钮。子项行的「更新」只作用于子项，父项普通「更新」只作用于父项；「更新 bundle」先运行父项，再按序更新当前展示且可独立更新的挂载子项，并报告进度与结果。每个包都带明确的合格 profile，不会按同名依赖盲目更新全部 profile。工具栏的**「一键更新全部」**仍是独立的全局操作，按序跑合格的落后包。更新过程由 SSE 实时推送到每行进度条。更新完成后，当前 profile 里 entry 与 bundle patch 未变的插件会**就地热重载**；只有热重载不适用的更新（bundle patch 变化、非当前 profile、自更新等）才显示重启横幅。

### Agent 工具一览

| 工具 | 读/写 | 用途 |
|---|---|---|
| `update_copilot_scan` | 读 | 全量扫描：核心 + 所有 profile，按包合并（10 分钟缓存，`force` 强制刷新） |
| `update_copilot_brief` | 读 | 单个包的 semver 跨度、风险、变更材料与建议；可传 `profile` 限定只看一个 profile，不传则每个装有该包的 profile 都出一份 |
| `update_copilot_update` | 写 | 执行一次**已确认**的更新——不传 `profile` 时也只在符合独立更新条件的安装中执行；npm/github 通道走官方 `dsh plugin` CLI（失败/超时自动重试，默认共 3 次，1s/3s 退避）；`link:` 本地目录保持本地，在 checkout 内执行 git pull（自动暂存 → 拉取 → 恢复，冲突交还手动处理），或传 `source: "remote"` 把依赖切换到 npm 已发布版本（包未发布到 npm 时用 `github:` spec）——会断开本地链接 |

## 工作原理

每个依赖 spec 先分类到通道，每个通道有自己的比较方式。扫描结果按包跨 profile 合并：同一个包装在 web / headless / desktop，就只出现一行，携带每个 profile 的通道与版本，以及明确的合格更新 profile。活动 profile bundle 的包内 patch 若挂载至少两个生产依赖，会展示仅用于呈现的挂载关系；多个父包声明同一子项时，先选已验证子项更多的父包，再按包名确定归属。挂载关系不转移更新归属，每个直接依赖仍按自身策略更新。`link:` 与 `file:` 本地依赖保持本地；官方 `@deepseek-ai/*` 包只报告，不能独立更新。

| 通道 | spec 示例 | 当前版本 | 最新版本 |
|---|---|---|---|
| npm | `^0.1.4` | 已装 `package.json` 的版本 | registry 全量文档中的最新版 |
| github | `github:owner/repo#sha` | `pnpm-lock.yaml` 锁定的 commit | GitHub API 查询的上游 HEAD |
| linked | `link:../my-plugin` | 本地 `git rev-parse HEAD` | `git ls-remote origin HEAD`（只读） |

npm 通道刻意不信任 `latest` dist-tag：monorepo 子包的这个 tag 常年滞后，会把实际比 tag 更新的安装误报为落后。版本比较采用完整 semver 优先级（含 prerelease），因此 `0.1.0-rc.6 > 0.1.0-rc.5`、`1.0.0 > 1.0.0-rc.1` 都成立。

更新通过两条路径执行，都经过严格校验、不拼接 shell：npm/github 通道走 `dsh plugin --profile <p> add <target>`——和人手动输入的是同一条路径——目标字符串经过 allowlist 校验；`link:` 本地目录保持本地，在 checkout 内直接跑 git（`git stash push` 暂存本地改动 → `git pull` → `git stash pop` 恢复），pull 失败/超时自动重试（默认共 3 次，1s/3s 退避），合并冲突或恢复冲突绝不自动解决——结果里返回 `attempts`、`stash` 状态与最后一次输出。子项、父项和 bundle 操作都只按包行里明确列出的合格 profile 执行；「一键更新全部」仍是独立的全局操作，绝不因同名依赖而更新全部 profile。

`link:` 目录还可以**切换到远端源**：copilot 把依赖 spec 改写为 npm 上最新发布的版本（优先查 registry），包未发布到 npm 时改写为 `github:owner/repo#<origin HEAD>`。本地链接断开，此后更新走常规 npm/github 通道。切换是破坏性操作，永远需要显式确认，绝不并入默认 pull 路径。

## 安全性

- 唯一的变更路由是 `POST /dsh-update-copilot/update`：强制同源且校验实际传输协议，必须显式 `confirm: true`，不信任转发协议请求头。TLS 终止代理可设置其公开 HTTP(S) origin 至 `DSH_UPDATE_COPILOT_PUBLIC_ORIGIN`；请求必须精确匹配，配置无效时拒绝所有请求。
- 官方 `@deepseek-ai/*` 包和 dsh 本体绝不自动更新；本体的升级命令只展示、不执行。
- 所有上游查询均为只读（`registry.npmjs.org`、`api.github.com`、`git ls-remote`）且带硬超时；单项查询失败只降级该项，不影响整体扫描。

## 限制

- 插件热重载为一期能力：仅覆盖“当前 profile 中仍在运行、且新版未改动 `dsh.bundle.patch` 与 `dsh.client` 声明”的更新（`link:` 目录更新同样适用——node_modules 里是指向 checkout 的符号链接）；bundle patch 变化、非当前 profile、copilot 自更新等仍会提示重启 `dsh`。
- `link:` 目录更新要求 checkout 配置了上游分支；本地未提交改动自动暂存并在拉取后恢复，恢复冲突时需手动 `git stash list` / `git stash pop` 处理。
- `link:` 切换到远端源会断开本地链接，且不提供自动切回（需手改 spec）；npm 优先策略安装的是 registry 版本，可能与本地开发中的 checkout 不一致。
- GitHub API 未认证时限流 60 次/小时——更新要点会优雅降级为基础版本列表。
- 裸 `git+https://` spec 只报告、不提供比较通道。

## 参与贡献

欢迎提 Issue 和 PR：[hezhongtang/dsh-update-copilot](https://github.com/hezhongtang/dsh-update-copilot)。代码库刻意保持小巧、零依赖——host 是纯 ESM，浏览器端是手写 CJS bundle，无需搭建任何构建环境。

## 许可

[MIT](LICENSE) © 2026 hezhongtang
