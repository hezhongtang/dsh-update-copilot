window.__ModuleLoader__.load({ id: "dsh-update-copilot", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-update-copilot client.
 *
 * Three seats:
 *  - Settings section: the full update radar page (core + every profile's
 *    plugins, merged package-centrically with ownership disclosure, inline
 *    update highlights, and one-click / bulk updates. The core card and the
 *    plugins card fold their quiet parts: core & official bundles collapsed
 *    by default, plugins split into "updates available" and a folded
 *    "up to date" section.
 *  - sidebar.footer.action: a trigger beside the Settings button. Its badge
 *    hydrates once after mount and once more after startup scan completion — no
 *    ongoing background polling unless the user opts into the 30-minute
 *    periodic refresh in settings (one interval per page, this seat drives it).
 *  - shell.overlay: a modal popup with the compact radar — same folded layout
 *    as the settings page; same one-click updates. Opened via the
 *    sidebar button or the `?duc=1` URL parameter (visual-test hook).
 *
 * Hand-authored CJS bundle (no build step); externals are `react` and the
 * host-provided `@deepseek-ai/dsh-client-ui-primitives` icon set.
 */

const React = require('react')
const h = React.createElement
const { useState, useEffect, useCallback, useRef, useSyncExternalStore } = React
// Official icon set (chevrons etc.), resolved by the host ModuleLoader just
// like dsh-market does. Fall back to text glyphs if it is ever unavailable.
let primitives = null
try {
  primitives = require('@deepseek-ai/dsh-client-ui-primitives')
} catch { /* host without the primitives bundle — text chevrons below */ }

const NS = 'dsh-update-copilot'
const NS_CORE_FOLDED = 'dsh-update-copilot:core-folded'
const NS_LOGS_OPEN = 'dsh-update-copilot:logs-open'

const zh = {
  nav: '更新助手',
  subtitle: 'DSH 本体、bundle 与全部插件的版本雷达（跨 profile 合并）',
  refresh: '刷新',
  rescanning: '扫描中…',
  lastScan: '上次扫描',
  loading: '加载中…',
  loadFail: '加载失败，请重试',
  retry: '重试',
  close: '关闭',
  coreTitle: 'DSH 本体与官方 bundle',
  corePolicy: '本体更新由 npm 管理，这里只报告、不执行',
  coreCurrent: '已是最新',
  coreBehind: '有新版本',
  copyCmd: '复制升级命令',
  copied: '已复制',
  pluginsTitle: '插件（跨 profile 合并）',
  profilesHint: '同一插件可能装在多个 profile（web / headless / desktop…）；这里按包名合并展示，只更新具有独立更新资格的 profile。',
  noPlugins: '没有任何插件依赖',
  mountedBy: '由 {name} 挂载（独立）',
  mounts: '挂载独立插件：{names}',
  showMounted: '展开 {name} 挂载的独立插件',
  hideMounted: '收起 {name} 挂载的独立插件',
  updateBundle: '更新 bundle',
  updatingBundle: '正在更新 bundle {i}/{n}：{name}',
  bundleUpdated: '✓ bundle 更新完成',
  bundleNoChange: 'bundle 无需更新',
  bundleFailed: '{n} 项更新失败',
  mountedUpdates: '{n} 个挂载插件可更新',
  kindNpm: 'npm',
  kindGithub: 'GitHub',
  kindLinked: '本地链接',
  kindFile: '本地目录',
  kindGit: 'git',
  kindOther: '其他',
  current: '当前',
  latest: '最新',
  repo: '仓库',
  npmPage: 'npm 包页面',
  upToDate: '已最新',
  behind: '可更新',
  brief: '更新要点',
  hideBrief: '收起',
  update: '更新',
  updateAll: '一键更新全部',
  updatingAll: '正在更新 {i}/{n}：{name}',
  updatedAll: '✓ 全部更新完成',
  bulkFailed: '{n} 项更新失败',
  itemUpdated: '{p}：已更新',
  itemCurrent: '{p}：已是最新',
  itemFailed: '{p}：失败',
  itemSkipped: '{p}：跳过',
  confirmUpdate: '确认更新？',
  switchRemote: '切换至远端源更新',
  confirmSwitchRemote: '确认切换远端源？',
  switchedRemote: '✓ 已切换到远端源，后续更新走 npm/GitHub 通道',
  updating: '更新中…',
  updated: '✓ 已更新',
  hotReloaded: '✓ 已更新并热重载',
  updateNoChange: '未检测到变化',
  updateFail: '更新失败',
  restartHint: '插件更新完成后需重启 dsh（如 dsh web）生效',
  risk: '风险',
  riskHigh: '高',
  riskMedium: '中',
  riskLow: '低',
  riskUnknown: '未知',
  riskNone: '无',
  semver: '版本跨度',
  recommendation: '建议',
  versions: '版本列表',
  commits: '提交',
  releases: '发行说明',
  compare: '对比链接',
  aheadBy: '落后',
  commitsUnit: '个提交',
  noMaterial: '暂无更新要点（可能网络受限或已是最新）',
  officialNote: '官方包随 dsh 本体更新',
  linkedNote: '本地开发链接，请在其仓库内 git pull',
  logs: '操作日志',
  logsCollapse: '收起日志',
  empty: '还没有任何记录',
  scanSummary: '{p} 个插件 · {b} 个可更新',
  updatesAvailableSection: '可更新',
  upToDateSection: '已最新',
  upToDateFold: '{n} 项已最新',
  badgeTitle: '{n} 项更新可用',
  hideBadge: '隐藏更新红点',
  hideBadgeDesc: '关闭侧栏按钮上的「可更新数量」徽章；弹窗与本页仍会显示完整信息',
  autoUpdate: '点击按钮时自动更新',
  autoUpdateDesc: '开启后，点击侧栏「更新助手」按钮时若发现有落后的插件，立即自动开始「一键更新全部」；dsh 本体仍只报告、不执行',
  periodicRefresh: '每 30 分钟自动刷新',
  periodicRefreshDesc: '默认关闭：上游只在启动时和你的操作时被查询。开启后，每 30 分钟在后台强制刷新一次，徽章与打开的雷达视图自动跟进',
  progressPhase: '{phase}…',
  progress_start: '开始更新',
  progress_waiting: '等待服务端完成…（旧版服务端，无实时进度）',
  progress_resolving: '解析依赖',
  progress_downloading: '下载中',
  progress_retry: '重试中',
  progress_stash: '暂存本地改动',
  progress_pull: '拉取上游',
  progress_pop: '恢复本地改动',
  semverMajor: '主版本 ×{n}',
  semverMinor: '次版本 ×{n}',
  semverPatch: '补丁 ×{n}',
  recCurrent: '已是最新，无需操作。',
  recLow: '可以放心更新：仅补丁级修复。',
  recMedium: '通常可以更新；建议先浏览发行说明确认行为变化。',
  recHigh: '建议暂缓：大版本跳跃，先读迁移说明与 dsh 兼容范围再决定。',
  recLinked: '本地链接插件：确认后 copilot 会在仓库内自动执行 git pull（先暂存本地改动，拉取后恢复）。',
  recUnknown: '无 semver 信号：阅读下面的提交 / 发行说明后再决定。',
  noteRegistry: 'registry 暂不可达——无版本元数据',
  noteNoFetch: '本地未 fetch origin/HEAD——在仓库内执行 git fetch 后可见提交详情',
  noteNoFetchCompare: '本地未 fetch origin/HEAD——提交列表需先 git fetch；GitHub 对比页可直接打开',
  noteCompareUnavailable: 'GitHub compare 不可用（限流或网络）——请手动打开对比页',
  errUpdateRunning: '已有更新在进行中，请稍候',
  errLinked: '本地链接插件请在它的仓库里自行更新（git pull）',
  errOfficial: '官方包随 dsh 本体升级，此处不执行',
  errNotInstalled: '该插件未安装在此 profile',
  errUnsafe: '目标被安全策略拒绝',
  errConfirm: '需要先获得你的确认',
  errFailed: '更新失败',
  errFailedAttempts: '更新失败（已尝试 {n} 次）',
  errTimeout: '更新超时',
  errTimeoutAttempts: '更新超时（已尝试 {n} 次）',
  errNoop: 'pnpm 跑完了，但本地没有变化；请重新扫描后再试，如果一直这样，把下方输出发来排查。',
  errLatestUnavailable: '拿不到 npm 上的最新版本，稍后再试。',
  errUnsupportedChannel: '这种安装方式暂不支持自动更新。',
  errLinkedNoGit: '本地目录不是 git 仓库，无法自动 pull；请在其仓库内手动更新。',
  errLinkedNoUpstream: '本地 checkout 没有配置上游分支，无法自动 pull；请先 git push -u 设置上游。',
  errLinkedStashFailed: '暂存本地改动失败，已中止更新，未改动仓库；请手动处理未提交改动后重试。',
  errLinkedPullFailed: 'git pull 失败，本地改动已恢复原位；请检查下方输出后重试。',
  errLinkedMergeConflict: 'git pull 遇到合并冲突，需要手动处理：在仓库内解决冲突，或 git merge --abort 撤销后重试。',
  errLinkedPopConflict: '拉取已成功，但恢复本地改动时冲突。请在仓库内手动解决：git stash list 查看，git stash pop 重试恢复。',
  errLinkedTimeout: 'git pull 超时，本地改动已恢复原位；请检查网络后重试。',
  errSwitchNoRepo: '本地仓库的 origin 不是 GitHub，无法切换远端源。',
  errSwitchUnavailable: '既无 npm 发布，本地仓库也无可用 GitHub 上游，无法切换远端源。',
  errSwitchSpecUnchanged: '依赖 spec 未被改写（仍是本地链接），请手动处理。',
  liveUpdating: '正在更新：{name}',
  liveUpdatingProfile: '正在更新：{name}（{profile}）',
  liveBusy: '有更新正在进行，请稍候',
}

const en = {
  nav: 'Update Copilot',
  subtitle: 'Version radar for the DSH core, bundles, and plugins (merged across profiles)',
  refresh: 'Refresh',
  rescanning: 'Scanning…',
  lastScan: 'Last scan',
  loading: 'Loading…',
  loadFail: 'Failed to load, please retry',
  retry: 'Retry',
  close: 'Close',
  coreTitle: 'DSH core & official bundles',
  corePolicy: 'Core updates are npm-managed — reported here, never executed',
  coreCurrent: 'Up to date',
  coreBehind: 'New version',
  copyCmd: 'Copy upgrade command',
  copied: 'Copied',
  pluginsTitle: 'Plugins (merged across profiles)',
  profilesHint: 'A package may be installed in several profiles (web / headless / desktop…). Rows are merged by package name; Update targets only profiles eligible for an independent update.',
  noPlugins: 'No plugin dependencies installed',
  mountedBy: 'Mounted by {name} (independent)',
  mounts: 'Mounts independent plugins: {names}',
  showMounted: 'Show independent plugins mounted by {name}',
  hideMounted: 'Hide independent plugins mounted by {name}',
  updateBundle: 'Update bundle',
  updatingBundle: 'Updating bundle {i}/{n}: {name}',
  bundleUpdated: '✓ Bundle update finished',
  bundleNoChange: 'Bundle is already up to date',
  bundleFailed: '{n} update(s) failed',
  mountedUpdates: '{n} mounted update(s) available',
  kindNpm: 'npm',
  kindGithub: 'GitHub',
  kindLinked: 'linked',
  kindFile: 'file',
  kindGit: 'git',
  kindOther: 'other',
  current: 'current',
  latest: 'latest',
  repo: 'Repository',
  npmPage: 'npm package page',
  upToDate: 'Up to date',
  behind: 'Update available',
  brief: 'Update highlights',
  hideBrief: 'Hide',
  update: 'Update',
  updateAll: 'Update all',
  updatingAll: 'Updating {i}/{n}: {name}',
  updatedAll: '✓ All updates finished',
  bulkFailed: '{n} update(s) failed',
  itemUpdated: '{p}: updated',
  itemCurrent: '{p}: already current',
  itemFailed: '{p}: failed',
  itemSkipped: '{p}: skipped',
  confirmUpdate: 'Confirm update?',
  switchRemote: 'Switch to remote source',
  confirmSwitchRemote: 'Switch to remote source?',
  switchedRemote: '✓ Switched to remote source — future updates via npm/GitHub',
  updating: 'Updating…',
  updated: '✓ Updated',
  hotReloaded: '✓ Updated — hot reloaded',
  updateNoChange: 'No change detected',
  updateFail: 'Update failed',
  restartHint: 'Restart dsh (e.g. dsh web) after plugin updates to apply them',
  risk: 'Risk',
  riskHigh: 'high',
  riskMedium: 'medium',
  riskLow: 'low',
  riskUnknown: 'unknown',
  riskNone: 'none',
  semver: 'Semver jump',
  recommendation: 'Recommendation',
  versions: 'Versions',
  commits: 'Commits',
  releases: 'Release notes',
  compare: 'Compare',
  aheadBy: 'behind by',
  commitsUnit: 'commits',
  noMaterial: 'No update highlights (network-limited or already current)',
  officialNote: 'Official packages follow the dsh core',
  linkedNote: 'Local dev link — git pull inside its checkout',
  logs: 'Operation log',
  logsCollapse: 'Collapse log',
  empty: 'Nothing recorded yet',
  scanSummary: '{p} plugin(s) · {b} update(s) available',
  updatesAvailableSection: 'Updates available',
  upToDateSection: 'Up to date',
  upToDateFold: '{n} up to date',
  badgeTitle: '{n} update(s) available',
  hideBadge: 'Hide update badge',
  hideBadgeDesc: 'Turn off the update-count badge on the sidebar button; the popup and this page keep full details',
  autoUpdate: 'Auto-update on button click',
  autoUpdateDesc: 'When on, clicking the sidebar Update Copilot button immediately starts "Update all" if outdated plugins are found; the dsh core stays report-only',
  periodicRefresh: 'Refresh every 30 minutes',
  periodicRefreshDesc: 'Off by default: upstreams are queried at startup and on your actions only. When on, a forced refresh runs in the background every 30 minutes, and the badge and any open radar views follow along',
  progressPhase: '{phase}…',
  progress_start: 'Starting update',
  progress_waiting: 'Waiting for the server… (older server, no live progress)',
  progress_resolving: 'Resolving dependencies',
  progress_downloading: 'Downloading',
  progress_retry: 'Retrying',
  progress_stash: 'Stashing local changes',
  progress_pull: 'Pulling upstream',
  progress_pop: 'Restoring local changes',
  semverMajor: 'major ×{n}',
  semverMinor: 'minor ×{n}',
  semverPatch: 'patch ×{n}',
  recCurrent: 'Already current — nothing to do.',
  recLow: 'Safe to update: patch-level fixes only.',
  recMedium: 'Usually safe to update; skim the release notes for behavior changes first.',
  recHigh: 'Hold: major version jump. Read the migration notes, check dsh peer ranges, then decide.',
  recLinked: 'Local linked plugin: on confirm, the copilot runs git pull in its checkout (auto-stash first, then restores your local changes).',
  recUnknown: 'No semver signal: read the commits/release notes below, then decide.',
  noteRegistry: 'registry unreachable — no version metadata',
  noteNoFetch: 'origin/HEAD not fetched locally — run git fetch in the checkout for commit details',
  noteNoFetchCompare: 'origin/HEAD not fetched locally — the commit list needs a git fetch; the compare view on GitHub is always available',
  noteCompareUnavailable: 'GitHub compare unavailable (rate limit or network) — open the compare page manually',
  errUpdateRunning: 'Another update is already running — try again shortly',
  errLinked: 'Locally linked plugins update from their own checkout (git pull there)',
  errOfficial: 'Official packages follow the dsh core — update dsh itself',
  errNotInstalled: 'Plugin is not installed in this profile',
  errUnsafe: 'Target rejected by the safety policy',
  errConfirm: 'Your explicit confirmation is required first',
  errFailed: 'Update failed',
  errFailedAttempts: 'Update failed after {n} attempts',
  errTimeout: 'Update timed out',
  errTimeoutAttempts: 'Update timed out after {n} attempts',
  errNoop: 'pnpm finished but nothing changed. Re-scan and retry; if it persists, share the output below for debugging.',
  errLatestUnavailable: 'Could not resolve the latest version from npm. Try again shortly.',
  errUnsupportedChannel: 'This install channel is not auto-updatable yet.',
  errLinkedNoGit: 'The directory is not a git checkout — update it manually from its own repo.',
  errLinkedNoUpstream: 'The checkout has no upstream branch configured — run git push -u to set one first.',
  errLinkedStashFailed: 'Could not stash local changes; aborted before touching the checkout. Handle the uncommitted changes and retry.',
  errLinkedPullFailed: 'git pull failed and local changes were restored. Check the output below and retry.',
  errLinkedMergeConflict: 'git pull stopped on a merge conflict — resolve it in the checkout, or git merge --abort to undo and retry.',
  errLinkedPopConflict: 'The pull succeeded, but restoring your stashed local changes conflicted. Resolve manually: git stash list, then git stash pop to retry the restore.',
  errLinkedTimeout: 'git pull timed out and local changes were restored. Check your network and retry.',
  errSwitchNoRepo: 'The checkout\'s origin is not a GitHub remote — cannot switch to a remote source.',
  errSwitchUnavailable: 'No npm release and no usable GitHub upstream — cannot switch to a remote source.',
  errSwitchSpecUnchanged: 'The dependency spec was not rewritten (still a local link). Handle the switch manually.',
  liveUpdating: 'Updating: {name}',
  liveUpdatingProfile: 'Updating: {name} ({profile})',
  liveBusy: 'An update is running — please wait',
}

const DUC_STYLES_ID = 'duc-styles'
const DUC_STYLES_PLUGIN = 'dsh-update-copilot'

function injectStyles() {
  if (typeof document === 'undefined' || document.head === null) return
  const css = [
    '.duc{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.5}',
    '.duc-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
    '.duc-head h2{margin:0;font-size:16px;font-weight:600}',
    '.duc-sub{opacity:.7;font-size:12px}',
    '.duc-meta{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:12px;opacity:.75}',
    '.duc-btn{border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}',
    '.duc-btn:hover:not(:disabled){border-color:rgba(127,127,127,.9)}',
    '.duc-btn:disabled{opacity:.45;cursor:default}',
    '.duc-btn.primary{border-color:rgba(80,140,255,.7);color:inherit;background:rgba(80,140,255,.12)}',
    '.duc-btn.danger{border-color:rgba(220,80,80,.7);background:rgba(220,80,80,.1)}',
    '.duc-card{border:1px solid rgba(127,127,127,.3);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px}',
    '.duc-card-title{font-weight:600;font-size:13px}',
    // collapse header — follows the dsh-market diag-section disclosure pattern
    // (chevron icon + title + trailing actions in one full-width button)
    '.duc-collapse-head{font:inherit;color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer;text-align:left;background:0 0;border:none;align-items:center;gap:8px;width:100%;padding:0;font-size:13px;font-weight:600;display:flex}',
    '.duc-collapse-icon{color:var(--dsw-alias-label-secondary,#6b7280);flex-shrink:0;display:inline-flex}',
    '.duc-collapse-title{flex:1;min-width:0}',
    '.duc-chevron-fallback{font-size:12px;line-height:1}',
    '.duc-note{font-size:12px;opacity:.65}',
    '.duc-section-label{font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#6b7280);padding-top:4px}',
    '.duc-section-body{display:flex;flex-direction:column;gap:0}',
    '.duc-profiles-hint{font-size:12px;opacity:.75;border-left:2px solid rgba(127,127,127,.35);padding:2px 10px}',
    '.duc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0;border-top:1px solid rgba(127,127,127,.15)}',
    '.duc-row:first-of-type{border-top:none}',
    '.duc-name{font-weight:500;word-break:break-all}',
    '.duc-aggregate-toggle{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;padding:0;border:1px solid rgba(127,127,127,.3);border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer}',
    '.duc-aggregate-toggle:hover{border-color:rgba(127,127,127,.8);color:inherit}',
    '.duc-aggregate-toggle:focus-visible{outline:1px solid var(--dsw-alias-border-l2,#888);outline-offset:1px}',
    '.duc-mount-chip{opacity:.72;border-style:dotted}',
    '.duc-mounted-group{margin:0 0 0 10px;padding-left:10px;border-left:2px solid rgba(80,140,255,.35)}',
    '.duc-mounted-group .duc-row{padding:5px 0}',
    '.duc-chip{font-size:11px;border:1px solid rgba(127,127,127,.4);border-radius:4px;padding:0 5px;opacity:.85}',
    '.duc-chip.duc-cat{opacity:.6;border-style:dashed}',
    '.duc-ver{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}',
    '.duc-arrow{opacity:.6}',
    '.duc-badge{font-size:11px;border-radius:4px;padding:1px 7px}',
    '.duc-badge.ok{color:#2e9e5b;background:rgba(46,158,91,.12);border:1px solid rgba(46,158,91,.4)}',
    '.duc-badge.behind{color:#c07a1a;background:rgba(220,160,40,.12);border:1px solid rgba(220,160,40,.45)}',
    '.duc-badge.high{color:#c25050;background:rgba(220,80,80,.1);border:1px solid rgba(220,80,80,.45)}',
    '.duc-badge.medium{color:#b08a2e;background:rgba(200,160,40,.1);border:1px solid rgba(200,160,40,.4)}',
    '.duc-badge.low{color:#2e9e5b;background:rgba(46,158,91,.1);border:1px solid rgba(46,158,91,.35)}',
    '.duc-badge.unknown,.duc-badge.none{opacity:.7;border:1px solid rgba(127,127,127,.4)}',
    '.duc-actions{margin-left:auto;display:flex;gap:6px;align-items:center}',
    // update progress bar + status line under the row
    '.duc-progress-wrap{display:flex;align-items:center;gap:10px;padding:4px 0 6px;font-size:12px}',
    '.duc-progress{flex:1;height:6px;min-width:120px;border-radius:3px;background:rgba(127,127,127,.18);overflow:hidden}',
    '.duc-progress-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,#508cff,#7ab8ff);transition:width .2s ease}',
    '.duc-progress-fill.duc-indet{width:40%!important;animation:duc-indet 1.2s ease-in-out infinite}',
    '@keyframes duc-indet{0%{margin-left:-40%}100%{margin-left:100%}}',
    '.duc-progress-label{flex:none;font-variant-numeric:tabular-nums;min-width:38px;text-align:right;opacity:.8}',
    '.duc-brief{border-top:1px dashed rgba(127,127,127,.3);margin-top:6px;padding:8px 0 2px;display:flex;flex-direction:column;gap:6px;font-size:12.5px}',
    '.duc-brief b{font-weight:600}',
    '.duc-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:2px}',
    '.duc-list a{color:inherit}',
    '.duc-release-body{white-space:pre-wrap;word-break:break-word;opacity:.85;font-size:12px;line-height:1.5;margin-top:2px;max-height:96px;overflow:auto}',
    '.duc a{color:inherit}',
    '.duc-repolink{color:inherit;text-decoration:none;opacity:.55;font-size:12px;line-height:1;flex:none}',
    '.duc-repolink:hover{opacity:1;text-decoration:underline}',
    '.duc-chip.duc-repolink{text-decoration:none;opacity:.85}',
    '.duc-chip.duc-repolink:hover{opacity:1;border-color:rgba(127,127,127,.9)}',
    '.duc-cmd{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;border:1px dashed rgba(127,127,127,.4);border-radius:6px;padding:6px 8px;word-break:break-all}',
    '.duc-banner{border:1px solid rgba(80,140,255,.45);background:rgba(80,140,255,.08);border-radius:8px;padding:8px 12px;font-size:12.5px}',
    // live "update in progress" banner — pulsing dot beside the text, same
    // banner family as the restart hint so the two states read as siblings
    '.duc-banner.live{display:flex;align-items:center;gap:8px;border-color:rgba(80,140,255,.55);background:rgba(80,140,255,.12)}',
    '.duc-live-dot{flex:none;width:8px;height:8px;border-radius:50%;background:#508cff;animation:duc-live-pulse 1s ease-in-out infinite}',
    '@keyframes duc-live-pulse{0%,100%{opacity:.35}50%{opacity:1}}',
    '.duc-log{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-all;border:1px solid rgba(127,127,127,.25);border-radius:6px;padding:8px;max-height:220px;overflow:auto;opacity:.85}',
    '.duc-error{color:#c25050}',
    '.duc-fold{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;opacity:.85;cursor:pointer;padding:4px 0 0;text-align:left;display:inline-flex;align-items:center;gap:4px}',
    '.duc-fold:hover{opacity:1}',
    '.duc-pref{display:flex;align-items:flex-start;gap:10px;cursor:pointer}',
    '.duc-pref input[type="checkbox"]{margin:3px 0 0;flex:none;width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary,#508cff);cursor:pointer}',
    '.duc-pref-body{display:flex;flex-direction:column;gap:2px;min-width:0}',
    // sidebar footer trigger — geometry copied from the shipped settings
    // trigger (ui-settings-general .VOzbGW_trigger) so both rows share one
    // grid: 14px/22px text, 34px tall, -4px bleed with a 10px text inset.
    '.duc-foot-btn{position:relative;box-sizing:border-box;cursor:pointer;width:calc(100% + 8px);height:34px;color:var(--dsw-alias-label-primary,inherit);background:0 0;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -4px;padding:6px 2px 6px 10px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}',
    '.duc-foot-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
    '.duc-foot-btn:focus-visible{outline:1px solid var(--dsw-alias-border-l2,#888);outline-offset:-1px}',
    '.duc-foot-btn.duc-rail{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}',
    '.duc-foot-icon{display:inline-flex;flex:none;align-items:center}',
    '.duc-foot-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    // badge: inline pill after the label in wide mode (flex centers it on the
    // text line); corner dot on the round rail variant, kept inside the
    // button's overflow:hidden bounds.
    '.duc-foot-badge{display:inline-flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-state-error-primary,#d25050);color:#fff;font-size:10px;line-height:1;font-variant-numeric:tabular-nums;pointer-events:none}',
    '.duc-rail .duc-foot-badge{position:absolute;top:2px;right:2px}',
    // while an update runs, the badge turns into a pulsing dot so the sidebar
    // keeps showing the activity even with the popup closed
    '.duc-foot-badge.live{background:var(--dsw-alias-state-info-primary,#508cff);animation:duc-live-pulse 1.1s ease-in-out infinite}',
    // modal popup
    '.duc-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999;padding:24px}',
    '.duc-modal{background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);width:min(680px,100%);max-height:min(82vh,780px);display:flex;flex-direction:column;outline:none}',
    '.duc-modal-head{display:flex;align-items:flex-start;gap:12px;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25))}',
    '.duc-modal-head h2{margin:0;font-size:15px;font-weight:600}',
    '.duc-modal-head .duc-sub{margin-top:2px}',
    '.duc-modal-x{margin-left:auto;flex:none;border:none;background:transparent;color:inherit;font-size:14px;line-height:1;cursor:pointer;opacity:.6;padding:5px 7px;border-radius:6px}',
    '.duc-modal-x:hover{opacity:1;background:rgba(127,127,127,.15)}',
    '.duc-modal-body{padding:12px 16px 16px;overflow:auto;display:flex;flex-direction:column;gap:12px}',
    '.duc-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;opacity:.75}',
    '.duc-bulk-progress{flex:1 1 180px;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  ].join('\n')
  // Self-healing replace: a page that kept an older bundle's sheet (same id,
  // possibly without the rules a newer bundle adds) must not block the fresh
  // one — otherwise new seats render with the browser's default button chrome
  // (the boxed look). The data-plugin stamp is the platform convention (see
  // dsh-client-hmr removeOwnedStyles / dshmarket) so hot reload and unload can
  // clean the tag and let the next bundle re-inject.
  const existing = document.getElementById(DUC_STYLES_ID)
  if (existing !== null && existing.getAttribute('data-plugin') === DUC_STYLES_PLUGIN && existing.textContent === css) return
  if (existing !== null) existing.remove()
  const style = document.createElement('style')
  style.id = DUC_STYLES_ID
  style.setAttribute('data-plugin', DUC_STYLES_PLUGIN)
  style.textContent = css
  document.head.appendChild(style)
}

// Inject once at module top level, before any seat mounts: the panel, the
// sidebar trigger and the popup share one sheet, and a fresh bundle must win
// over whatever an older bundle left in the page.
injectStyles()

async function api(path, options) {
  const res = await fetch(path, { cache: 'no-store', ...options })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

/**
 * Resolve one update response into an outcome. Accepts every wire shape the
 * server has ever produced:
 *  - non-2xx answers (403 untrusted origin, 400 missing confirm, 500 server
 *    error) carry a JSON `{ error }` envelope → throw with that message;
 *  - a Server-Sent Events stream (`text/event-stream`) carrying `progress` /
 *    `retry` / `phase` frames and a final `done` frame with the outcome;
 *  - a plain JSON body carrying the outcome directly — used by an older
 *    server whose update route predates SSE (mixed-version skew: the page
 *    always loads the newest client from disk while the long-lived dsh
 *    process keeps its boot-time server code). The update already ran
 *    server-side; returning its outcome keeps the success/failure truthful
 *    instead of reporting a phantom "stream ended" failure.
 *
 * The body branch is shape-agnostic on purpose: it tries JSON first, then
 * falls back to scanning for SSE `data:` frames, so a rewritten or missing
 * content-type on a genuine stream still resolves. Only a body that is
 * neither JSON nor a stream raises — with the content-type and an excerpt so
 * the next incident names itself.
 *
 * Skew contract: the SSE route landed 2026-08-18 (plugin commit f0c4fbf;
 * "stream ended" phrasing shipped in the same client). Once every reachable
 * server runs that route (all processes restarted after that date), the
 * plain-body branch and this comment can be deleted.
 *
 * Exported for the regression tests; not part of the plugin contract.
 */
async function consumeUpdateResponse(res, onEvent) {
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try { message = (await res.json()).error ?? message } catch { /* keep default */ }
    throw new Error(message)
  }
  const isStream = /text\/event-stream/i.test(
    typeof res.headers?.get === 'function' ? (res.headers.get('content-type') ?? '') : '',
  )
  if (!isStream) {
    onEvent?.({ type: 'phase', phase: 'waiting' })
    let raw = ''
    try {
      raw = await res.text()
    } catch (error) {
      throw new Error(`update response could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
    let outcome = null
    try { outcome = JSON.parse(raw) } catch { /* not JSON — scan for SSE frames below */ }
    if (outcome !== null && typeof outcome === 'object' && !Array.isArray(outcome)) return outcome

    // SSE frame wire-format, mirrored from lib/routes.js sendSse() — keep the
    // two in sync when the format changes (see test/sse-client.test.mjs as well).
    let sawSse = false
    let scan = raw
    let frameSep
    while ((frameSep = scan.indexOf('\n\n')) !== -1) {
      const frameText = scan.slice(0, frameSep)
      scan = scan.slice(frameSep + 2)
      const dataLine = frameText.split('\n').find((l) => l.startsWith('data: '))
      if (dataLine === undefined) continue
      sawSse = true
      let event
      try { event = JSON.parse(dataLine.slice(6)) } catch { continue }
      if (event.type === 'done') return event.outcome
      onEvent(event)
    }

    const type = typeof res.headers?.get === 'function' ? (res.headers.get('content-type') ?? '') : ''
    const excerpt = raw.length > 0 ? raw.slice(0, 120) : ''
    throw new Error(
      `update endpoint did not answer with a stream or an outcome`
      + ` (content-type: ${type === '' ? 'none' : type}`
      + `${sawSse ? ', SSE frames seen but no terminal done event' : ''}`
      + `${excerpt !== '' ? `, body: ${JSON.stringify(excerpt)}` : ''})`,
    )
  }

  const reader = res.body?.getReader()
  if (reader === undefined || reader === null) throw new Error('streaming not supported')
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      // A transport may deliver its final chunk together with `done: true`; the
      // terminating frame can live inside it, so drain it before stopping.
      if (value !== undefined) buffer += decoder.decode(value, { stream: true })
      let sep
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
        if (dataLine === undefined) continue
        let event
        try { event = JSON.parse(dataLine.slice(6)) } catch { continue }
        if (event.type === 'done') return event.outcome
        onEvent(event)
      }
      if (done) break
    }
  } finally {
    // Release the body whether we resolved (done seen) or threw mid-stream.
    try { await reader.cancel?.() } catch { /* already closed */ }
  }
  throw new Error('stream ended before the result')
}

/**
 * POST an update and resolve the response. The package-centric default (no
 * `profile`) updates the package in every profile that has it installed —
 * the update command is identical for all profiles; a `profile` restricts the
 * update to one profile. Throws on transport errors and on every answer shape
 * `consumeUpdateResponse` classifies as a failure.
 */
async function streamUpdate(name, onEvent, profile = undefined, source = undefined, profiles = undefined) {
  const res = await fetch('/dsh-update-copilot/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      confirm: true,
      ...(profile !== undefined && profile !== '' ? { profile } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(Array.isArray(profiles) ? { profiles } : {}),
    }),
    cache: 'no-store',
  })
  return consumeUpdateResponse(res, onEvent)
}

function shortVer(v) {
  if (v === null || v === undefined) return '—'
  const s = String(v)
  return s.length === 40 ? s.slice(0, 7) : s
}

// The wire format is ISO-8601 UTC (toISOString on the host); render through
// Date so every clock and date shown follows the browser's local timezone
// instead of a raw UTC slice (which read 8 hours early on UTC+8).
function fmtClock(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtDate(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---------------------------------------------------------------------------
// Settings nav icon patch.
//
// The settings shell derives every section's nav glyph from a hardcoded id
// map (models / agent-presets / plugins); every other section falls back to
// the generic gear. The settings.section registration contract has no icon
// field, so a registrant cannot supply one through the slot. This patch
// swaps the gear inside OUR nav cell for the same radar SVG the sidebar
// trigger uses, so both entrances carry one mark. It is label-matched,
// idempotent, and disconnected with the plugin. The durable fix is an
// upstream `icon` option on settings.section registrations.
// ---------------------------------------------------------------------------

const NAV_LABELS = [zh.nav, en.nav]
const SVG_NS = 'http://www.w3.org/2000/svg'

function radarSvgElement(className) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  if (className !== null && className.length > 0) svg.setAttribute('class', className)
  svg.setAttribute('data-duc', 'nav-radar')
  const outer = document.createElementNS(SVG_NS, 'circle')
  outer.setAttribute('cx', '8'); outer.setAttribute('cy', '8'); outer.setAttribute('r', '6.2')
  outer.setAttribute('stroke', 'currentColor'); outer.setAttribute('stroke-width', '1.1')
  const inner = document.createElementNS(SVG_NS, 'circle')
  inner.setAttribute('cx', '8'); inner.setAttribute('cy', '8'); inner.setAttribute('r', '3')
  inner.setAttribute('stroke', 'currentColor'); inner.setAttribute('stroke-width', '.9'); inner.setAttribute('opacity', '.5')
  const beam = document.createElementNS(SVG_NS, 'path')
  beam.setAttribute('d', 'M8 8 L12.2 3.8')
  beam.setAttribute('stroke', 'currentColor'); beam.setAttribute('stroke-width', '1.1'); beam.setAttribute('stroke-linecap', 'round')
  svg.append(outer, inner, beam)
  return svg
}

function patchSettingsNavIcons() {
  // The shipped settings panel is the dialog that owns a <nav>; ours (.duc-modal) is not.
  const dialogs = document.querySelectorAll('div[role="dialog"][aria-modal="true"]:not(.duc-modal)')
  for (const dialog of dialogs) {
    for (const btn of dialog.querySelectorAll('nav button')) {
      const label = (btn.textContent ?? '').trim()
      if (!NAV_LABELS.includes(label)) continue
      const gear = btn.firstElementChild
      if (gear === null || gear.tagName.toLowerCase() !== 'svg' || gear.hasAttribute('data-duc')) continue
      btn.replaceChild(radarSvgElement(gear.getAttribute('class')), gear)
    }
  }
}

/** Observe body; re-patch whenever the settings panel (re)mounts. */
function mountSettingsNavIconPatch() {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined' || document.body === null) {
    return () => {}
  }
  const observer = new MutationObserver((mutations) => {
    if (mutations.some((m) => m.addedNodes.length > 0)) patchSettingsNavIcons()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  patchSettingsNavIcons()
  return () => observer.disconnect()
}

// ---------------------------------------------------------------------------
// Shared cross-seat UI state: popup open flag + the badge summary.
// useSyncExternalStore contract: immutable snapshots, notify on replace.
// ---------------------------------------------------------------------------

/** Badge preference, per browser (localStorage — remote browsers keep it too). */
const BADGE_PREF_KEY = 'duc.hideBadge'

function readBadgePref() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(BADGE_PREF_KEY) === '1'
  } catch {
    return false
  }
}

function writeBadgePref(hidden) {
  try {
    localStorage.setItem(BADGE_PREF_KEY, hidden ? '1' : '0')
  } catch { /* storage unavailable — in-memory only */ }
}

/**
 * Auto-update preference, same per-browser storage as the badge toggle. Off by
 * default: updates still start only after an explicit click, the option just
 * makes that one click on the sidebar trigger also mean "run Update all".
 */
const AUTO_PREF_KEY = 'duc.autoUpdate'

function readAutoUpdatePref() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(AUTO_PREF_KEY) === '1'
  } catch {
    return false
  }
}

function writeAutoUpdatePref(on) {
  try {
    localStorage.setItem(AUTO_PREF_KEY, on ? '1' : '0')
  } catch { /* storage unavailable — in-memory only */ }
}

/**
 * Periodic refresh preference, same per-browser storage as the other toggles.
 * Off by default: upstreams are touched at startup and on user action; only
 * an explicit opt-in schedules a forced refresh every 30 minutes.
 */
const PERIODIC_PREF_KEY = 'duc.periodicRefresh'
const PERIODIC_REFRESH_MS = 30 * 60 * 1000

function readPeriodicRefreshPref() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(PERIODIC_PREF_KEY) === '1'
  } catch {
    return false
  }
}

function writePeriodicRefreshPref(on) {
  try {
    localStorage.setItem(PERIODIC_PREF_KEY, on ? '1' : '0')
  } catch { /* storage unavailable — in-memory only */ }
}

/** Toggle the periodic refresh option; persists like the badge toggle. */
function setPeriodicRefresh(on) {
  writePeriodicRefreshPref(on)
  setUi({ periodicRefresh: on === true })
}

let uiState = { open: false, opener: null, summary: null, generatedAt: null, hideBadge: readBadgePref(), autoUpdate: readAutoUpdatePref(), periodicRefresh: readPeriodicRefreshPref(), refreshTick: 0, autoRunAll: false, operation: null }
const uiSubs = new Set()

function setUi(patch) {
  uiState = { ...uiState, ...patch }
  for (const notify of uiSubs) notify()
}

/** Toggle the sidebar badge; persists across sessions per browser. */
function setHideBadge(hidden) {
  writeBadgePref(hidden)
  setUi({ hideBadge: hidden })
}

/** Toggle the click-to-auto-update option; persists like the badge toggle. */
function setAutoUpdate(on) {
  writeAutoUpdatePref(on)
  setUi({ autoUpdate: on === true })
}

/**
 * Packages the auto-run should update: behind somewhere AND auto-updatable on
 * at least one channel. Mirrors runAll's `canAutoUpdate` filter with an extra
 * explicit updateAvailable guard; exported through __test for regression tests.
 */
function autoTargetsOf(plugins) {
  if (!Array.isArray(plugins)) return []
  return plugins.filter((p) => p !== null && typeof p === 'object'
    && p.updateAvailable === true && p.canAutoUpdate === true)
}

function subscribeUi(notify) {
  uiSubs.add(notify)
  return () => uiSubs.delete(notify)
}

function useUi() {
  // Third arg = getServerSnapshot: identical to the client snapshot, which
  // keeps the component server-renderable (harmless in the browser).
  return useSyncExternalStore(subscribeUi, () => uiState, () => uiState)
}

// ---------------------------------------------------------------------------
// Live "update in progress" state, server-truthful.
//
// The server keeps a live slot for the currently executing update — recorded
// from EVERY trigger path (web routes, agent tools, link: switches) — and
// serves it at /dsh-update-copilot/update-status. One shared poller per page
// reads it and publishes through a useSyncExternalStore store, so every seat
// renders the same reality: the sidebar badge turns into a pulsing dot, the
// popup/panel show a live banner, and update buttons disable while one is
// running. Without this, a background update (auto-run after the popup
// closed, an agent-tool update, another tab) only surfaced as the confusing
// "another update is already running" error when the user clicked Update in
// the foreground. The poll is a local in-process JSON read (no upstream IO),
// unrelated to the lazy scan policy.
// ---------------------------------------------------------------------------

const LIVE_POLL_MS = 2000

let liveState = null // { running, current, progress } | null before the first poll
const liveSubs = new Set()
let liveTimer = null

function publishLive(state) {
  liveState = state
  for (const notify of liveSubs) notify()
}

async function pollLive() {
  let data = null
  try {
    const res = await fetch('/dsh-update-copilot/update-status', { cache: 'no-store' })
    data = await res.json().catch(() => null)
  } catch { /* transient — keep the last known state */ }
  if (data !== null && typeof data === 'object') publishLive(data)
}

function subscribeLive(notify) {
  liveSubs.add(notify)
  if (liveTimer === null) {
    // One timer per page, alive while at least one seat listens — the
    // sidebar trigger seat keeps it running in web sessions; nothing polls
    // when the bundle is loaded with no seat mounted.
    liveTimer = setInterval(pollLive, LIVE_POLL_MS)
    pollLive()
  }
  return () => {
    liveSubs.delete(notify)
    if (liveSubs.size === 0 && liveTimer !== null) {
      clearInterval(liveTimer)
      liveTimer = null
    }
  }
}

function useLive() {
  // getServerSnapshot = null: on the server no poll ever ran, render idle.
  return useSyncExternalStore(subscribeLive, () => liveState, () => null)
}

/** Normalized "is an update executing right now" from a live snapshot. */
function liveRunningOf(live) {
  return live !== null && typeof live === 'object' && live.running === true
}

/** Minimum gap between forced external-completion rescans (upstream IO). */
const LIVE_RESCAN_THROTTLE_MS = 30000
let lastLiveRescanAt = 0

/**
 * Re-scan when an update this seat did not start finishes (agent tools,
 * another tab, an auto-run orphaned by closing the popup), so the table
 * reflects the new versions instead of letting the user re-click an already
 * updated row. Throttled: an external bulk can finish many packages in quick
 * succession and every forced scan re-queries upstreams; the executors clear
 * the scan cache on disk changes, so the unforced fallback read is fresh
 * there.
 */
function useLiveCompletionRefresh(load) {
  const live = useLive()
  const wasRunning = useRef(live !== null && live.running === true)
  useEffect(() => {
    const running = live !== null && live.running === true
    if (wasRunning.current && !running) {
      const now = Date.now()
      if (now - lastLiveRescanAt >= LIVE_RESCAN_THROTTLE_MS) {
        lastLiveRescanAt = now
        load(true)
      } else {
        load(false)
      }
    }
    wasRunning.current = running
  }, [live, load])
}

function loadBadgeStatus(force = false) {
  return api(`/dsh-update-copilot/status${force ? '?force=1' : ''}`)
    .then((data) => {
      setUi({ summary: data.summary, generatedAt: data.generatedAt })
      return data
    })
}

/** One scan-data owner shared by the settings page and the popup. */
function useCopilotData(active) {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [needRestart, setNeedRestart] = useState(false)
  const [opsVersion, setOpsVersion] = useState(0)

  const load = useCallback((force) => {
    setBusy(true)
    setError(null)
    return api(`/dsh-update-copilot/status${force ? '?force=1' : ''}`)
      .then((data) => {
        setStatus(data)
        setUi({ summary: data.summary, generatedAt: data.generatedAt })
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setBusy(false))
  }, [])

  useEffect(() => { if (active) load(false) }, [active, load])

  // Opt-in periodic refresh: the sidebar seat advances refreshTick every 30
  // minutes while the preference is on; open radar seats reload here. The
  // ref keeps the tick the seat mounted with from forcing an extra load.
  const ui = useUi()
  const lastRefreshTick = useRef(ui.refreshTick)
  useEffect(() => {
    if (ui.refreshTick === lastRefreshTick.current) return
    lastRefreshTick.current = ui.refreshTick
    load(true)
  }, [ui.refreshTick, load])

  const notifyUpdated = useCallback((outcome = null) => {
    if (outcome === null || outcome.requiresRestart !== false) setNeedRestart(true)
    // Stamp the external-completion throttle: the live poller will also see
    // this update finish within a second or two, and its refresh should not
    // double the forced rescan we run right now.
    lastLiveRescanAt = Date.now()
    setOpsVersion((v) => v + 1)
    return load(true)
  }, [load])

  return { status, error, busy, load, needRestart, opsVersion, notifyUpdated }
}

function RadarIcon() {
  return h('svg', { viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true', fill: 'none' },
    h('circle', { cx: '8', cy: '8', r: '6.2', stroke: 'currentColor', strokeWidth: '1.1' }),
    h('circle', { cx: '8', cy: '8', r: '3', stroke: 'currentColor', strokeWidth: '.9', opacity: '.5' }),
    h('path', { d: 'M8 8 L12.2 3.8', stroke: 'currentColor', strokeWidth: '1.1', strokeLinecap: 'round' }))
}

/**
 * Disclosure chevron: official 14px outline icon when the primitives bundle is
 * present, a plain text glyph otherwise. `open` faces down (expanded), closed
 * faces right (collapsed) — the dsh-market disclosure convention.
 */
function Chevron({ open }) {
  if (primitives !== null) {
    const Icon = open ? primitives.IconChevronDownOutline14 : primitives.IconChevronRightOutline14
    return h(Icon, { size: 14 })
  }
  return h('span', { className: 'duc-chevron-fallback' }, open ? '▾' : '▸')
}

/**
 * Category label borrowed from the dsh-market registry, when the server
 * resolved one. `categories` is the registry's `{ key: { en, zh } }` map; the
 * label follows the current UI language (html lang attribute).
 */
function CategoryChip({ category, categories }) {
  if (category === null || category === undefined) return null
  const meta = categories !== null && categories !== undefined ? categories[category] : undefined
  if (meta === null || meta === undefined) return null
  const lang = (typeof document !== 'undefined' ? document.documentElement.lang : '') || ''
  const label = lang.startsWith('zh') ? (meta.zh ?? meta.en) : (meta.en ?? meta.zh)
  if (typeof label !== 'string' || label === '') return null
  return h('span', { className: 'duc-chip duc-cat' }, label)
}

function RiskChip({ t, level }) {
  const map = { high: 'riskHigh', medium: 'riskMedium', low: 'riskLow', unknown: 'riskUnknown', none: 'riskNone' }
  return h('span', { className: `duc-badge ${level}` }, `${t('risk')}: ${t(map[level] ?? 'riskUnknown')}`)
}

function SemverSpan({ t, semver }) {
  if (semver === null || semver === undefined) return null
  const parts = []
  if (semver.major > 0) parts.push(t('semverMajor', { n: semver.major }))
  if (semver.minor > 0) parts.push(t('semverMinor', { n: semver.minor }))
  if (semver.patch > 0) parts.push(t('semverPatch', { n: semver.patch }))
  return h('span', { className: 'duc-chip' }, parts.length > 0 ? parts.join(' · ') : '0')
}

/**
 * Compact ↗ outlink for one row. Prefers the host-resolved repoUrl (it may
 * point into a monorepo subdirectory); falls back to owner/repo; npm-channel
 * items with no resolvable GitHub repository fall back to their npm package
 * page — the canonical index for an npm-installed plugin.
 */
function RepoLink({ t, repo, repoUrl, npmName, className }) {
  if (repoUrl !== null && repoUrl !== undefined) {
    return h('a', {
      className: className ?? 'duc-repolink',
      href: repoUrl,
      target: '_blank',
      rel: 'noreferrer',
      title: `${t('repo')}: ${repo ?? repoUrl}`,
      'aria-label': `${t('repo')}: ${repo ?? repoUrl}`,
    }, '↗')
  }
  if (repo !== null && repo !== undefined && repo !== '') {
    return h('a', {
      className: className ?? 'duc-repolink',
      href: `https://github.com/${repo}`,
      target: '_blank',
      rel: 'noreferrer',
      title: `${t('repo')}: ${repo}`,
      'aria-label': `${t('repo')}: ${repo}`,
    }, '↗')
  }
  if (npmName !== null && npmName !== undefined && npmName !== '') {
    return h('a', {
      className: className ?? 'duc-repolink',
      href: `https://www.npmjs.com/package/${npmName}`,
      target: '_blank',
      rel: 'noreferrer',
      title: `${t('npmPage')}: ${npmName}`,
      'aria-label': `${t('npmPage')}: ${npmName}`,
    }, '↗')
  }
  return null
}

// Host briefs carry English prose (the agent path reads them directly); the
// GUI re-synthesizes recommendation and notes from the structured fields so
// the panel follows the UI language.

function localizedRecommendation(t, brief) {
  if (brief.updateAvailable !== true) return t('recCurrent')
  if (brief.kind === 'linked') return t('recLinked')
  const level = brief.risk?.level
  if (level === 'low') return t('recLow')
  if (level === 'medium') return t('recMedium')
  if (level === 'high') return t('recHigh')
  return t('recUnknown')
}

function localizedNote(t, note) {
  if (note === null || note === undefined) return null
  if (/^nothing to summarize/.test(note)) return null // redundant with recCurrent
  if (/^registry unreachable/.test(note)) return t('noteRegistry')
  if (/origin\/HEAD not fetched locally — the commit list/.test(note)) return t('noteNoFetchCompare')
  if (/origin\/HEAD not fetched/.test(note)) return t('noteNoFetch')
  if (/GitHub compare unavailable/.test(note)) return t('noteCompareUnavailable')
  return note // unknown notes stay verbatim rather than silently dropped
}

const ERROR_CODE_KEYS = {
  update_running: 'errUpdateRunning',
  linked_install: 'errLinked',
  official_package: 'errOfficial',
  not_installed: 'errNotInstalled',
  unsafe_target: 'errUnsafe',
  invalid_profile: 'errUnsafe',
  confirm_required: 'errConfirm',
  update_failed: 'errFailed',
  update_timeout: 'errTimeout',
  update_noop: 'errNoop',
  latest_unavailable: 'errLatestUnavailable',
  unsupported_channel: 'errUnsupportedChannel',
  linked_no_git: 'errLinkedNoGit',
  linked_no_upstream: 'errLinkedNoUpstream',
  linked_stash_failed: 'errLinkedStashFailed',
  linked_pull_failed: 'errLinkedPullFailed',
  linked_merge_conflict: 'errLinkedMergeConflict',
  linked_stash_pop_conflict: 'errLinkedPopConflict',
  linked_timeout: 'errLinkedTimeout',
  linked_switch_no_repo: 'errSwitchNoRepo',
  linked_switch_unavailable: 'errSwitchUnavailable',
  linked_switch_spec_unchanged: 'errSwitchSpecUnchanged',
}

function localizedUpdateError(t, result) {
  if (result?.attempts > 1) {
    if (result.code === 'update_failed') return t('errFailedAttempts', { n: result.attempts })
    if (result.code === 'update_timeout') return t('errTimeoutAttempts', { n: result.attempts })
  }
  const key = ERROR_CODE_KEYS[result?.code ?? '']
  if (key !== undefined) return t(key)
  return `${t('errFailed')}: ${result?.error ?? ''}`
}

/**
 * One single-profile brief body: risk chip, semver span, repo link,
 * recommendation, note, and the changelog material list.
 */
function BriefBody({ t, brief }) {
  const m = brief.material ?? {}
  const listItems = []
  if (Array.isArray(m.versions) && m.versions.length > 0) {
    const items = []
    m.versions.forEach((v, i) => {
      if (i > 0) items.push(' ← ')
      items.push(v.url !== undefined && v.url !== null
        ? h('a', { key: `v${i}`, href: v.url, target: '_blank', rel: 'noreferrer' }, v.version)
        : v.version)
    })
    listItems.push(h('li', { key: 'v' },
      h('b', null, `${t('versions')}: `),
      items))
  }
  if (Array.isArray(m.commits) && m.commits.length > 0) {
    listItems.push(h('li', { key: 'c' },
      h('b', null, `${t('commits')}${m.aheadBy !== undefined ? ` (${t('aheadBy')} ${m.aheadBy} ${t('commitsUnit')})` : ''}: `),
      h('ul', { className: 'duc-list' },
        m.commits.slice(0, 10).map((c, i) => h('li', { key: i },
          c.url ? h('a', { href: c.url, target: '_blank', rel: 'noreferrer' }, `${c.sha ?? ''} ${c.message}`) : `${c.sha ?? ''} ${c.message}`)))))
  }
  if (Array.isArray(m.releases) && m.releases.length > 0) {
    listItems.push(h('li', { key: 'r' },
      h('b', null, `${t('releases')}: `),
      h('ul', { className: 'duc-list' },
        m.releases.slice(0, 3).map((r, i) => {
          const body = typeof r.body === 'string' && r.body.trim() !== '' ? r.body.trim() : null
          return h('li', { key: i },
            h('a', { href: r.url, target: '_blank', rel: 'noreferrer' }, r.name ?? r.tag),
            r.publishedAt !== undefined ? ` (${fmtDate(r.publishedAt)})` : '',
            body !== null ? h('div', { className: 'duc-release-body' }, body) : null)
        }))))
  }
  if (m.compareUrl !== null && m.compareUrl !== undefined) {
    listItems.push(h('li', { key: 'u' },
      h('a', { href: m.compareUrl, target: '_blank', rel: 'noreferrer' }, t('compare'))))
  }

  return h('div', { className: 'duc-brief' },
    h('div', null,
      h(RiskChip, { t, level: brief.risk.level }), ' ', h(SemverSpan, { t, semver: brief.semver }),
      brief.repoUrl !== null && brief.repoUrl !== undefined
        ? h(React.Fragment, null, ' ',
            h('a', { className: 'duc-chip duc-repolink', href: brief.repoUrl, target: '_blank', rel: 'noreferrer' },
              `${t('repo')} ↗`))
        : brief.npmUrl !== null && brief.npmUrl !== undefined
          ? h(React.Fragment, null, ' ',
              h('a', { className: 'duc-chip duc-repolink', href: brief.npmUrl, target: '_blank', rel: 'noreferrer', title: t('npmPage') },
                'npm ↗'))
          : null),
    h('div', null, h('b', null, `${t('recommendation')}: `), localizedRecommendation(t, brief)),
    localizedNote(t, m.note) !== null ? h('div', { className: 'duc-note' }, localizedNote(t, m.note)) : null,
    listItems.length > 0
      ? h('ul', { className: 'duc-list' }, listItems)
      : h('div', { className: 'duc-note' }, t('noMaterial')))
}

/**
 * Update highlights for one package. The package-centric server answers an
 * aggregated brief (`{ name, items: [...] }`) when no profile is given — one
 * section per profile that has the package installed; the single-profile
 * shape is still accepted for robustness.
 */
function BriefPanel({ t, name }) {
  const [brief, setBrief] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let cancelled = false
    api(`/dsh-update-copilot/brief?name=${encodeURIComponent(name)}`)
      .then((data) => { if (!cancelled) setBrief(data) })
      .catch((e) => { if (!cancelled) setError(String(e.message ?? e)) })
    return () => { cancelled = true }
  }, [name])

  if (error !== null) return h('div', { className: 'duc-brief duc-error' }, `${t('loadFail')}: ${error}`)
  if (brief === null) return h('div', { className: 'duc-brief' }, t('loading'))
  if (brief.error !== undefined) return h('div', { className: 'duc-brief duc-error' }, brief.error)

  if (Array.isArray(brief.items) && brief.items.length > 0) {
    return h('div', { className: 'duc-brief', style: { gap: '10px' } },
      brief.items.map((b) => h('div', { key: b.profile, style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { className: 'duc-card-title' }, b.profile),
        h(BriefBody, { t, brief: b }))))
  }
  return h(BriefBody, { t, brief })
}

// Visual-test hook: set once by the `&brief=1` URL parameter — behind rows
// then start with their update highlights already expanded (screenshot-visible).
let autoBrief = false

const KIND_KEYS = { npm: 'kindNpm', github: 'kindGithub', linked: 'kindLinked', file: 'kindFile', git: 'kindGit', other: 'kindOther' }

/**
 * Result line for one update outcome. Per-package outcomes carry an `items`
 * array (one entry per profile); render them as a compact list so a mixed
 * success/failure is truthful. Single-profile outcomes (the link→remote
 * switch) keep the original one-line rendering.
 */
function UpdateResult({ t, result }) {
  if (result.items !== undefined && Array.isArray(result.items)) {
    return h('div', { className: `duc-note ${result.ok ? '' : 'duc-error'}` },
      result.changed
        ? (result.hotReloaded === true ? t('hotReloaded') : t('updated'))
        : (result.code === 'update_noop' ? t('updateNoChange') : t('updateFail')),
      h('ul', { className: 'duc-list' },
        result.items.map((item) => h('li', { key: item.profile },
          item.ok === true
            ? t('itemUpdated', { p: item.profile })
            : item.current === true
              ? t('itemCurrent', { p: item.profile })
              : item.skipped !== undefined
                ? `${t('itemSkipped', { p: item.profile })} — ${localizedUpdateError(t, item)}`
                : `${t('itemFailed', { p: item.profile })} — ${localizedUpdateError(t, item)}`))))
  }
  return h('div', { className: `duc-note ${result.ok ? '' : 'duc-error'}` },
    result.ok
      ? (result.switched !== undefined ? t('switchedRemote')
        : result.changed ? (result.hotReloaded === true ? t('hotReloaded') : t('updated'))
          : t('updateNoChange'))
      : localizedUpdateError(t, result))
}

/**
 * One package row, merged across profiles: the version cell lists every
 * installed profile with its current → latest; a single click on Update runs
 * only in its explicit eligible profiles. The only remaining two-step action is the destructive
 * link→remote source switch.
 */
function rowActionsDisabled(busy, bulkRunning) {
  return busy || bulkRunning === true
}

function acquireMutation(kind) {
  if (uiState.operation !== null) return false
  setUi({ operation: kind })
  return true
}

function releaseMutation() {
  setUi({ operation: null })
}

async function withMutationLock(kind, operation) {
  if (!acquireMutation(kind)) return undefined
  try {
    return await operation()
  } finally {
    releaseMutation()
  }
}

function rowUpdateTarget(row) {
  return { name: row.name, profiles: row.updatableProfiles ?? [] }
}

function scopedRowUpdateTarget(row, relationshipProfiles = []) {
  const target = rowUpdateTarget(row)
  if (relationshipProfiles.length === 0) return target
  return { ...target, profiles: target.profiles.filter((profile) => relationshipProfiles.includes(profile)) }
}

function bundleUpdateTargets(parent, mountedChildren) {
  const children = []
  const visit = (nodes, inheritedProfiles = []) => nodes.forEach((node) => {
    const edgeProfiles = node.relationshipProfiles ?? []
    const profiles = inheritedProfiles.length === 0
      ? edgeProfiles
      : edgeProfiles.length === 0 ? inheritedProfiles : inheritedProfiles.filter((profile) => edgeProfiles.includes(profile))
    children.push({ row: node.row, relationshipProfiles: profiles })
    visit(node.children, profiles)
  })
  visit(mountedChildren)
  const seen = new Set()
  return [{ row: parent, relationshipProfiles: [] }, ...children]
    .filter(({ row }) => row.canAutoUpdate === true && row.updateAvailable === true)
    .map(({ row, relationshipProfiles }) => scopedRowUpdateTarget(row, relationshipProfiles))
    .filter((target) => target.profiles.length > 0)
    .filter((target) => {
      const key = `${target.name}\u0000${[...target.profiles].sort().join('\u0000')}`
      if (seen.has(key)) return false
      seen.add(key)
     return true
     })
}

function globalUpdateTargets(plugins) {
  return plugins
    .filter((row) => row.canAutoUpdate === true && row.updateAvailable === true)
    .map(rowUpdateTarget)
}

function mountedUpdateCount(children) {
  return children.reduce((count, child) => count + (child.row.updateAvailable === true ? 1 : 0) + mountedUpdateCount(child.children), 0)
}

function shouldShowBundleUpdate(parent, mountedChildren) {
  if (mountedChildren.length === 0) return false
  return bundleUpdateTargets(parent, mountedChildren).length > 0
}

function mountRelationshipInfo(row) {
  const profiles = row.profiles ?? []
  const mountedBy = [...new Set([
    row.mountedBy,
    ...profiles.map((profile) => profile.mountedBy),
  ]
    .filter((parent) => typeof parent === 'string' && parent !== ''))]
  const relationships = [
    ...(row.mounts ?? []),
    ...(row.relationships ?? []),
    ...profiles.flatMap((profile) => profile.relationships ?? []),
  ]
  const mounts = [...new Map(relationships
    .filter((relation) => typeof relation?.child === 'string' && relation.child !== '')
    .map((relation) => [`${relation.profile ?? ''}/${relation.child}`, relation]))
    .values()]
  return { mountedBy, mounts }
}

function PluginRow({ t, row, categories, onUpdated, bulkRunning = false, refreshing = false, mountedChildren = [], onRunBundle }) {
  const ui = useUi()
  const [open, setOpen] = useState(autoBrief && row.updateAvailable === true)
  const [mountedOpen, setMountedOpen] = useState(false)
  const [switchConfirming, setSwitchConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  // Live update progress: null = idle; percent=null renders an indeterminate
  // bar (pnpm output carries no percentage yet); phase is the latest stage.
  const [progress, setProgress] = useState(null)
  // Cross-seat guard: while ANY update runs (auto-run, agent tools, another
  // tab), the row's own actions disable — the server serializes updates and
  // would answer the click with "another update is already running".
  const live = useLive()
  const liveRunning = liveRunningOf(live)

  const canUpdate = row.canAutoUpdate === true
  const switchProfile = row.profiles.length === 1 && row.profiles[0].canSwitch === true
    ? row.profiles[0].profile
    : null
  const hasMounted = mountedChildren.length > 0
  const canUpdateBundle = shouldShowBundleUpdate(row, mountedChildren)
  const mountedBehind = mountedUpdateCount(mountedChildren)
  const mountInfo = mountRelationshipInfo(row)
  const note = row.official ? t('officialNote') : null
  const actionsDisabled = rowActionsDisabled(busy, bulkRunning || refreshing || ui.operation !== null)

  async function runUpdate() {
    if (!acquireMutation('row')) return
    setBusy(true)
    setResult(null)
    setProgress({ percent: null, phase: 'start' })
    try {
      const outcome = await streamUpdate(row.name, (event) => {
        if (event.type === 'progress') setProgress({ percent: event.percent, phase: event.phase })
        else if (event.type === 'retry') setProgress({ percent: null, phase: 'retry' })
        else if (event.type === 'phase' && event.phase === 'start') setProgress({ percent: null, phase: 'start' })
      }, undefined, undefined, rowUpdateTarget(row).profiles)
      setResult(outcome)
      if (outcome.ok && outcome.changed) await onUpdated(outcome)
    } catch (e) {
      setResult({ ok: false, error: String(e.message ?? e) })
    } finally {
      setBusy(false)
      setSwitchConfirming(false)
      setProgress(null)
      releaseMutation()
    }
  }

  async function runSwitch() {
    if (!acquireMutation('switch')) return
    setBusy(true)
    setResult(null)
    setProgress({ percent: null, phase: 'start' })
    try {
      const outcome = await streamUpdate(row.name, (event) => {
        if (event.type === 'progress') setProgress({ percent: event.percent, phase: event.phase })
        else if (event.type === 'retry') setProgress({ percent: null, phase: 'retry' })
        else if (event.type === 'phase' && event.phase === 'start') setProgress({ percent: null, phase: 'start' })
      }, switchProfile, 'remote')
      setResult(outcome)
      if (outcome.ok && outcome.changed) await onUpdated(outcome)
    } catch (e) {
      setResult({ ok: false, error: String(e.message ?? e) })
    } finally {
      setBusy(false)
      setSwitchConfirming(false)
      setProgress(null)
      releaseMutation()
    }
  }

  return h('div', null,
    h('div', { className: 'duc-row' },
      h('span', { className: 'duc-name' }, row.name),
      h(RepoLink, { t, repo: row.repo, repoUrl: row.repoUrl, npmName: row.profiles.some((p) => p.kind === 'npm') ? row.name : undefined }),
      hasMounted ? h('button', {
        type: 'button',
        className: 'duc-aggregate-toggle',
        onClick: () => setMountedOpen(!mountedOpen),
        'aria-expanded': mountedOpen,
        'aria-label': t(mountedOpen ? 'hideMounted' : 'showMounted', { name: row.name }),
        title: t(mountedOpen ? 'hideMounted' : 'showMounted', { name: row.name }),
      }, h('span', { 'aria-hidden': 'true' }, h(Chevron, { open: mountedOpen }))) : null,
      h(CategoryChip, { category: row.category, categories }),
      mountInfo.mountedBy.map((parent) => h('span', { className: 'duc-chip duc-mount-chip', key: parent },
        t('mountedBy', { name: parent }))),
      h('span', { className: 'duc-ver' },
        row.profiles.map((p) => h('span', {
          key: p.profile,
          className: 'duc-chip',
          title: `${p.profile} · ${t(KIND_KEYS[p.kind] ?? 'kindOther')} · ${t('current')}: ${p.current} → ${t('latest')}: ${p.latest ?? '—'}`,
        }, p.updateAvailable
          ? `${p.profile}: ${shortVer(p.current)} → ${shortVer(p.latest)}`
          : `${p.profile}: ${shortVer(p.current)}`))),
      h('span', { className: `duc-badge ${row.updateAvailable ? 'behind' : 'ok'}` },
        row.updateAvailable ? t('behind') : t('upToDate')),
      !row.updateAvailable && mountedBehind > 0 ? h('span', { className: 'duc-note' },
        t('mountedUpdates', { n: mountedBehind })) : null,
      mountInfo.mounts.length > 0 ? h('span', { className: 'duc-note' },
        t('mounts', { names: mountInfo.mounts.map((relation) => relation.child).join(', ') })) : null,
      note !== null ? h('span', { className: 'duc-note' }, note) : null,
      h('span', { className: 'duc-actions' },
        row.updateAvailable ? h('button', { className: 'duc-btn', onClick: () => setOpen(!open), disabled: busy },
          open ? t('hideBrief') : t('brief')) : null,
        canUpdate ? (busy
          ? h('button', { className: 'duc-btn', disabled: true }, t('updating'))
          : h('button', { className: 'duc-btn primary', onClick: runUpdate, disabled: actionsDisabled || liveRunning, title: liveRunning ? t('liveBusy') : undefined }, t('update'))) : null,
        canUpdateBundle ? h('button', {
          className: 'duc-btn',
          onClick: () => onRunBundle?.(row, mountedChildren),
          disabled: actionsDisabled || liveRunning,
        }, t('updateBundle')) : null,
        switchProfile !== null ? (busy || liveRunning
          ? null
          : h('button', {
              className: `duc-btn ${switchConfirming ? 'danger' : ''}`,
              onClick: () => (switchConfirming ? runSwitch() : setSwitchConfirming(true)),
              onBlur: () => setSwitchConfirming(false),
              disabled: actionsDisabled,
            }, switchConfirming ? t('confirmSwitchRemote') : t('switchRemote'))) : null)),
    progress !== null ? h('div', { className: 'duc-progress-wrap' },
      h('div', { className: 'duc-progress' },
        h('div', {
          className: progress.percent === null
            ? 'duc-progress-fill duc-indet'
            : 'duc-progress-fill',
          style: progress.percent === null ? undefined : { width: `${progress.percent}%` },
        })),
      h('span', { className: 'duc-progress-label' },
        progress.percent !== null ? `${progress.percent}%` : t('progressPhase', { phase: t(`progress_${progress.phase}`) }))) : null,
    result !== null ? h(UpdateResult, { t, result }) : null,
    open ? h(BriefPanel, { t, name: row.name }) : null,
    hasMounted && mountedOpen ? h('div', { className: 'duc-mounted-group' },
      mountedChildren.map((child) => h(PluginRow, {
        t, row: child.row, categories, key: child.row.name, onUpdated, bulkRunning, refreshing,
        mountedChildren: child.children, onRunBundle,
      }))) : null,
    )
}

function CoreCard({ t, core }) {
  // Folded by default — the core is report-only and rarely actionable. The
  // stored flag keeps the user's explicit choice: '0' = unfolded on purpose.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(NS_CORE_FOLDED) !== '0' } catch { return true }
  })
  const [copied, setCopied] = useState(false)
  const coreRow = core.packages[0]
  function toggleCollapsed() {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem(NS_CORE_FOLDED, next ? '1' : '0') } catch { /* storage unavailable */ }
  }
  function copyCmd() {
    navigator.clipboard?.writeText(core.updateCommand ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  const bundleRows = core.packages.slice(1)
  const visibleRows = collapsed ? core.packages.slice(0, 1) : core.packages
  return h('div', { className: 'duc-card' },
    h('button', { type: 'button', className: 'duc-collapse-head', onClick: toggleCollapsed, 'aria-expanded': !collapsed },
      h('span', { className: 'duc-collapse-icon', 'aria-hidden': 'true' },
        h(Chevron, { open: !collapsed })),
      h('span', { className: 'duc-collapse-title' }, t('coreTitle')),
      coreRow !== undefined && coreRow.updateAvailable
        ? h('span', { className: 'duc-actions' },
            h('button', {
              type: 'button',
              className: 'duc-btn primary',
              onClick: (e) => { e.stopPropagation(); if (core.updateCommand !== null) navigator.clipboard?.writeText(core.updateCommand) },
              title: t('copyCmd'),
            }, t('copyCmd')))
        : null),
    visibleRows.map((p) => h('div', { className: 'duc-row', key: p.name },
      h('span', { className: 'duc-name' }, p.name),
      h(RepoLink, { t, repo: p.repo, repoUrl: p.repoUrl, npmName: p.name }),
      h('span', { className: 'duc-chip' }, p.kind),
      h('span', { className: 'duc-ver' }, shortVer(p.current),
        p.updateAvailable ? h('span', { className: 'duc-arrow' }, ' → ') : null,
        p.updateAvailable ? shortVer(p.latest) : null),
      h('span', { className: `duc-badge ${p.updateAvailable ? 'behind' : 'ok'}` },
        p.updateAvailable ? t('coreBehind') : t('coreCurrent')))),
    !collapsed && core.updateCommand !== null ? h('div', null,
      h('div', { className: 'duc-note' }, t('corePolicy')),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        h('code', { className: 'duc-cmd', style: { flex: 1 } }, core.updateCommand),
        h('button', { className: 'duc-btn', onClick: copyCmd }, copied ? t('copied') : t('copyCmd')))) : null,
    !collapsed && coreRow !== undefined && !coreRow.updateAvailable ? h('div', { className: 'duc-note' }, t('corePolicy')) : null)
}

/**
 * The single plugins card: every package merged across profiles, one row per
 * package, split into two sections — "updates available" always rendered,
 * "up to date" behind a disclosure folded by default (settings page and popup
 * share this layout). `plugins` is the aggregated list from the scan.
 */
function partitionPluginGroups(plugins) {
  const mounted = groupMountedRows(plugins)
  const behind = []
  const current = []
  for (const node of mounted) {
    const group = { parent: node.row, mountedChildren: node.children }
    if (nodeIsBehind(node)) behind.push(group)
    else current.push(group)
  }
  return { behind, current }
}

function groupMountedRows(plugins) {
  const rowsByName = new Map(plugins.map((row) => [row.name, row]))
  const edgesByParent = new Map()
  const incoming = new Set()

  function reaches(start, target, seen = new Set()) {
    if (start === target) return true
    if (seen.has(start)) return false
    seen.add(start)
    return (edgesByParent.get(start) ?? []).some((edge) => reaches(edge.child, target, seen))
  }

  for (const parent of plugins) {
    for (const relation of parent.mounts ?? []) {
      const child = relation?.child
      const childRow = rowsByName.get(child)
      if (typeof child !== 'string' || child === parent.name || childRow === undefined) continue
      if (relation.parent !== parent.name || typeof relation.profile !== 'string') continue
      const childProfile = (childRow.profiles ?? []).find((profile) => profile.profile === relation.profile)
      // The child profile is authoritative: a parent may only render its
      // selected relationship, never a competing inferred edge.
      if (childProfile?.mountedBy !== parent.name) continue
      let edge = (edgesByParent.get(parent.name) ?? []).find((candidate) => candidate.child === child)
      if (edge === undefined) {
        if (reaches(child, parent.name)) continue
        edge = { child, profiles: [] }
        const edges = edgesByParent.get(parent.name) ?? []
        edges.push(edge)
        edgesByParent.set(parent.name, edges)
      }
      if (!edge.profiles.includes(relation.profile)) edge.profiles.push(relation.profile)
      incoming.add(child)
    }
  }

  function buildNode(row, relationshipProfiles = [], ancestry = new Set()) {
    const nextAncestry = new Set(ancestry)
    nextAncestry.add(row.name)
    const children = []
    for (const edge of edgesByParent.get(row.name) ?? []) {
      if (nextAncestry.has(edge.child)) continue
      const profiles = relationshipProfiles.length === 0
        ? edge.profiles
        : edge.profiles.filter((profile) => relationshipProfiles.includes(profile))
      if (profiles.length === 0) continue
      children.push(buildNode(rowsByName.get(edge.child), profiles, nextAncestry))
    }
    return { row, relationshipProfiles, children }
  }

  return plugins.filter((row) => !incoming.has(row.name)).map((row) => buildNode(row))
}

function nodeIsBehind(node) {
  return node.row.updateAvailable === true || node.children.some(nodeIsBehind)
}

function PluginListCard({ t, plugins, categories, onUpdated, bulkRunning = false, bundleRunning = false, refreshing = false, onRunBundle }) {
  const [showOk, setShowOk] = useState(false)
  const groups = partitionPluginGroups(plugins)
  const renderGroups = (items) => items.map(({ parent, mountedChildren }) => h(PluginRow, {
    t, row: parent, categories, key: parent.name, onUpdated,
    bulkRunning: bulkRunning || bundleRunning, refreshing, mountedChildren, onRunBundle,
  }))

  return h('div', { className: 'duc-card' },
    h('div', { className: 'duc-card-title' },
      t('pluginsTitle'), ' ',
      h('span', { className: 'duc-note' }, t('scanSummary', { p: plugins.length, b: groups.behind.length }))),
    plugins.length === 0
      ? h('div', { className: 'duc-note' }, t('noPlugins'))
      : h(React.Fragment, null,
          groups.behind.length > 0 ? h('div', { className: 'duc-section-label' }, t('updatesAvailableSection')) : null,
          renderGroups(groups.behind),
          groups.current.length > 0 ? h('button', {
            type: 'button',
            className: 'duc-collapse-head',
            onClick: () => setShowOk(!showOk),
            'aria-expanded': showOk,
          },
            h('span', { className: 'duc-collapse-icon', 'aria-hidden': 'true' },
              h(Chevron, { open: showOk })),
            h('span', { className: 'duc-collapse-title' }, t('upToDateSection')),
            h('span', { className: 'duc-note' }, t('upToDateFold', { n: groups.current.length }))) : null,
          showOk ? h('div', { className: 'duc-section-body' }, renderGroups(groups.current)) : null))
}

/**
 * The "update everything outdated" runner: loops the aggregated canAutoUpdate
 * packages sequentially through the same single-flight update route (the
 * server serializes anyway) and reports progress via `bulk` state.
 */
function useBulkUpdate() {
  const [bulk, setBulk] = useState({ running: false, index: 0, total: 0, name: null })
  const [bulkResult, setBulkResult] = useState(null)
  const runAll = useCallback(async (plugins, onUpdated) => {
    const targets = globalUpdateTargets(plugins)
    if (targets.length === 0) return
    return withMutationLock('all', async () => {
      setBulkResult(null)
      setBulk({ running: true, index: 0, total: targets.length, name: null })
      const results = []
      try {
        for (let i = 0; i < targets.length; i += 1) {
          setBulk({ running: true, index: i + 1, total: targets.length, name: targets[i].name })
          try {
            results.push({ name: targets[i].name, outcome: await streamUpdate(targets[i].name, () => {}, undefined, undefined, targets[i].profiles) })
          } catch (e) {
            results.push({ name: targets[i].name, outcome: { ok: false, error: String(e.message ?? e) } })
          }
        }
        const failed = results.filter((r) => r.outcome.ok !== true).length
        const changed = results.some((r) => r.outcome.changed === true)
        setBulkResult({ failed, changed, requiresRestart: results.some((r) => r.outcome.requiresRestart === true) })
        if (changed) await onUpdated?.({ requiresRestart: results.some((r) => r.outcome.requiresRestart === true) })
        return results
      } finally {
        setBulk({ running: false, index: 0, total: 0, name: null })
      }
    })
  }, [])
  return { bulk, bulkResult, runAll }
}

/**
 * Persistent "an update is executing right now" banner for the settings page
 * and the popup. Renders whenever the server reports a running update —
 * whoever started it (this seat, the auto-run, the agent tools, another tab).
 * `current` names the package (and profile for single-profile updates);
 * `progress` adds the latest stage label or percentage.
 */
function LiveBanner({ t }) {
  const live = useLive()
  if (!liveRunningOf(live) || live.current === null || live.current === undefined) return null
  const cur = live.current
  const label = typeof cur.profile === 'string' && cur.profile !== ''
    ? t('liveUpdatingProfile', { name: cur.name, profile: cur.profile })
    : t('liveUpdating', { name: cur.name })
  let detail = ''
  const prog = live.progress
  if (prog !== null && typeof prog === 'object') {
    if (typeof prog.percent === 'number') detail = ` ${prog.percent}%`
    else if (typeof prog.phase === 'string' && prog.phase !== '') {
      detail = ` ${t('progressPhase', { phase: t(`progress_${prog.phase}`) })}`
    }
  }
  return h('div', { className: 'duc-banner live', 'aria-live': 'polite' },
    h('span', { className: 'duc-live-dot', 'aria-hidden': 'true' }),
    `${label}…${detail}`)
}

function useBundleUpdate() {
  const [bundle, setBundle] = useState({ running: false, index: 0, total: 0, name: null })
  const [bundleResult, setBundleResult] = useState(null)
  const runBundle = useCallback(async (parent, mountedChildren, onUpdated) => {
    const targets = bundleUpdateTargets(parent, mountedChildren)
    if (targets.length === 0) return undefined
    return withMutationLock('bundle', async () => {
      setBundleResult(null)
      setBundle({ running: true, index: 0, total: targets.length, name: null })
      const results = []
      try {
        for (let i = 0; i < targets.length; i += 1) {
          const target = targets[i]
          setBundle({ running: true, index: i + 1, total: targets.length, name: target.name })
          try {
            results.push({ ...target, outcome: await streamUpdate(target.name, () => {}, undefined, undefined, target.profiles) })
          } catch (e) {
            results.push({ ...target, outcome: { ok: false, error: String(e.message ?? e) } })
          }
        }
        const failed = results.filter((result) => result.outcome.ok !== true).length
        const changed = results.some((result) => result.outcome.changed === true)
        setBundleResult({ parent: parent.name, results, failed })
        if (changed) await onUpdated?.({ requiresRestart: results.some((result) => result.outcome.requiresRestart === true) })
        return results
      } finally {
        setBundle({ running: false, index: 0, total: 0, name: null })
      }
    })
  }, [])
  return { bundle, bundleResult, runBundle }
}

function BundleUpdateResult({ t, result }) {
  const changed = result.results.some((item) => item.outcome.changed === true)
  return h('div', { className: `duc-note ${result.failed > 0 ? 'duc-error' : ''}` },
    result.failed > 0 ? t('bundleFailed', { n: result.failed }) : (changed ? t('bundleUpdated') : t('bundleNoChange')),
    h('ul', { className: 'duc-list' }, result.results.map((item) => h('li', { key: item.name },
      item.outcome.ok === true
        ? (item.outcome.changed ? t('itemUpdated', { p: item.name }) : t('itemCurrent', { p: item.name }))
        : `${t('itemFailed', { p: item.name })} — ${localizedUpdateError(t, item.outcome)}`))))
}

/** Toolbar actions shared by the settings page and the popup. */
function UpdateAllButton({ t, plugins, bulk, runAll, liveRunning, blocked = false }) {
  const hasTargets = globalUpdateTargets(plugins).length > 0
  if (bulk.running) {
    return h('span', { className: 'duc-bulk-progress', title: t('updatingAll', { i: bulk.index, n: bulk.total, name: bulk.name }) },
      t('updatingAll', { i: bulk.index, n: bulk.total, name: bulk.name }))
  }
  if (liveRunning) {
    return h('span', { className: 'duc-meta' }, t('liveBusy'))
  }
  return hasTargets
    ? h('button', { className: 'duc-btn primary', onClick: () => runAll(plugins), disabled: blocked }, t('updateAll'))
    : null
}

function LogTail({ t, opsVersion }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(NS_LOGS_OPEN) === '1' } catch { return false }
  })
  const [ops, setOps] = useState(null)
  useEffect(() => {
    let cancelled = false
    api('/dsh-update-copilot/logs')
      .then((data) => { if (!cancelled) setOps(data.ops ?? []) })
      .catch(() => { if (!cancelled) setOps([]) })
    return () => { cancelled = true }
  }, [opsVersion])
  function toggleOpen() {
    const next = !open
    setOpen(next)
    try { localStorage.setItem(NS_LOGS_OPEN, next ? '1' : '0') } catch { /* storage unavailable */ }
  }
  if (ops === null) return null
  const lines = ops.slice(-30)
  return h('div', { className: 'duc-card' },
    h('button', { type: 'button', className: 'duc-collapse-head', onClick: toggleOpen, 'aria-expanded': open },
      h('span', { className: 'duc-collapse-icon', 'aria-hidden': 'true' },
        h(Chevron, { open })),
      h('span', { className: 'duc-collapse-title' }, t('logs'))),
    open && (lines.length === 0
      ? h('div', { className: 'duc-note' }, t('empty'))
      : h('div', { className: 'duc-log' },
        lines.map((op, i) => `${fmtClock(op.at)} [${op.level}] ${op.event} ${op.detail}`).join('\n'))))
}

