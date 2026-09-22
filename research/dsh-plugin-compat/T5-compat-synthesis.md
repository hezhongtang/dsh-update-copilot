# T5: 新旧插件兼容问题与解决办法 · 综合报告

- 日期：2026-09-22
- 范围：`@deepseek-ai/dsh` 2026-08-10 首发 → 2026-09-22（24 个 prerelease）；重点窗口 2026-08 ~ 2026-09
- 输入：F1–F8 findings（本目录 `findings/`）+ 本仓 `lib/preflight.js` / `lib/compat.js` / README 现状
- 受众：dsh-update-copilot 维护者
- 决策：兼容模型与预检改造优先级

---

## 1. 结论摘要

DSH 处于 developer preview，官方 README 明示 **THERE WILL BE COMPATIBILITY-BREAKING CHANGES**。在 0.x prerelease 语义下，插件兼容不是「语义化版本能兜住」的问题，而是 **host 导出面 / loader 契约 / session 格式 / adapter 契约 / 安装解析** 五条面同时在动。当前 dsh-update-copilot v0.7.0 已覆盖其中两条（peer 范围警告、named-export 硬闸），但对 **session format、loader entry 契约、破坏性变更知识源（127 卡）** 尚未接入。建议按 P0→P2 三档改造预检，优先吸收 oh-my-dsh 升级卡 schema 与 grunmin 三层失败分类，而不是再发明一套自有格式。

---

## 2. 兼容问题分类（host ↔ plugin 破坏点）

按 F1/F2/F3/F6/F8 归并，五类破坏点均有真实事故与坐标：

| 类别 | 机检信号 | 典型事故 | 现状（v0.7.0） |
|---|---|---|---|
| **A. 导出删除 / 改名** | named import 在目标 host 的 exports 中不存在 | `settingsNamespace` / `installSettingsSection` 从 `@deepseek-ai/dsh-settings` 消失 → 整树 ESM 链接失败（discussions #5363/#5426）；`Session.events` 删除（A4-03）；`report`→`send_message`（A4-01） | ✅ `lib/compat.js` 静态比对 named imports vs host exports（硬闸） |
| **B. 包改名 / 依赖解析** | package name 变更、dist-tag 冻结、pnpm 真实路径覆盖 | `dsh-code-runtime-python`→`dsh-experimental-code-runtime-python`（A4-02）；`@deepseek-ai/dsh-*` 的 `latest` 冻在空包 `0.0.1-rc.1`（#5813，8 次独立上报）；官方升级脚本原位覆盖 `.pnpm` 导致混版本（#5564） | ⚠️ 扫描忽略 `latest` 用全量 semver；**未**检测空包 dist-tag / 包改名对照表 |
| **C. Session 格式** | `$DSH_HOME` 魔数 / `sessionFormat` / `projcacheVersion` | 0.1.5 线 Session log → V3（后 V4 @ 0.1.7-alpha.1），只向前迁移；旧 build `no Session format codec for v3`；rc.8 会话全丢事故 | ❌ 无存储指纹 |
| **D. Adapter / 工具契约** | 方法集探测（`typeof LlmAdapter.prototype.prepareCall`） | `registration.adapter.prepareCall is not a function`（0.1.1-rc.2）；PTC 停发 `workflow`；base 默认开 `web_fetch`；`modelSelectionSettings requires … in the Host scope` | ❌ 无 capability probe |
| **E. Loader entry / 组合契约** | `duplicate loader entry id` / `failed to apply loader entry` / peer range 失效 | `^0.1.0-rc.8` 永不匹配 `0.1.2-rc.1`（#5450）；`dsh.plugin remove` 留 stale bundles 条目拒 boot；一个坏 tool schema 毒化整个 session | ⚠️ `lib/preflight.js` 已做 prerelease-correct peer 警告；**未**检 loader entry 冲突 / stale bundles |