// ---------------------------------------------------------------------------
// Seat 1: the Settings section (full page).
// ---------------------------------------------------------------------------

/** The badge visibility preference row for the settings page. */
function BadgePrefRow({ t }) {
  const ui = useUi()
  return h('label', { className: 'duc-pref' },
    h('input', {
      type: 'checkbox',
      checked: ui.hideBadge === true,
      onChange: (e) => setHideBadge(e.target.checked),
    }),
    h('span', { className: 'duc-pref-body' },
      h('span', { style: { fontWeight: 500 } }, t('hideBadge')),
      h('span', { className: 'duc-note' }, t('hideBadgeDesc'))))
}

/** The click-to-auto-update preference row for the settings page. */
function AutoUpdatePrefRow({ t }) {
  const ui = useUi()
  return h('label', { className: 'duc-pref' },
    h('input', {
      type: 'checkbox',
      checked: ui.autoUpdate === true,
      onChange: (e) => setAutoUpdate(e.target.checked),
    }),
    h('span', { className: 'duc-pref-body' },
      h('span', { style: { fontWeight: 500 } }, t('autoUpdate')),
      h('span', { className: 'duc-note' }, t('autoUpdateDesc'))))
}

/** The opt-in 30-minute periodic refresh preference row. */
function PeriodicRefreshPrefRow({ t }) {
  const ui = useUi()
  return h('label', { className: 'duc-pref' },
    h('input', {
      type: 'checkbox',
      checked: ui.periodicRefresh === true,
      onChange: (e) => setPeriodicRefresh(e.target.checked),
    }),
    h('span', { className: 'duc-pref-body' },
      h('span', { style: { fontWeight: 500 } }, t('periodicRefresh')),
      h('span', { className: 'duc-note' }, t('periodicRefreshDesc'))))
}