**共性根因（F3/F7）**：不是某个插件不兼容，而是 **框架契约在变且 changelog 未标注破坏性变更**；官方无 plugin migration guide、无 `ctx.host.apiVersion`、无 throwing stub、无 boot 期 mismatch warning（F6 社区诉求六条全部未落地）。

---

## 3. 版本/解析层为何「看起来兼容、实际已坏」

F4 + F1 的硬事实：

1. **0.x prerelease 语义**：`satisfies('0.1.2-rc.1','^0.1.0-rc.8') === false`（node-semver 实测）；`^0.1.0` 只放行 patch。插件 peer 写得越「合理」越容易在 alpha 跳变时失效。
2. **dist-tag 漏洞**：官方 release 脚本对任何含 `-` 的版本只打 `next`，`latest` 永不推进（`families.ts:293-295`）；`@deepseek-ai/dsh-*` 的 `latest` 冻在空包 `0.0.1-rc.1`，`dsh plugin add` 无版本即装坏构建。
3. **同仓包 dist-tag 滞后**：`dsh-base` / `dsh-web-app` 的 `latest=0.0.1-rc.1` 而 `next/alpha` 已到 0.1.5-rc.3 / 0.1.7-alpha.1。
4. **安装通道不一致**：pnpm 装 host 会 `ERR_MODULE_NOT_FOUND` 拖垮 4–200 条 loader entry；npm/npx 正常。link: 联调通过 ≠ registry 解析正确（F4 #17/#18）。
5. **半升级对**：host 与 plugin 必须同代移动；单侧升级分别死在 mount-time（exports subpath）或 run-time（Host scope / `is not a function`）（F6 #7/#8）。

**含义**：预检不能只看 peer range 字符串，必须做「目标 host 实装面」核验（exports、loader entry、格式指纹），且安装解析要显式钉版本/钉 commit，禁止裸 `latest`。

---

## 4. 可吸收的结构化知识源（预检改造原料）

F8 盘点结论——**不要自造 schema，直接对齐已有契约**：

| 知识源 | 可吸收字段 / 机检项 | 对应破坏点 |
|---|---|---|
| **oh-my-dsh 127 卡**（`dsh-plugin-upgrade-skill`） | frontmatter：`from/to/status/coverage/cardCount/idPrefix/verifiedAt`；单卡：`Type/Touchpoints(#1–#7)/Action level/Migration recipe(old→new ledger)/Verification/Source`；corridor 缺边必须 stop | A/B/C/D/E 全覆盖 |
| **pre-flight-patterns.json** | 7 类 regex（source-patch / internal-events / internal-services / host-filesystem / internal-ui-commands / custom-channel / subprocess-output） | 静态触点扫描 |
| **dsh-compat-guard** | 三闸门 exit 1/2；`dsh.compat.{requires,tested,storageFormats,kind}`；`compat/schema.json` 的 `status∈{pass,fail,unknown}+evidence`；存储魔数（zstd `28 B5 2F FD` / sqlite）；`dsh.guard.lock.json`（integrity/configHash） | C + 兼容矩阵 + 回滚 |
| **grunmin acp-doctor** | 三层分类：link-time / mount-time / run-time + stderr 签名→修复映射；peer range 预拦截「CLI too old」 | B/E/D |
| **grunmin api-surface-check** | 声明面白名单：`capability-seams.md` + `event-producer-consumer.md` + package exports | A/D |
| **pax-beehive hub schemas** | `compatibilitySchema{dsh,node,platforms,surfaces,hmr}`；`entryIds/before/after`；`source.integrity` | E + 发布元数据 |
| **verify-runtime.mjs** | verdict∈{activation-failed, service-wait-unresolved, env-needs-service-host, load-crash-module-resolve, pass-boot-probe, ambiguous-error-signature} + attribution | 装后归因 |

---

## 5. 同类工具可迁移的门禁模式（F5）

按「升级前 → 升级中 → 升级后」抽取可移植原语：