function CopilotSection({ t }) {
  const { status, error, busy, load, needRestart, opsVersion, notifyUpdated } = useCopilotData(true)
  const { bulk, bulkResult, runAll } = useBulkUpdate()
  const live = useLive()
  const liveRunning = liveRunningOf(live)
  useLiveCompletionRefresh(load)
  const { bundle, bundleResult, runBundle } = useBundleUpdate()
  const ui = useUi()

  useEffect(() => { injectStyles() }, [])

  async function onRunAll(plugins) {
    await runAll(plugins, notifyUpdated)
  }

  async function onRunBundle(parent, mountedChildren) {
    await runBundle(parent, mountedChildren, notifyUpdated)
  }

  return h('div', { className: 'duc' },
    h('div', { className: 'duc-head' },
      h('h2', null, t('nav')),
      h('span', { className: 'duc-sub' }, t('subtitle')),
      status !== null ? h('span', { className: 'duc-meta' },
        `${t('lastScan')}: ${fmtClock(status.generatedAt)}`,
        h('button', { className: 'duc-btn', onClick: () => load(true), disabled: busy || ui.operation !== null },
          busy ? t('rescanning') : t('refresh'))) : null,
      status !== null ? h(UpdateAllButton, { t, plugins: status.plugins, bulk, runAll: onRunAll, liveRunning, blocked: bundle.running || busy || ui.operation !== null }) : null),
    h(LiveBanner, { t }),
    bulkResult !== null && !bulk.running ? h('div', { className: `duc-note ${bulkResult.failed > 0 ? 'duc-error' : ''}` },
      `${t('updatedAll')}${bulkResult.failed > 0 ? ` ${t('bulkFailed', { n: bulkResult.failed })}` : ''}`) : null,
    bundle.running ? h('div', { className: 'duc-bulk-progress', title: t('updatingBundle', bundle) }, t('updatingBundle', bundle)) : null,
    bundleResult !== null && !bundle.running ? h(BundleUpdateResult, { t, result: bundleResult }) : null,
    error !== null ? h('div', { className: 'duc-error' }, `${t('loadFail')}: ${error} `,
      h('button', { className: 'duc-btn', onClick: () => load(false) }, t('retry'))) : null,
    needRestart ? h('div', { className: 'duc-banner' }, `ℹ️ ${t('restartHint')}`) : null,
    status === null && error === null ? h('div', { className: 'duc-note' }, t('loading')) : null,
    h('div', { className: 'duc-card', style: { padding: '10px 12px' } },
      h(BadgePrefRow, { t }),
      h(AutoUpdatePrefRow, { t }),
      h(PeriodicRefreshPrefRow, { t })),
    status !== null ? h(CoreCard, { t, core: status.core }) : null,
    status !== null && status.plugins.length > 0
      ? h('div', { className: 'duc-profiles-hint' }, t('profilesHint'))
      : null,
    status !== null
      ? h(PluginListCard, {
          t, plugins: status.plugins, categories: status.categories, onUpdated: notifyUpdated,
          bulkRunning: bulk.running, bundleRunning: bundle.running, refreshing: busy || ui.operation !== null, onRunBundle,
        })
      : null,
    h(LogTail, { t, opsVersion }))
}

// ---------------------------------------------------------------------------
// Seat 2: the sidebar foot trigger with the lazy badge.
// ---------------------------------------------------------------------------

function FooterButton({ t, wide }) {
  const ui = useUi()
  const live = useLive()
  useEffect(() => { injectStyles() }, [])
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      loadBadgeStatus().catch(() => {})
    }
    refresh()
    // The host starts its forced background scan during boot. A second bounded
    // read picks up its cache result without turning the launcher into a poller.
    const retry = setTimeout(() => { if (!cancelled) refresh() }, 1500)
    return () => {
      cancelled = true
      clearTimeout(retry)
    }
  }, [])
  // Opt-in periodic refresh (Settings → Update Copilot): while enabled, one
  // interval per page forces a scan every 30 minutes — this seat re-hydrates
  // the badge, and the refreshTick tells open radar seats to reload too.
  useEffect(() => {
    if (ui.periodicRefresh !== true) return undefined
    const id = setInterval(() => {
      loadBadgeStatus(true).catch(() => {})
      setUi({ refreshTick: uiState.refreshTick + 1 })
    }, PERIODIC_REFRESH_MS)
    return () => clearInterval(id)
  }, [ui.periodicRefresh])
  const behind = ui.summary !== null
    ? (ui.summary.behindPlugins ?? 0) + (ui.summary.behindCore ?? 0)
    : 0
  const liveRunning = liveRunningOf(live)
  const liveName = liveRunning && live.current !== null && live.current !== undefined
    ? live.current.name
    : null
  const showBadge = behind > 0 && ui.hideBadge !== true

  return h('button', {
    className: wide === true ? 'duc-foot-btn' : 'duc-foot-btn duc-rail',
    title: liveRunning
      ? t('liveUpdating', { name: liveName ?? '…' })
      : showBadge ? t('badgeTitle', { n: behind }) : t('nav'),
    'aria-label': liveRunning ? t('liveUpdating', { name: liveName ?? '…' }) : t('nav'),
    'aria-haspopup': 'dialog',
    onClick: (e) => setUi({
      open: true,
      opener: e.currentTarget,
      // Auto-update option: this one click also means "update all" — the
      // popup consumes the flag once its first scan arrives.
      ...(ui.autoUpdate === true ? { autoRunAll: true } : {}),
    }),
  },
    h('span', { className: 'duc-foot-icon' }, RadarIcon()),
    wide === true ? h('span', { className: 'duc-foot-label' }, t('nav')) : null,
    liveRunning
      // Pulsing dot: an update is executing right now, whoever started it
      // (auto-run, agent tools, another tab) — the count returns afterwards.
      ? h('span', { className: 'duc-foot-badge live' })
      : showBadge
        ? h('span', { className: 'duc-foot-badge' }, String(behind))
        : null)
}