- **升级前**：ncu `--peer`（peer-graph 过滤候选）、`--cooldown/min-release-age`（发布冷却）；Renovate `constraintsFiltering:strict`（engines 子集）、`minimumReleaseAge*` 三层；VS Code `engines.vscode`（host 兼容 gate + Marketplace 分发）。
- **升级中**：ncu `--doctor`（乐观全升 → 失败二分回退）；pnpm `up --changeset`（peer 破坏记 major）、`outdated --compatible`、`--no-save` dry-run；Homebrew `pin/migrate --dry-run`/多 keg。
- **升级后**：Renovate `postUpgradeTasks`（codemod 钩子）、`rollbackPrs`（yank 降级）；update-notifier 只通知不自动更 + 破坏级别标注（`type: major|prerelease`）。

dsh-update-copilot 已有对应物：preflight 硬闸/软警、history+rollback、collateral check、force 覆盖。缺口在 **冷却期 gate、engines/constraints 子集过滤、post-upgrade codemod（迁移卡 recipe 自动应用）**。

---

## 6. 对 dsh-update-copilot 的改造优先级

### P0 — 立刻做（直接消掉已证实的整树炸毁类）

1. **接入破坏性变更卡索引**  
   消费 oh-my-dsh `references/vX.Y.Z-*.md` frontmatter（`from→to, cardCount, idPrefix`）+ 单卡字段。`update_copilot_preflight` 按「当前 host → 目标 host」折叠 corridor 净变更，输出：  
   `hit touchpoints × applicable cards × action level`。缺 corridor 边 → **blocked**（与 oh-my-dsh 同规则）。  
   *理由*：F3 共性是「破坏性变更埋在 release notes 正文」；127 卡已是 curated + pinned source 的现成结构化知识。

2. **预检输出对齐三层失败分类**  
   把现有 export 硬闸 / peer 警告的结果字段扩成：  
   `layer: link-time | mount-time | run-time` + `subject` + `fix`（stderr 签名表见 acp-doctor）。  
   *理由*：F6 #7/#8 半升级对的两种硬失败可被三分类稳定捕获；也是社区 #5609 要的「红黄绿清单」最小可交付。

3. **禁止解析 `latest` 空包 / 强制钉版本预检**  
   扫描已忽略 `latest` 比较，但 **安装路径**（`dsh plugin add`）仍可能装到 `latest=0.0.1-rc.1` 空包。preflight 增加：目标 spec 无版本且 registry `latest` 解析结果缺 `lib/index.js` / 无 `dsh.bundle` → **blocked**，改写为显式 version 或 `next`/`alpha` tag。  
   *理由*：#5813 家族 8 次独立上报，误导性 `does not provide an export named`。

### P1 — 下一迭代（补齐五类中的 C/D）

4. **存储格式指纹闸门**  
   消费 `compat/schema.json` 的 `storageFormats` + 本地魔数扫描（对齐 dsh-compat-guard）。目标 host 的 `sessionFormat` ≠ 当前 → **blocked**（或要求 snapshot 后 force）。  
   *理由*：rc.8 会话全丢、V3/V4 只向前迁移——这是数据损坏级，比插件挂更严重。

5. **Adapter/工具契约 capability probe**  
   对插件声明/引用的 host 方法面做 `typeof` 探测（F6 #4：probe capability 而非 version string），至少覆盖 `LlmAdapter.prepareCall`、`Session.events` 替代面、`tool-subagent-control`。  
   *理由*：这类死在**首次调用**，启动期无提示；pre-flight 七类 regex 也扫不到「方法没了」。

6. **post-update codemod 钩子（迁移卡 recipe 机器可执行化）**  
   卡片 `Migration recipe` 的 old→new ledger（如 `session.events.length → session.seq`）做成可选自动替换 + dry-run。对齐 Renovate `postUpgradeTasks` 但默认只建议不执行。  
   *理由*：oh-my-dsh 卡已是 checkable steps；这是把「知识源」变成「解决办法」的关键一步。

### P2 — 结构性（兼容模型）