// ---------------------------------------------------------------------------
// Seat 3: the popup modal in the shell overlay layer.
// ---------------------------------------------------------------------------

/**
 * The popup radar body. When `autoRun` is armed (the sidebar trigger sets it
 * while the auto-update preference is on), the first loaded scan starts
 * "update all" over every outdated auto-updatable package — the same path as
 * the toolbar button, progress visible in this very popup.
 */
function PopupBody({ t, autoRun = false }) {
  const { status, error, busy, load, needRestart, notifyUpdated } = useCopilotData(true)
  const { bulk, bulkResult, runAll } = useBulkUpdate()
  const live = useLive()
  const liveRunning = liveRunningOf(live)
  useLiveCompletionRefresh(load)
  // One click arms one run: the ref keeps StrictMode re-runs and re-clicks
  // mid-run from starting a second bulk pass.
  const autoRanRef = useRef(false)

  useEffect(() => {
    if (!autoRun || status === null || autoRanRef.current) return
    setUi({ autoRunAll: false }) // consume immediately — one click, one run
    autoRanRef.current = true
    if (autoTargetsOf(status.plugins).length > 0 && !bulk.running) onRunAll(status.plugins)
    // Intentionally not depending on onRunAll/bulk: only the arming flag and
    // the scan arrival may start the pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, status])
  const { bundle, bundleResult, runBundle } = useBundleUpdate()
  const ui = useUi()

  async function onRunAll(plugins) {
    await runAll(plugins, notifyUpdated)
  }

  async function onRunBundle(parent, mountedChildren) {
    await runBundle(parent, mountedChildren, notifyUpdated)
  }

  return h('div', { className: 'duc' },
    h('div', { className: 'duc-toolbar' },
      status !== null
        ? h(React.Fragment, null,
            `${t('lastScan')}: ${fmtClock(status.generatedAt)}`,
            h('button', { className: 'duc-btn', onClick: () => load(true), disabled: busy || ui.operation !== null },
              busy ? t('rescanning') : t('refresh')))
        : null,
      status !== null ? h(UpdateAllButton, { t, plugins: status.plugins, bulk, runAll: onRunAll, liveRunning, blocked: bundle.running || busy || ui.operation !== null }) : null),
    h(LiveBanner, { t }),
    bulkResult !== null && !bulk.running ? h('div', { className: `duc-note ${bulkResult.failed > 0 ? 'duc-error' : ''}` },
      `${t('updatedAll')}${bulkResult.failed > 0 ? ` ${t('bulkFailed', { n: bulkResult.failed })}` : ''}`) : null,
    bundle.running ? h('div', { className: 'duc-bulk-progress', title: t('updatingBundle', bundle) }, t('updatingBundle', bundle)) : null,
    bundleResult !== null && !bundle.running ? h(BundleUpdateResult, { t, result: bundleResult }) : null,
    needRestart ? h('div', { className: 'duc-banner' }, `ℹ️ ${t('restartHint')}`) : null,
    error !== null ? h('div', { className: 'duc-error' }, `${t('loadFail')}: ${error}`) : null,
    status === null && error === null ? h('div', { className: 'duc-note' }, t('loading')) : null,
    status !== null ? h(CoreCard, { t, core: status.core }) : null,
    status !== null
      ? h(PluginListCard, {
          t, plugins: status.plugins, categories: status.categories, onUpdated: notifyUpdated,
          bulkRunning: bulk.running, bundleRunning: bundle.running, refreshing: busy || ui.operation !== null, onRunBundle,
        })
      : null)
}

function trapModalFocus(modal, event, activeElement = document.activeElement) {
  if (modal === null) return false
  const focusable = [...modal.querySelectorAll(
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
  )]
  if (focusable.length === 0) {
    event.preventDefault()
    modal.focus()
    return true
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && (activeElement === modal || activeElement === first)) {
    event.preventDefault()
    last.focus()
    return true
  }
  if (!event.shiftKey && activeElement === last) {
    event.preventDefault()
    first.focus()
    return true
  }
  return false
}

function CopilotOverlay({ t }) {
  const ui = useUi()
  const modalRef = useRef(null)

  useEffect(() => {
    if (!ui.open) return undefined
    injectStyles()
    modalRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') setUi({ open: false })
      else if (e.key === 'Tab') trapModalFocus(modalRef.current, e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ui.open])

  useEffect(() => {
    if (ui.open || ui.opener == null) return
    ui.opener.focus?.()
    setUi({ opener: null })
  }, [ui.open, ui.opener])

  if (!ui.open) return null

  return h('div', { className: 'duc-backdrop', onClick: () => setUi({ open: false }) },
    h('div', {
      className: 'duc-modal',
      ref: modalRef,
      tabIndex: -1,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': t('nav'),
      onClick: (e) => e.stopPropagation(),
    },
      h('div', { className: 'duc-modal-head' },
        h('div', null,
          h('h2', null, t('nav')),
          h('div', { className: 'duc-sub' }, t('subtitle'))),
        h('button', { className: 'duc-modal-x', onClick: () => setUi({ open: false }), 'aria-label': t('close') }, '✕')),
      h('div', { className: 'duc-modal-body' }, h(PopupBody, { t, autoRun: ui.autoRunAll === true }))))
}

exports.name = 'dsh-update-copilot'
// Test seam (see test/sse-client.test.mjs, test/auto-update.test.mjs);
// namespaced so the descriptor's public shape stays exactly { name, inject,
// apply }.
exports.__test = {
  consumeUpdateResponse,
  autoTargetsOf,
  loadBadgeStatus,
  getUiState: () => uiState,
  acquireMutation,
  releaseMutation,
  withMutationLock,
  partitionPluginGroups,
  groupMountedRows,
  rowActionsDisabled,
  rowUpdateTarget,
  scopedRowUpdateTarget,
  bundleUpdateTargets,
  globalUpdateTargets,
  mountedUpdateCount,
  shouldShowBundleUpdate,
  mountRelationshipInfo,
  trapModalFocus,
}
// 'slots' and 'locale' are safe to require: ui-layout (mandatory in every web
// composition) already hard-depends on them.
exports.inject = ['slots', 'locale']
exports.apply = function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-update-copilot: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'update-copilot',
    order: 41,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ t }),
  }, () => h(CopilotSection, { t })))

  // Beside Settings at the sidebar foot; the shell hands each occupant { wide }.
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'update-copilot-trigger',
    order: 10,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ t }),
  }, (props) => h(FooterButton, { t, wide: props?.wide === true })))

  // The popup: one frame-wide floating layer occupant that renders null closed.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'update-copilot-popup',
    order: 50,
    label: () => 'dsh-update-copilot',
  }, () => h(CopilotOverlay, { t })))

  // Settings nav: swap our row's fallback gear for the radar mark.
  ctx.effect(() => mountSettingsNavIconPatch(), 'dsh-update-copilot: settings nav icon patch')

  // Visual-test hooks: `?duc=1` auto-opens the popup once (also arms the
  // badge); `?duc=badge` arms the badge only — no popup, no backdrop, so a
  // screenshot can judge the badge/text alignment on the sidebar itself
  // (`&hide=1` arms it with the badge suppressed); `?duc=settings` clicks the
  // shipped settings trigger once the sidebar is up and then selects our nav
  // row, so the section page (pref row included) is screenshot-visible.
  // Appending `&brief=1` to `?duc=1` or `?duc=settings` starts every behind
  // row with its update highlights expanded, so highlight-panel changes are
  // screenshot-visible too.
  ctx.effect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const mode = params.get('duc')
      if (params.get('brief') === '1') autoBrief = true
      if (mode === '1') {
        setUi({ open: true })
      } else if (mode === 'badge') {
        if (params.get('hide') === '1') setUi({ hideBadge: true })
        loadBadgeStatus().catch(() => {})
      } else if (mode === 'settings') {
        let tries = 0
        let selectedUs = false
        const timer = setInterval(() => {
          tries += 1
          if (!selectedUs) {
            const trigger = document.querySelector('button[aria-haspopup="dialog"]:not(.duc-foot-btn)')
            if (trigger !== null) {
              trigger.click()
              selectedUs = true
            }
          } else {
            const navBtns = document.querySelectorAll('div[role="dialog"][aria-modal="true"]:not(.duc-modal) nav button')
            let ours = null
            for (const btn of navBtns) {
              if (NAV_LABELS.includes((btn.textContent ?? '').trim())) { ours = btn; break }
            }
            if (ours !== null) {
              ours.click()
              clearInterval(timer)
            }
          }
          if (tries > 40) clearInterval(timer)
        }, 250)
        return () => clearInterval(timer)
      }
    } catch { /* no window.location — ignore */ }
    return () => {}
  }, 'dsh-update-copilot: popup deep-link')
}

return module.exports; } });