7. **插件侧兼容元数据契约**  
   推动/读取 `package.json` 的 `dsh.compat.{requires,tested,storageFormats,kind}`（compat-guard）+ Hub `compatibilitySchema{dsh,platforms,surfaces,hmr}` + `entryIds/before/after`。preflight 优先级：实测矩阵 > 作者元数据 > `untested` 警告（不硬拦）。  
   *理由*：F6 社区诉求「manifest 声明兼容范围 + boot loud mismatch」的插件侧落地；与 pax-beehive/Hub 生态互通。

8. **发布冷却期 + peer 破坏分级**  
   吸收 ncu `--cooldown` / Renovate `minimumReleaseAge` + pnpm「peer 变更 = major」分级；破坏级卡片（`Type: breaking`）触发的升级默认不进「Update all」。

9. **声明面白名单 CI**  
   对齐 grunmin `api-surface-check`：本仓只 import host 的 published exports / 官方声明 seam，阻断对内部路径的依赖——防止 update-copilot 自己成为下一批「半升级死」样本。

---

## 7. 建议的预检输出契约（最小字段集）

综合 F8 可吸收字段，`update_copilot_preflight` 结果建议统一为：

```json
{
  "decision": "ok | warning | blocked",
  "corridor": { "from": "dsh-v0.1.5-rc.2", "to": "dsh-v0.1.6-alpha.2", "edges": 2, "missingEdge": false },
  "layerFindings": [
    {
      "layer": "link-time | mount-time | run-time | storage | peer | breaking-card",
      "subject": "…",
      "actionLevel": "required | required-if-hit | conditional | optional | informational",
      "touchpoints": [1, 3, 5],
      "cards": ["DSH-0.1.2-A4-03"],
      "evidence": "…",
      "fix": "…"
    }
  ],
  "peerWarnings": [],
  "storageFormats": { "current": "zstd-jsonl", "target": "zstd-jsonl", "projcacheVersion": [3, 4] },
  "forceAvailable": true
}
```

与现有 `ok/warning/blocked + blocker evidence + peer-range warnings + breaking-change signals` 兼容，只做向后兼容扩展。

---

## 8. 风险与边界

- oh-my-dsh 走廊 0.1.5-rc.2 之后的边仍是 draft/等认领；0.1.6/0.1.7 的卡可能滞后于 npm（alpha 线已到 0.1.7-alpha.1，含 Session V4）。预检遇缺边必须显式报 gap，不得用记忆补卡（oh-my-dsh 明文规则）。
- compat-guard 的 `lib/formats.json` 自承 seed-only，rc.7 存储布局仍 `unknown`——存储闸门需 registry 回退，未知格式只警告/只备份，不猜测转换。
- 本报告不建议 update-copilot 直接执行迁移 codemod 的默认开启；P0 以「结构化证据 + 分类修复建议」为主，自动改写放 P1 且默认 dry-run。
- 官方仍无 host API version / throwing stub；在官方补齐前，任何兼容模型都是社区侧近似，预检必须保留 `force` 逃生舱并全程可回滚（本仓 history/rollback 已具备）。

---

## 9. 证据索引

| 角度 | 文件 | 条数 |
|---|---|---|
| DSH 版本与发布轨迹 | `findings/F1.md` | 10+ |
| 插件加载与 Host API 面 | `findings/F2.md` | 15 |
| Issues/兼容讨论 | `findings/F3.md` | 15 |
| 版本/peer/semver 坑 | `findings/F4.md` | 18 |
| 同类升级工具门禁 | `findings/F5.md` | 15 |
| 社区真实故障 | `findings/F6.md` | 15 |
| 官方作者文档 | `findings/F7.md` | 17 |
| 结构化破坏性变更知识源 | `findings/F8.md` | 13 |

本仓现状对照：`lib/preflight.js`（peer 警告）、`lib/compat.js`（named-export 硬闸）、README「Update guardrails / Host export check / Pre-flight peer warnings / Post-update collateral check」。
