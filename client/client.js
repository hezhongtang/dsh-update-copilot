window.__ModuleLoader__.load({ id: "dsh-update-copilot", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-update-copilot client.
 *
 * Two seats:
 *  - sidebar.footer.action: a trigger beside the Settings button. Its badge
 *    hydrates once after mount and once more after startup scan completion — no
 *    ongoing background polling.
 *  - shell.overlay: a modal popup carrying the whole update radar — the core
 *    card (collapsed by default), every profile's plugins merged
 *    package-centrically with ownership disclosure, and one-click / bulk
 *    updates. Opened via the sidebar button.
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
  subtitle: 'DeepSeek Harness 本体与全部插件的版本雷达（跨 profile 合并）',
  refresh: '刷新',
  rescanning: '扫描中…',
  lastScan: '上次扫描',
  loading: '加载中…',
  loadFail: '加载失败，请重试',
  retry: '重试',
  close: '关闭',
  coreTitle: 'DeepSeek Harness 本体',
  corePolicy: '全局 npm 安装的本体更新可在此代执行（带兼容闸门，完成后需重启 dsh）；npx 等其余安装形态仅提供命令。',
  coreCurrent: '已是最新',
  coreBehind: '有新版本',
  copyCmd: '复制升级命令',
  copied: '已复制',
  coreSameVersion: '相同',
  coreDowngradeWarn: '注意：目标版本 {v} 比当前安装的 {cur} 更旧 —— 这是一条降级路径，确认后才会执行。',
  coreUpdate: '更新本体',
  coreConfirm: '确认执行？',
  coreConfirmDown: '确认降级？',
  coreUpdating: '本体更新中…',
  coreNoExec: '当前安装形态（{method}）不可代执行，请手动运行命令',
  coreNotWritable: 'npm 全局前缀不可写（可能需要 sudo），请手动运行命令',
  coreExecBlocked: '本体更新被闸门拦下',
  coreUpdated: '✓ 本体已更新至 {v}',
  coreRestartHint: '当前进程仍运行旧版 {cur} —— 重启 dsh（如 dsh web）后新版本才生效。',
  coreRollbackCmd: '回滚命令（重装 {v}）',
  pluginsTitle: '插件（跨 profile 合并）',
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
  update: '更新',
  queued: '待更新',
  queuedHint: '更新正在进行，此项排队等待；当前项完成后自动开始',
  updateAll: '一键更新全部',
  updatingAll: '正在更新 {i}/{n}：{name}',
  updatedAll: '✓ 全部更新完成',
  bulkFailed: '{n} 项更新失败',
  itemUpdated: '{p}：已更新',
  itemCurrent: '{p}：已是最新',
  itemFailed: '{p}：失败',
  itemSkipped: '{p}：跳过',
  confirmUpdate: '确认更新？',
  updating: '更新中…',
  updated: '✓ 已更新',
  updateNoChange: '未检测到变化',
  updateFail: '更新失败',
  restartHint: '插件更新完成后需重启 dsh（如 dsh web）生效',
  officialNote: '官方包随 dsh 本体更新',
  logs: '操作日志',
  logsCollapse: '收起日志',
  empty: '还没有任何记录',
  scanSummary: '{p} 个插件 · {b} 个可更新',
  updatesAvailableSection: '可更新',
  upToDateSection: '已最新',
  upToDateFold: '{n} 项已最新',
  badgeTitle: '{n} 项更新可用',
  quickUpdate: '一键更新',
  quickUpdateTitle: '点击立即更新全部可更新插件',
  quickUpdatingTitle: '正在更新：{name}（{i}/{n}）',
  quickDone: '✓ 已更新',
  quickFailed: '✗ {n} 失败',
  quickNone: '已是最新',
  autoUpdate: '点击按钮时自动更新',
  autoUpdateDesc: '开启后，点击侧栏「更新助手」按钮时若发现有落后的插件，立即自动开始「一键更新全部」；dsh 本体不会自动更新（仅可通过本体卡片手动确认执行）',
  progressPhase: '{phase}…',
  progress_start: '开始更新',
  progress_waiting: '等待服务端完成…（旧版服务端，无实时进度）',
  progress_resolving: '解析依赖',
  progress_downloading: '下载中',
  progress_linking: '链接依赖',
  progress_done: '即将完成',
  progress_retry: '重试中',
  progressBytes: '{done} / {total}',
  progressPackages: '{done}/{total} 个包',
  progressResolved: '已解析 {done} 个包',
  progressSpeedBytes: '{speed}/s',
  progressSpeedPackages: '{n} 个/秒',
  progressEta: '剩余 {eta}',
  etaSeconds: '{n} 秒',
  etaMinutes: '{m} 分 {s} 秒',
  etaSoon: '不到 1 秒',
  errUpdateRunning: '已有更新在进行中，请稍候',
  errLinked: '本地链接（link:/file:）不由助手管理，请在它自身的仓库里更新（git pull）',
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
  liveUpdating: '正在更新：{name}',
  liveUpdatingProfile: '正在更新：{name}（{profile}）',
  liveBusy: '有更新正在进行，请稍候',
  compatChip: '{n} 个插件可能不兼容',
  compatBadge: '可能不兼容',
  compatTargetBadge: '升级后可能不兼容',
  compatCurrent: '当前 DSH {v} 已缺这些导出，下次启动可能整棵插件树挂掉',
  compatTarget: '升到 DSH {v} 后，这些插件可能无法加载',
  compatMissing: '{file} 从 {pkg} 导入 {names}，host 未导出',
  compatDisable: '临时禁用（追加到该 profile 的 cordis.patch.yml）',
  compatRemove: '或卸载',
  compatHostMissing: 'host 包未找到',
  availBroken: '损坏',
  availMissing: '缺失',
  availDisabled: '已停用',
  availBanner: '可用性：{broken} 个损坏、{missing} 个缺失（{names}）',
  availUnreachable: '无法检查上游：{sources}（点刷新重试）',
  cannotCheck: '无法检查',
  updateRisks: '本次更新新造成的损坏',
  updateRiskHint: '建议：追加停用补丁，或卸载',
  riskCollateral: '连带损坏（非本次更新目标，可能被共享依赖重写波及）',
  rollbackTo: '回滚到 {target}',
  rollbackConfirm: '确认回滚？',
  errPreflightBlocked: '已拦截：目标 dsh 不再导出该插件 import 的名字，强行更新可能让整个 profile 起不来',
  forceUpdate: '强制更新',
  confirmForce: '确认强制更新？',
  forceHint: '更新已被预检拦截；证据见下（可复制的停用补丁 / 卸载命令）',
  updateWarnings: '更新预检预警',
  patchAuditTitle: '补丁名体检：{n} 条 cordis.patch.yml 条目钉住的包名已不存在，被装载器整条静默跳过（配置一并失效）',
  patchAuditLine: '{profile} · {id} → {name}',
  patchAuditFix: '修复：把该条目的 name 改为当前包名，或删除 name 行改为按 id 匹配（两种方式都已验证有效）',
  patchAuditVerify: '验证命令（无输出即已修复）：',
}

const en = {
  nav: 'Update Copilot',
  subtitle: 'Version radar for the DeepSeek Harness core and plugins (merged across profiles)',
  refresh: 'Refresh',
  rescanning: 'Scanning…',
  lastScan: 'Last scan',
  loading: 'Loading…',
  loadFail: 'Failed to load, please retry',
  retry: 'Retry',
  close: 'Close',
  coreTitle: 'DeepSeek Harness core',
  corePolicy: 'Core updates run here for writable global npm installs (gated; a dsh restart is required afterwards) — other install shapes get the command only.',
  coreCurrent: 'Up to date',
  coreBehind: 'New version',
  copyCmd: 'Copy upgrade command',
  copied: 'Copied',
  coreSameVersion: 'same',
  coreDowngradeWarn: 'Careful: the target {v} is OLDER than the installed {cur} — this is a downgrade path and runs only after confirmation.',
  coreUpdate: 'Update core',
  coreConfirm: 'Run it?',
  coreConfirmDown: 'Confirm downgrade?',
  coreUpdating: 'Updating core…',
  coreNoExec: 'This install shape ({method}) cannot be auto-updated — run the command manually',
  coreNotWritable: 'The npm global prefix is not writable (may need sudo) — run the command manually',
  coreExecBlocked: 'Core update blocked by the gate',
  coreUpdated: '✓ Core updated to {v}',
  coreRestartHint: 'This process still runs the old {cur} — restart dsh (e.g. dsh web) for the new version to take effect.',
  coreRollbackCmd: 'Rollback command (reinstall {v})',
  pluginsTitle: 'Plugins (merged across profiles)',
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
  update: 'Update',
  queued: 'Queued',
  queuedHint: 'An update is running — this item is queued and starts automatically when it finishes',
  updateAll: 'Update all',
  updatingAll: 'Updating {i}/{n}: {name}',
  updatedAll: '✓ All updates finished',
  bulkFailed: '{n} update(s) failed',
  itemUpdated: '{p}: updated',
  itemCurrent: '{p}: already current',
  itemFailed: '{p}: failed',
  itemSkipped: '{p}: skipped',
  confirmUpdate: 'Confirm update?',
  updating: 'Updating…',
  updated: '✓ Updated',
  updateNoChange: 'No change detected',
  updateFail: 'Update failed',
  restartHint: 'Restart dsh (e.g. dsh web) after plugin updates to apply them',
  officialNote: 'Official packages follow the dsh core',
  logs: 'Operation log',
  logsCollapse: 'Collapse log',
  empty: 'Nothing recorded yet',
  scanSummary: '{p} plugin(s) · {b} update(s) available',
  updatesAvailableSection: 'Updates available',
  upToDateSection: 'Up to date',
  upToDateFold: '{n} up to date',
  badgeTitle: '{n} update(s) available',
  quickUpdate: 'Update all',
  quickUpdateTitle: 'Click to update every outdated plugin',
  quickUpdatingTitle: 'Updating: {name} ({i}/{n})',
  quickDone: '✓ Updated',
  quickFailed: '✗ {n} failed',
  quickNone: 'Up to date',
  autoUpdate: 'Auto-update on button click',
  autoUpdateDesc: 'When on, clicking the sidebar Update Copilot button immediately starts "Update all" if outdated plugins are found; the dsh core is never auto-updated (it updates only through an explicit confirm on its own card)',
  progressPhase: '{phase}…',
  progress_start: 'Starting update',
  progress_waiting: 'Waiting for the server… (older server, no live progress)',
  progress_resolving: 'Resolving dependencies',
  progress_downloading: 'Downloading',
  progress_linking: 'Linking dependencies',
  progress_done: 'Finishing up',
  progress_retry: 'Retrying',
  progressBytes: '{done} / {total}',
  progressPackages: '{done}/{total} packages',
  progressResolved: '{done} packages resolved',
  progressSpeedBytes: '{speed}/s',
  progressSpeedPackages: '{n} packages/s',
  progressEta: '{eta} left',
  etaSeconds: '{n}s',
  etaMinutes: '{m}m {s}s',
  etaSoon: 'less than 1s',
  errUpdateRunning: 'Another update is already running — try again shortly',
  errLinked: 'Local link:/file: installs are not managed — update them inside their own checkout (git pull there)',
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
  liveUpdating: 'Updating: {name}',
  liveUpdatingProfile: 'Updating: {name} ({profile})',
  liveBusy: 'An update is running — please wait',
  compatChip: '{n} plugin(s) may not load',
  compatBadge: 'may not load',
  compatTargetBadge: 'may break after upgrade',
  compatCurrent: 'Current DSH {v} no longer exports names these plugins import; the next boot may fail the whole plugin tree',
  compatTarget: 'After upgrading to DSH {v}, these plugins may fail to load',
  compatMissing: '{file} imports {names} from {pkg}, which the host does not export',
  compatDisable: 'Temporarily disable (append to that profile\'s cordis.patch.yml)',
  compatRemove: 'or uninstall',
  compatHostMissing: 'host package not found',
  availBroken: 'broken',
  availMissing: 'missing',
  availDisabled: 'disabled',
  availBanner: 'Availability: {broken} broken, {missing} missing ({names})',
  availUnreachable: 'Cannot check upstream: {sources} (refresh to retry)',
  cannotCheck: 'cannot check',
  updateRisks: 'Newly introduced by this update',
  updateRiskHint: 'Suggested: append a disable patch, or uninstall',
  riskCollateral: 'collateral (not the update target — likely hit by shared-dependency rewriting)',
  rollbackTo: 'Roll back to {target}',
  rollbackConfirm: 'Confirm rollback?',
  errPreflightBlocked: 'Blocked: the target dsh no longer exports names this plugin imports — forcing can brick the whole profile at boot',
  forceUpdate: 'Force update',
  confirmForce: 'Confirm force update?',
  forceHint: 'The update was blocked by preflight; evidence below (copyable disable patch / uninstall command)',
  updateWarnings: 'Pre-flight warnings',
  patchAuditTitle: 'Patch-name check: {n} cordis.patch.yml entr(ies) pin package names that no longer exist — the loader silently skips them (config included)',
  patchAuditLine: '{profile} · {id} → {name}',
  patchAuditFix: 'Fix: change the entry\'s name to the current package name, or delete the name line so it matches by id (both verified to work)',
  patchAuditVerify: 'Verify (no output means fixed):',
}

const DUC_STYLES_ID = 'duc-styles'
const DUC_STYLES_PLUGIN = 'dsh-update-copilot'

function injectStyles() {
  if (typeof document === 'undefined' || document.head === null) return
  const css = [
    '.duc{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.5}',
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
    // update progress bar + status line under the row. Crisp by design: a
    // solid accent fill on a solid track (no translucent gradient washing
    // out over light or dark surfaces), 8px tall with 0.25s easing, and a
    // striped sliding fill for the indeterminate phases (resolution, and
    // any seat on an older server that streams no numbers).
    '.duc-progress-wrap{display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px;padding:4px 0 6px;font-size:12px}',
    '.duc-progress{flex:1 1 160px;height:8px;min-width:120px;border-radius:4px;background:rgba(127,127,127,.28);overflow:hidden}',
    '.duc-progress-fill{height:100%;border-radius:4px;background:#508cff;transition:width .25s ease}',
    '.duc-progress-fill.duc-indet{width:40%!important;background:repeating-linear-gradient(45deg,#508cff 0 8px,#7ab8ff 8px 16px);animation:duc-stripe 1s linear infinite}',
    '@keyframes duc-stripe{from{background-position:0 0}to{background-position:32px 0}}',
    '.duc-progress-label{flex:none;font-variant-numeric:tabular-nums;min-width:38px;text-align:right;opacity:.85}',
    '.duc-progress-detail{flex:1 1 100%;min-width:0;font-size:11px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.duc-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:2px}',
    '.duc-list a{color:inherit}',
    '.duc a{color:inherit}',
    '.duc-repolink{color:inherit;text-decoration:none;opacity:.55;font-size:12px;line-height:1;flex:none}',
    '.duc-repolink:hover{opacity:1;text-decoration:underline}',
    '.duc-chip.duc-repolink{text-decoration:none;opacity:.85}',
    '.duc-chip.duc-repolink:hover{opacity:1;border-color:rgba(127,127,127,.9)}',
    '.duc-cmd{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;border:1px dashed rgba(127,127,127,.4);border-radius:6px;padding:6px 8px;word-break:break-all}',
    '.duc-banner{border:1px solid rgba(80,140,255,.45);background:rgba(80,140,255,.08);border-radius:8px;padding:8px 12px;font-size:12.5px}',
    '.duc-banner.warn{border-color:rgba(220,80,80,.45);background:rgba(220,80,80,.08)}',
    '.duc-compat{display:flex;flex-direction:column;gap:6px;padding:6px 0 2px}',
    '.duc-compat .duc-cmd{margin-top:4px}',
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
    // Quick-update seat: the trigger occupies ONE slot entry and wraps both
    // buttons itself. The shell flexes slot entries in one row (no gap), and
    // the official cordis entry is width:100%/flex:none — a second entry would
    // be pushed out of the container entirely, so two entries is not an option
    // here; the cordis rail pattern (internal column + 2px gap) is mirrored
    // instead.
    '.duc-foot-row{display:flex;align-items:center;gap:4px;width:calc(100% + 8px);margin:4px -4px;box-sizing:border-box}',
    '.duc-foot-row .duc-foot-btn{width:auto;flex:1;min-width:0;margin:0}',
    '.duc-foot-stack{display:flex;flex-direction:column;align-items:center;gap:2px}',
    '.duc-foot-stack .duc-foot-btn{margin:0}',
    // Secondary text-button: hover fill only, matching the cordis trigger
    // language (borderless + interactive hover), distinct from the primary
    // trigger's label-primary color.
    '.duc-foot-quick{flex:none;display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;height:34px;padding:6px 10px;border-radius:12px;border:none;background:0 0;color:var(--dsw-alias-label-secondary,#6b7280);font-family:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer;overflow:hidden}',
    '.duc-foot-quick:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}',
    '.duc-foot-quick:focus-visible{outline:1px solid var(--dsw-alias-border-l2,#888);outline-offset:-1px}',
    '.duc-foot-quick:disabled{opacity:.5;cursor:default}',
    '.duc-foot-quick .duc-quick-icon{display:inline-flex;flex:none;align-items:center}',
    // Busy pulse reuses the live-badge keyframes: the bolt never spins (a
    // directional glyph rotating reads like a clock hand), the DSH "in
    // progress" language is the breathing pulse — same 1.1s ease as the badge
    // dot and the live banner.
    '.duc-foot-quick.busy .duc-quick-icon{animation:duc-live-pulse 1.1s ease-in-out infinite}',
    '.duc-foot-quick.done{color:var(--dsw-alias-state-success-primary,#2e9e5b)}',
    '.duc-foot-quick.failed{color:var(--dsw-alias-state-error-primary,#d25050)}',
    '.duc-foot-quick.none{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.55))}',
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
async function streamUpdate(name, onEvent, profile = undefined, profiles = undefined, target = undefined, force = undefined) {
  const res = await fetch('/dsh-update-copilot/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      confirm: true,
      ...(profile !== undefined && profile !== '' ? { profile } : {}),
      ...(Array.isArray(profiles) ? { profiles } : {}),
      ...(target !== undefined && target !== '' ? { target } : {}),
      // Only a literal true forces past the preflight gate; the server applies
      // the same rule (lib/routes.js). A stray truthy value (a click event, a
      // string) must neither reach the wire nor crash the body serialization.
      ...(force === true ? { force: true } : {}),
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

/**
 * POST the DSH core update and resolve the outcome. Same SSE contract as
 * plugin updates; `force` rides only as a literal true (downgrades and gate
 * overrides need it — both server-checked).
 */
async function streamCoreUpdate(body, onEvent) {
  const res = await fetch('/dsh-update-copilot/update-core', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true, ...body }),
    cache: 'no-store',
  })
  return consumeUpdateResponse(res, onEvent)
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

// ---------------------------------------------------------------------------
// Shared cross-seat UI state: popup open flag + the badge summary.
// useSyncExternalStore contract: immutable snapshots, notify on replace.
// ---------------------------------------------------------------------------

/**
 * Auto-update preference, per-browser localStorage. Off by default: updates
 * still start only after an explicit click, the option just makes that one
 * click on the sidebar trigger also mean "run Update all".
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

let uiState = { open: false, opener: null, summary: null, generatedAt: null, autoUpdate: readAutoUpdatePref(), autoRunAll: false, operation: null }
const uiSubs = new Set()

function setUi(patch) {
  uiState = { ...uiState, ...patch }
  for (const notify of uiSubs) notify()
}

/** Toggle the click-to-auto-update option; persists per browser. */
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

function compatSummary(compat) {
  if (compat === null || typeof compat !== 'object') return null
  const current = Array.isArray(compat.current?.findings) ? compat.current.findings.length : 0
  const target = Array.isArray(compat.target?.findings) ? compat.target.findings.length : 0
  if (current === 0 && target === 0) return null
  const names = new Set()
  for (const finding of compat.current?.findings ?? []) names.add(finding.plugin)
  for (const finding of compat.target?.findings ?? []) names.add(finding.plugin)
  return { current, target, plugins: [...names].sort() }
}

function pluginHasCompat(row) {
  return row !== null && typeof row === 'object' && Array.isArray(row.compat)
    && row.compat.some((finding) => finding !== null && finding.against === 'current')
}

function pluginHasTargetCompat(row) {
  return row !== null && typeof row === 'object' && Array.isArray(row.compat)
    && row.compat.some((finding) => finding !== null && finding.against === 'target')
}

/** Rollback suggestion carried by the last update outcome, if any. */
function rollbackOfResult(result) {
  const rollback = result !== null && typeof result === 'object' ? result.rollback : null
  return rollback !== null && typeof rollback === 'object' && (typeof rollback.target === 'string' || typeof rollback.command === 'string')
    ? rollback
    : null
}

/** Pre-flight warnings from one update outcome (own or per-profile items). */
function updateWarnings(result) {
  if (result === null || typeof result !== 'object') return []
  if (Array.isArray(result.warnings) && result.warnings.length > 0) return result.warnings
  if (Array.isArray(result.items)) {
    return result.items.flatMap((item) => (Array.isArray(item.warnings) ? item.warnings : []))
  }
  return []
}

const AVAIL_RANK = { broken: 0, missing: 1, disabled: 2, inert: 3, ok: 4 }

function worstAvailabilityState(states) {
  let worst = 'ok'
  let rank = AVAIL_RANK.ok
  for (const state of states ?? []) {
    const next = AVAIL_RANK[state]
    if (typeof next === 'number' && next < rank) {
      worst = state
      rank = next
    }
  }
  return worst
}

function rowAvailabilityState(row) {
  if (row !== null && typeof row === 'object' && typeof row.availability?.state === 'string') {
    return row.availability.state
  }
  const states = Array.isArray(row?.profiles)
    ? row.profiles.map((p) => p?.availability?.state).filter((state) => typeof state === 'string')
    : []
  return worstAvailabilityState(states)
}

function availabilityBadge(state) {
  if (state === 'broken') return { className: 'high', key: 'availBroken' }
  if (state === 'missing') return { className: 'high', key: 'availMissing' }
  if (state === 'disabled') return { className: 'unknown', key: 'availDisabled' }
  return null
}

function availabilityBanner(summary, plugins) {
  if (summary === null || typeof summary !== 'object') return null
  const broken = typeof summary.broken === 'number' ? summary.broken : 0
  const missing = typeof summary.missing === 'number' ? summary.missing : 0
  if (broken + missing === 0) return null
  const names = [...new Set((Array.isArray(plugins) ? plugins : [])
    .filter((p) => {
      const state = rowAvailabilityState(p)
      return state === 'broken' || state === 'missing'
    })
    .map((p) => p.name)
    .filter((name) => typeof name === 'string' && name !== ''))].sort()
  return { broken, missing, names }
}

function unreachableBanner(summary) {
  if (summary === null || typeof summary !== 'object') return null
  const unreachable = typeof summary.unreachable === 'number' ? summary.unreachable : 0
  const sources = Array.isArray(summary.unreachableSources)
    ? summary.unreachableSources.filter((s) => typeof s === 'string' && s !== '')
    : []
  if (unreachable === 0 && sources.length === 0) return null
  return { unreachable, sources }
}

function updateRisks(result) {
  if (result === null || typeof result !== 'object') return []
  if (Array.isArray(result.risks) && result.risks.length > 0) return result.risks
  if (Array.isArray(result.items)) {
    return result.items.flatMap((item) => (Array.isArray(item.risks) ? item.risks : []))
  }
  return []
}

function rowIsUnreachable(row) {
  if (row !== null && typeof row === 'object' && row.reached === false) return true
  return Array.isArray(row?.profiles) && row.profiles.some((p) => p?.reached === false)
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
// from EVERY trigger path (web routes, agent tools) — and
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

/** True when the live slot says this row's package is executing right now. */
function liveMatchesRow(live, name) {
  return liveRunningOf(live) && live?.current?.name === name
}

/**
 * Normalize the slot's latest progress event into the row's rendering
 * shape. The server filters raw `line` events out of the slot, so only
 * progress / retry / phase shapes arrive; anything unknown renders as an
 * indeterminate bar with no label. Rich fields (done/total/unit/package/at)
 * pass through untouched when the server sent them — older servers simply
 * omit them and the detail line stays empty.
 */
function liveRowProgress(live) {
  if (!liveRunningOf(live)) return null
  const p = live.progress
  if (p === null || p === undefined || typeof p !== 'object') return { percent: null, phase: null }
  if (p.type === 'progress') return normalizeProgressEvent(p)
  if (p.type === 'retry') return { percent: null, phase: 'retry' }
  if (p.type === 'phase') return { percent: null, phase: p.phase ?? null }
  return { percent: null, phase: null }
}

/**
 * Normalize one server progress event into the row shape: a numeric
 * percent when the server knows one (null → indeterminate), the phase
 * label key suffix, and the optional counters/byte totals the detail line
 * renders. Unknown/garbage fields degrade to null, never throw.
 */
function normalizeProgressEvent(p) {
  const unit = p.unit === 'bytes' || p.unit === 'packages' ? p.unit : null
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  const normalized = {
    percent: num(p.percent),
    phase: typeof p.phase === 'string' && p.phase !== '' ? p.phase : null,
    done: num(p.done),
    total: num(p.total),
    unit,
    package: typeof p.package === 'string' && p.package !== '' ? p.package : null,
    at: num(p.at),
  }
  return normalized
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** 9270373 → '8.8 MB' (binary multiples, one decimal above bytes). */
function formatBytes(n) {
  if (n === null) return '—'
  let value = n
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`
}

/** 42 → '42 秒' / 95 → '1 分 35 秒' — the ETA under the bar. */
function formatEta(seconds, t) {
  if (seconds === null || seconds < 1) return t('etaSoon')
  if (seconds < 60) return t('etaSeconds', { n: Math.round(seconds) })
  const minutes = Math.floor(seconds / 60)
  return t('etaMinutes', { m: minutes, s: Math.round(seconds % 60) })
}

/**
 * Speed and ETA between two progress events of the same unit. The client
 * owns the timing: the server stamps each event (`at`, epoch ms) and the
 * delta between consecutive events is the measured rate. Returns nulls
 * when the pair cannot carry a rate (different units, no elapsed time).
 */
function progressStats(progress, previous) {
  if (progress === null || previous === null) return { speed: null, eta: null }
  if (progress.unit === null || progress.unit !== previous.unit) return { speed: null, eta: null }
  if (typeof progress.at !== 'number' || typeof previous.at !== 'number') return { speed: null, eta: null }
  const elapsed = (progress.at - previous.at) / 1000
  const moved = typeof progress.done === 'number' && typeof previous.done === 'number' ? progress.done - previous.done : null
  if (elapsed <= 0 || moved === null || moved <= 0) return { speed: null, eta: null }
  const speed = moved / elapsed
  const remaining = typeof progress.total === 'number' ? Math.max(0, progress.total - progress.done) : null
  return { speed, eta: speed > 0 && remaining !== null ? remaining / speed : null }
}

/**
 * The detail line under the bar: counters ("8.4 MB / 9.3 MB", "8/13 个包",
 * "已解析 12 个包"), then measured speed and ETA when a rate exists.
 * `previous` is the prior event of the same run (null at the start).
 */
function progressDetail(t, progress, previous) {
  if (progress === null || progress === undefined) return null
  const parts = []
  const hasTotal = typeof progress.total === 'number' && Number.isFinite(progress.total)
  if (progress.unit === 'bytes' && typeof progress.done === 'number' && hasTotal) {
    parts.push(t('progressBytes', { done: formatBytes(progress.done), total: formatBytes(progress.total) }))
  } else if (progress.unit === 'packages' && typeof progress.done === 'number') {
    parts.push(hasTotal
      ? t('progressPackages', { done: progress.done, total: progress.total })
      : t('progressResolved', { done: progress.done }))
  }
  const { speed, eta } = progressStats(progress, previous)
  if (speed !== null) {
    parts.push(progress.unit === 'bytes'
      ? t('progressSpeedBytes', { speed: formatBytes(speed) })
      : t('progressSpeedPackages', { n: Math.round(speed * 10) / 10 }))
  }
  if (eta !== null) parts.push(t('progressEta', { eta: formatEta(eta, t) }))
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * The live progress bar for one update seat: a crisp determinate bar when
 * the server reports a percent, a striped indeterminate fill otherwise
 * (resolution, retry, or an older server with no numbers). The label
 * shows the percent or the phase; the detail line carries counters, speed
 * and ETA. Accessible: role=progressbar with aria-valuenow while
 * determinate, and the detail text exposed as aria-valuetext.
 */
function ProgressBar({ t, progress, previous = null }) {
  if (progress === null || progress === undefined) return null
  const percent = progress.percent
  const determinate = typeof percent === 'number'
  const detail = progressDetail(t, progress, previous)
  const phaseLabel = t(`progress_${progress.phase ?? ''}`)
  const label = determinate ? `${percent}%` : (progress.phase !== null && progress.phase !== undefined ? t('progressPhase', { phase: phaseLabel }) : null)
  return h('div', { className: 'duc-progress-wrap' },
    h('div', {
      className: 'duc-progress',
      role: 'progressbar',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      ...(determinate ? { 'aria-valuenow': percent } : {}),
      ...(detail !== null ? { 'aria-valuetext': detail } : {}),
    },
      h('div', {
        className: determinate ? 'duc-progress-fill' : 'duc-progress-fill duc-indet',
        style: determinate ? { width: `${percent}%` } : undefined,
      })),
    label !== null ? h('span', { className: 'duc-progress-label' }, label) : null,
    detail !== null ? h('span', { className: 'duc-progress-detail' }, detail) : null)
}

// ---------------------------------------------------------------------------
// Shared bulk-queue state, cross-seat on one page.
//
// The sequential "update all" / "update bundle" runners know their own queue
// and current position. Publishing it module-level (not per-seat) means every
// seat renders
// queued rows as "pending" even when only one seat started the run, and the
// info survives the starting seat unmounting (e.g. closing the popup
// mid-run). The server never sees the queue (every update is its own
// request), so another browser tab — and agent-tool updates, which have no
// queue at all — fall back to the existing disabled-button + live-banner
// view instead of pretending to know a queue.
// ---------------------------------------------------------------------------

let bulkQueueState = { running: false, index: 0, total: 0, name: null, queue: [] }
const bulkQueueSubs = new Set()

function publishBulkQueue(state) {
  bulkQueueState = state
  for (const notify of bulkQueueSubs) notify()
}

function subscribeBulkQueue(notify) {
  bulkQueueSubs.add(notify)
  return () => bulkQueueSubs.delete(notify)
}

function useBulkQueue() {
  // getServerSnapshot = null: nothing ever ran server-side, render idle.
  return useSyncExternalStore(subscribeBulkQueue, () => bulkQueueState, () => null)
}

// The sequential pass's final `{ failed, changed, requiresRestart }` summary
// is shared module-level exactly like the queue: a pass started by the sidebar
// quick button (which renders no detail on its own) still lands its outcome
// inside the popup, and `useBulkUpdate` subscribers everywhere
// see one truth instead of per-seat copies.
let bulkResultState = null
const bulkResultSubs = new Set()

function publishBulkResult(result) {
  bulkResultState = result
  for (const notify of bulkResultSubs) notify()
}

function subscribeBulkResult(notify) {
  bulkResultSubs.add(notify)
  return () => bulkResultSubs.delete(notify)
}

function useBulkResult() {
  return useSyncExternalStore(subscribeBulkResult, () => bulkResultState, () => null)
}

/**
 * True when `name` is still waiting in the running sequential pass — queued
 * behind the currently executing item, not yet attempted. Such rows render a
 * disabled "待更新 / Queued" button instead of a plain disabled "Update", so
 * a pass reads as one queue: the running row shows live progress, the rest
 * say "pending, starts right after". Position-aware on purpose: rows already
 * attempted earlier in this pass (pos < index) keep the regular disabled
 * button — the scan has not refreshed mid-pass, so a stale "pending" would
 * lie about an already-updated package.
 */
function rowQueuedInBulk(bulk, name) {
  if (bulk === null || bulk === undefined || typeof bulk !== 'object') return false
  if (bulk.running !== true || !Array.isArray(bulk.queue)) return false
  const pos = bulk.queue.indexOf(name)
  if (pos === -1) return false
  // The executing row is owned by the live mirror ("更新中…" + progress), not
  // by the queue label.
  if (typeof bulk.name === 'string' && bulk.name !== '' && name === bulk.name) return false
  const index = typeof bulk.index === 'number' && Number.isFinite(bulk.index) ? bulk.index : 0
  return pos >= index
}

// ---------------------------------------------------------------------------
// External-completion rescans.
// ---------------------------------------------------------------------------

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

/** One scan-data owner for the popup. */
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

/** Quick-update bolt: filled glyph, drawn in the same hand-written style as
 * the radar mark so the pair reads as one family. */
function BoltIcon() {
  return h('svg', { viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true', fill: 'currentColor' },
    h('path', { d: 'M9.4 1.2 L3.8 9.5 H7.7 L6.6 14.8 L12.2 6.5 H8.3 Z' }))
}

/**
 * Disclosure chevron: official 14px outline icon when the primitives bundle is
 * present, a plain text glyph otherwise. `open` faces down (expanded), closed
 * faces right (collapsed) — the dsh-market disclosure convention.
 *
 * Host 0.1.7 renamed the icon exports from size-suffixed (…Outline14) to
 * weight-suffixed (…OutlineRegular); resolve every generation the plugin has
 * shipped against, and degrade to the text glyph on a name the module does not
 * export — h(undefined) throws React #130 and takes down the whole seat.
 */
function Chevron({ open }) {
  if (primitives !== null) {
    const down = primitives.IconChevronDownOutlineRegular ?? primitives.IconChevronDownOutline14 ?? primitives.IconChevronDownOutline
    const right = primitives.IconChevronRightOutlineRegular ?? primitives.IconChevronRightOutline14 ?? primitives.IconChevronRightOutline
    const Icon = open ? down : right
    if (Icon !== null && Icon !== undefined) return h(Icon, { size: 14 })
  }
  return h('span', { className: 'duc-chevron-fallback' }, open ? '▾' : '▸')
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

const ERROR_CODE_KEYS = {
  update_running: 'errUpdateRunning',
  linked_install: 'errLinked',
  official_package: 'errOfficial',
  not_installed: 'errNotInstalled',
  unsafe_target: 'errUnsafe',
  invalid_profile: 'errUnsafe',
  confirm_required: 'errConfirm',
  preflight_blocked: 'errPreflightBlocked',
  update_failed: 'errFailed',
  update_timeout: 'errTimeout',
  update_noop: 'errNoop',
  latest_unavailable: 'errLatestUnavailable',
  unsupported_channel: 'errUnsupportedChannel',
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

const KIND_KEYS = { npm: 'kindNpm', github: 'kindGithub', linked: 'kindLinked', file: 'kindFile', git: 'kindGit', other: 'kindOther' }

/**
 * Result line for one update outcome. Per-package outcomes carry an `items`
 * array (one entry per profile); render them as a compact list so a mixed
 * success/failure is truthful. Single-profile outcomes keep the original
 * one-line rendering.
 */
function UpdateRisks({ t, result }) {
  const risks = updateRisks(result)
  if (risks.length === 0) return null
  return h('div', { className: 'duc-compat' },
    h('div', { className: 'duc-note duc-error' }, t('updateRisks')),
    risks.map((risk, index) => h('div', { key: `${risk.profile}:${risk.name}:${index}` },
      h('div', { className: 'duc-note' }, `${risk.name} (${risk.profile ?? '—'}): ${risk.reasons ?? risk.state}`,
        risk.collateral === true ? h('span', { className: 'duc-note' }, ` · ${t('riskCollateral')}`) : null),
      risk.disablePatch ? h('div', { className: 'duc-note' }, t('updateRiskHint')) : null,
      risk.disablePatch ? h('pre', { className: 'duc-cmd' }, risk.disablePatch) : null,
      ...(Array.isArray(risk.removeCommands) ? risk.removeCommands.map((cmd) => h('code', { className: 'duc-cmd', key: cmd }, cmd)) : []))))
}

function UpdateWarnings({ t, result }) {
  const warnings = updateWarnings(result)
  if (warnings.length === 0) return null
  return h('div', { className: 'duc-compat' },
    h('div', { className: 'duc-note' }, t('updateWarnings')),
    warnings.map((warning, index) => h('div', { key: `${warning.type ?? 'w'}:${warning.source ?? ''}:${index}`, className: 'duc-note' },
      // Every remaining warning shape (breaking-change markers) carries a
      // ready-made bilingual message; render it verbatim.
      typeof warning.message === 'string' ? warning.message : JSON.stringify(warning))))
}

function UpdateResult({ t, result }) {
  if (result.items !== undefined && Array.isArray(result.items)) {
    return h('div', { className: `duc-note ${result.ok ? '' : 'duc-error'}` },
      result.changed ? t('updated') : (result.code === 'update_noop' ? t('updateNoChange') : t('updateFail')),
      h('ul', { className: 'duc-list' },
        result.items.map((item) => h('li', { key: item.profile },
          item.ok === true
            ? t('itemUpdated', { p: item.profile })
            : item.current === true
              ? t('itemCurrent', { p: item.profile })
              : item.skipped !== undefined
                ? `${t('itemSkipped', { p: item.profile })} — ${localizedUpdateError(t, item)}`
                : `${t('itemFailed', { p: item.profile })} — ${localizedUpdateError(t, item)}`))),
      h(UpdateWarnings, { t, result }),
      h(UpdateRisks, { t, result }))
  }
  return h('div', { className: `duc-note ${result.ok ? '' : 'duc-error'}` },
    result.ok
      ? (result.changed ? t('updated') : t('updateNoChange'))
      : localizedUpdateError(t, result),
    h(UpdateWarnings, { t, result }),
    h(UpdateRisks, { t, result }))
}

/**
 * One package row, merged across profiles: the version cell lists every
 * installed profile with its current → latest; a single click on Update runs
 * only in its explicit eligible profiles. The only remaining two-step action
 * is the destructive rollback.
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

/**
 * Classify one sequential pass's per-package results into the sidebar quick
 * button's terminal states. `[]` reads as "nothing to update" (the pass never
 * started); any failure wins over a mixed success. Exported through __test for
 * regression tests.
 */
function quickOutcome(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return { phase: 'none', failed: 0, requiresRestart: false }
  }
  const failed = results.filter((r) => r?.outcome?.ok !== true).length
  return {
    phase: failed > 0 ? 'failed' : 'done',
    failed,
    requiresRestart: results.some((r) => r?.outcome?.requiresRestart === true),
  }
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

function PluginRow({ t, row, onUpdated, bulkRunning = false, refreshing = false, mountedChildren = [], onRunBundle }) {
  const ui = useUi()
  const [mountedOpen, setMountedOpen] = useState(false)
  const [rollbackConfirming, setRollbackConfirming] = useState(false)
  const [forceConfirming, setForceConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  // Live update progress: null = idle; the event carries percent (null →
  // indeterminate bar), the phase, and optional counters/bytes the detail
  // line renders. `previousProgress` is the event before it — the pair is
  // what the speed/ETA math measures.
  const [progress, setProgress] = useState(null)
  const previousProgress = useRef(null)
  // Cross-seat guard: while ANY update runs (auto-run, agent tools, another
  // tab), the row's own actions disable — the server serializes updates and
  // would answer the click with "another update is already running".
  const live = useLive()
  const liveRunning = liveRunningOf(live)
  // Sequential-pass queue (shared cross-seat): while the running pass still
  // has this package ahead of it, the row reads "待更新 / Queued" instead of a
  // plain disabled Update, so a bulk pass shows one queue at a glance. The
  // pass's own current item also flips to "更新中…" right away — the 2s live
  // poll is the server truth, but it lags the pass by a poll cycle, during
  // which a stark disabled "Update" would otherwise sit on the running row.
  const bulkQueue = useBulkQueue()
  const queuedInBulk = rowQueuedInBulk(bulkQueue, row.name)
  const bulkCurrentRow = bulkQueue !== null && typeof bulkQueue === 'object'
    && bulkQueue.running === true
    && typeof bulkQueue.name === 'string' && bulkQueue.name !== '' && bulkQueue.name === row.name
  // This row's package is being updated by someone else (popup, bulk, agent
  // tool, another tab): mirror the live slot into the row so every seat shows
  // the same progress. The row's own SSE stream stays authoritative while it
  // runs (busy); the 2s-poll mirror only fills the gap for external runs.
  const liveForRow = !busy && liveMatchesRow(live, row.name)
  const shownProgress = busy ? progress : (liveForRow ? liveRowProgress(live) : null)
  // Remember the event we rendered last so the next one can be measured
  // against it (speed/ETA). Render-time ref write: one render of lag on
  // the rate is invisible, and the first event simply has no previous.
  const shownPrevious = previousProgress.current
  previousProgress.current = shownProgress
  // Edge-triggered stale-result cleanup: an old failure line must not sit
  // next to a fresh "updating" banner when a new round for this package
  // starts elsewhere. The edge + !busy guard keeps the row's own just-written
  // result safe: while its own run executes the ref is already true, so the
  // lagging poll snapshot arriving right after a failure cannot re-arm it.
  const wasLiveForRow = useRef(false)
  useEffect(() => {
    const isFor = liveMatchesRow(live, row.name)
    if (isFor && !wasLiveForRow.current && !busy) setResult(null)
    wasLiveForRow.current = isFor
  }, [live, busy, row.name])

  const canUpdate = row.canAutoUpdate === true
  const hasMounted = mountedChildren.length > 0
  const canUpdateBundle = shouldShowBundleUpdate(row, mountedChildren)
  const mountedBehind = mountedUpdateCount(mountedChildren)
  const mountInfo = mountRelationshipInfo(row)
  const note = row.official ? t('officialNote') : null
  const actionsDisabled = rowActionsDisabled(busy, bulkRunning || refreshing || ui.operation !== null)

  async function runUpdate(force = undefined) {
    if (!acquireMutation('row')) return
    setBusy(true)
    setResult(null)
    setProgress({ percent: null, phase: 'start' })
    try {
      const outcome = await streamUpdate(row.name, (event) => {
        if (event.type === 'progress') setProgress(normalizeProgressEvent(event))
        else if (event.type === 'retry') setProgress({ percent: null, phase: 'retry' })
        else if (event.type === 'phase' && event.phase === 'start') setProgress({ percent: null, phase: 'start' })
      }, undefined, rowUpdateTarget(row).profiles, undefined, force)
      setResult(outcome)
      if (outcome.ok && outcome.changed) await onUpdated(outcome)
    } catch (e) {
      setResult({ ok: false, error: String(e.message ?? e) })
    } finally {
      setBusy(false)
      setProgress(null)
      releaseMutation()
    }
  }

  async function runRollback() {
    if (rollbackOfResult(result) === null) return
    if (!acquireMutation('rollback')) return
    setBusy(true)
    setRollbackConfirming(false)
    setProgress({ percent: null, phase: 'start' })
    try {
      const outcome = await streamUpdate(row.name, (event) => {
        if (event.type === 'progress') setProgress(normalizeProgressEvent(event))
        else if (event.type === 'retry') setProgress({ percent: null, phase: 'retry' })
        else if (event.type === 'phase' && event.phase === 'start') setProgress({ percent: null, phase: 'start' })
      }, undefined, rowUpdateTarget(row).profiles, rollbackOfResult(result).target)
      setResult(outcome)
      if (outcome.ok && outcome.changed) await onUpdated(outcome)
    } catch (e) {
      setResult({ ok: false, error: String(e.message ?? e) })
    } finally {
      setBusy(false)
      setProgress(null)
      releaseMutation()
    }
  }

  const availState = rowAvailabilityState(row)
  const availBadge = availabilityBadge(availState)
  const availReasons = availState === 'ok' || availState === 'inert'
    ? null
    : (row.availability?.reasons
      ?? row.profiles?.find((p) => p.availability?.state === availState)?.availability?.reasons
      ?? null)

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
      mountInfo.mountedBy.map((parent) => h('span', { className: 'duc-chip duc-mount-chip', key: parent },
        t('mountedBy', { name: parent }))),
      h('span', { className: 'duc-ver' },
        row.profiles.map((p) => h('span', {
          key: p.profile,
          className: 'duc-chip',
          title: `${p.profile} · ${t(KIND_KEYS[p.kind] ?? 'kindOther')} · ${t('current')}: ${p.current} → ${t('latest')}: ${p.latest ?? '—'} · ${p.reached === false ? t('cannotCheck') : (p.availability?.state ?? '')}`,
        }, p.reached === false
          ? `${p.profile}: ${t('cannotCheck')}`
          : p.updateAvailable
            ? `${p.profile}: ${shortVer(p.current)} → ${shortVer(p.latest)}`
            : `${p.profile}: ${shortVer(p.current)}`))),
      h('span', { className: `duc-badge ${row.updateAvailable ? 'behind' : (rowIsUnreachable(row) ? 'unknown' : 'ok')}` },
        row.updateAvailable ? t('behind') : (rowIsUnreachable(row) ? t('cannotCheck') : t('upToDate'))),
      availBadge !== null ? h('span', { className: `duc-badge ${availBadge.className}` }, t(availBadge.key)) : null,
      pluginHasCompat(row) ? h('span', { className: 'duc-badge high' }, t('compatBadge')) : null,
      !pluginHasCompat(row) && pluginHasTargetCompat(row) ? h('span', { className: 'duc-badge behind' }, t('compatTargetBadge')) : null,
      !row.updateAvailable && mountedBehind > 0 ? h('span', { className: 'duc-note' },
        t('mountedUpdates', { n: mountedBehind })) : null,
      mountInfo.mounts.length > 0 ? h('span', { className: 'duc-note' },
        t('mounts', { names: mountInfo.mounts.map((relation) => relation.child).join(', ') })) : null,
      note !== null ? h('span', { className: 'duc-note' }, note) : null,
      h('span', { className: 'duc-actions' },
        canUpdate ? (busy || liveForRow || bulkCurrentRow
          ? h('button', { className: 'duc-btn', disabled: true }, t('updating'))
          : queuedInBulk
            ? h('button', { className: 'duc-btn', disabled: true, title: t('queuedHint') }, t('queued'))
            // Wrapped, not passed bare: React hands the synthetic click event
            // to the handler, and runUpdate's first parameter is `force` —
            // a bare reference put a DOM button (via its fiber) into the POST
            // body and JSON.stringify threw before fetch ran.
            : h('button', { className: 'duc-btn primary', onClick: () => runUpdate(), disabled: actionsDisabled || liveRunning, title: liveRunning ? t('liveBusy') : undefined }, t('update'))) : null,
        canUpdateBundle ? h('button', {
          className: 'duc-btn',
          onClick: () => onRunBundle?.(row, mountedChildren),
          disabled: actionsDisabled || liveRunning,
        }, t('updateBundle')) : null)),
    h(ProgressBar, { t, progress: shownProgress, previous: shownPrevious }),
    result !== null ? h(UpdateResult, { t, result }) : null,
    result !== null && result.code === 'preflight_blocked' ? h('div', { className: 'duc-compat' },
      h('div', { className: 'duc-note duc-error' }, t('forceHint')),
      Array.isArray(result.blockers) ? h(CompatDetails, { t, findings: result.blockers }) : null,
      busy || liveRunning ? null : h('div', { className: 'duc-actions' },
        h('button', {
          className: `duc-btn ${forceConfirming ? 'danger' : ''}`,
          onClick: () => (forceConfirming ? (setForceConfirming(false), runUpdate(true)) : setForceConfirming(true)),
          onBlur: () => setForceConfirming(false),
          disabled: actionsDisabled,
        }, forceConfirming ? t('confirmForce') : t('forceUpdate')))) : null,
    (() => {
      const rollback = rollbackOfResult(result)
      if (rollback === null || busy || liveRunning || typeof rollback.target !== 'string') return null
      return h('div', { className: 'duc-actions' },
        h('button', {
          className: `duc-btn ${rollbackConfirming ? 'danger' : ''}`,
          onClick: () => (rollbackConfirming ? runRollback() : setRollbackConfirming(true)),
          onBlur: () => setRollbackConfirming(false),
          disabled: actionsDisabled,
        }, rollbackConfirming ? t('rollbackConfirm') : t('rollbackTo', { target: shortVer(rollback.target) })))
    })(),
    pluginHasCompat(row) || pluginHasTargetCompat(row) ? h(CompatDetails, { t, findings: row.compat }) : null,
    availReasons ? h('div', { className: 'duc-note' }, availReasons) : null,
    hasMounted && mountedOpen ? h('div', { className: 'duc-mounted-group' },
      mountedChildren.map((child) => h(PluginRow, {
        t, row: child.row, key: child.row.name, onUpdated, bulkRunning, refreshing,
        mountedChildren: child.children, onRunBundle,
      }))) : null,
    )
}

function CompatDetails({ t, findings }) {
  if (!Array.isArray(findings) || findings.length === 0) return null
  return h('div', { className: 'duc-compat' },
    findings.map((finding, index) => h('div', { key: `${finding.plugin}:${finding.file}:${index}` },
      h('div', { className: 'duc-note' },
        t('compatMissing', {
          file: finding.file ?? '',
          pkg: finding.specifier ?? '',
          names: Array.isArray(finding.missing) ? finding.missing.join(', ') : '',
        }),
        finding.hostMissing === true ? ` · ${t('compatHostMissing')}` : ''),
      finding.disablePatch ? h('div', { className: 'duc-note' }, t('compatDisable')) : null,
      finding.disablePatch ? h('pre', { className: 'duc-cmd' }, finding.disablePatch) : null,
      Array.isArray(finding.removeCommands) && finding.removeCommands.length > 0
        ? h('div', { className: 'duc-note' }, t('compatRemove')) : null,
      ...(Array.isArray(finding.removeCommands) ? finding.removeCommands.map((cmd) => h('code', { className: 'duc-cmd', key: cmd }, cmd)) : []))))
}

function CoreCard({ t, core, compat, onUpdated }) {
  // Folded by default — the core card is dense and rarely actionable. The
  // stored flag keeps the user's explicit choice: '0' = unfolded on purpose.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(NS_CORE_FOLDED) !== '0' } catch { return true }
  })
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [progress, setProgress] = useState(null)
  const previousProgress = useRef(null)
  const [confirming, setConfirming] = useState(false)
  const [forceConfirming, setForceConfirming] = useState(false)
  const live = useLive()
  const liveRunning = liveRunningOf(live)
  const coreRow = core.packages[0]
  const summary = compatSummary(compat)
  const install = core.install ?? { method: 'unknown', writable: false, prefix: null }
  // Single target: the newest healthy published version (the server's own
  // line — never a dist-tag string).
  const target = coreRow !== undefined && typeof coreRow.latest === 'string' && coreRow.latest !== ''
    ? {
        version: coreRow.latest,
        relation: coreRow.updateAvailable === true
          ? 'upgrade'
          : (typeof coreRow.current === 'string' && coreRow.latest === coreRow.current ? 'same' : 'downgrade'),
      }
    : null
  const actionsDisabled = busy || liveRunning
  // Previous progress event for the speed/ETA pair (one render of lag on
  // the rate is invisible; the first event simply has no previous).
  const coreProgressPrevious = previousProgress.current
  previousProgress.current = progress
  // Execution needs a moving target, a global npm install, and write access
  // to its prefix — every other shape stays copy-only (the server re-checks).
  const executable = target !== null && target.relation !== 'same'
    && install.method === 'global' && install.writable === true
  const command = target !== null ? `npm install -g @deepseek-ai/dsh@${target.version}` : null

  function toggleCollapsed() {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem(NS_CORE_FOLDED, next ? '1' : '0') } catch { /* storage unavailable */ }
  }
  function copyCmd(text) {
    navigator.clipboard?.writeText(text ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  async function runCore(force = false) {
    if (target === null) return
    if (!acquireMutation('core')) return
    setBusy(true)
    setResult(null)
    setProgress({ percent: null, phase: 'start' })
    try {
      const outcome = await streamCoreUpdate({
        // A deliberately chosen downgrade IS the intent: its second (red)
        // confirm click rides force. Gate overrides use their own button.
        ...(target.relation === 'downgrade' || force === true ? { force: true } : {}),
      }, (event) => {
        if (event.type === 'progress') setProgress(normalizeProgressEvent(event))
        else if (event.type === 'retry') setProgress({ percent: null, phase: 'retry' })
        else if (event.type === 'phase' && event.phase === 'start') setProgress({ percent: null, phase: 'start' })
      })
      setResult(outcome)
      if (outcome.ok && outcome.changed) await onUpdated?.(outcome)
    } catch (e) {
      setResult({ ok: false, error: String(e.message ?? e) })
    } finally {
      setBusy(false)
      setConfirming(false)
      setForceConfirming(false)
      setProgress(null)
      releaseMutation()
    }
  }

  const bundleRows = core.packages.slice(1)
  const visibleRows = collapsed ? core.packages.slice(0, 1) : core.packages
  const rollback = rollbackOfResult(result)
  return h('div', { className: 'duc-card' },
    h('button', { type: 'button', className: 'duc-collapse-head', onClick: toggleCollapsed, 'aria-expanded': !collapsed },
      h('span', { className: 'duc-collapse-icon', 'aria-hidden': 'true' },
        h(Chevron, { open: !collapsed })),
      h('span', { className: 'duc-collapse-title' }, t('coreTitle')),
      summary !== null ? h('span', { className: 'duc-badge high' }, t('compatChip', { n: summary.plugins.length })) : null,
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
      h('span', { className: `duc-badge ${p.updateAvailable ? 'behind' : (p.reached === false ? 'unknown' : 'ok')}` },
        p.updateAvailable ? t('coreBehind') : (p.reached === false ? t('cannotCheck') : t('coreCurrent'))))),
    !collapsed ? h('div', { className: 'duc-note' }, t('corePolicy')) : null,
    !collapsed && target !== null && command !== null ? h('div', null,
      target.relation === 'downgrade' ? h('div', { className: 'duc-banner warn' },
        t('coreDowngradeWarn', {
          v: target.version,
          cur: coreRow?.current ?? '—',
        })) : null,
      target.relation === 'same' ? h('div', { className: 'duc-note' }, t('coreSameVersion')) : null,
      !executable ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        h('code', { className: 'duc-cmd', style: { flex: 1 } }, command),
        h('button', { className: 'duc-btn', onClick: () => copyCmd(command) }, copied ? t('copied') : t('copyCmd')),
        target.relation === 'same'
          ? null
          : h('div', { className: 'duc-note' },
              t(install.method !== 'global' ? 'coreNoExec' : 'coreNotWritable', { method: install.method }))) : h('div', { className: 'duc-actions' },
        busy || liveRunning
          ? h('button', { className: 'duc-btn', disabled: true, title: liveRunning ? t('liveBusy') : undefined }, t('coreUpdating'))
          : h('button', {
              className: `duc-btn primary${confirming ? ' danger' : ''}`,
              onClick: () => (confirming ? runCore(false) : setConfirming(true)),
              onBlur: () => setConfirming(false),
              disabled: actionsDisabled,
            }, confirming
              ? (target.relation === 'downgrade' ? t('coreConfirmDown') : t('coreConfirm'))
              : t('coreUpdate'))),

      h(ProgressBar, { t, progress, previous: coreProgressPrevious }),

      result !== null ? h(UpdateResult, { t, result }) : null,
      result !== null && result.ok && result.changed ? h('div', { className: 'duc-banner warn' },
        `${t('coreUpdated', { v: result.after ?? '—' })} ${t('coreRestartHint', { cur: result.before ?? '—' })}`) : null,
      result !== null && (result.code === 'preflight_blocked' || result.code === 'core_downgrade_blocked')
        ? h('div', { className: 'duc-compat' },
            h('div', { className: 'duc-note duc-error' }, t('coreExecBlocked')),
            Array.isArray(result.blockers) && result.blockers.length > 0 ? h(CompatDetails, { t, findings: result.blockers }) : null,
            actionsDisabled ? null : h('div', { className: 'duc-actions' },
              h('button', {
                className: `duc-btn ${forceConfirming ? 'danger' : ''}`,
                onClick: () => (forceConfirming ? (setForceConfirming(false), runCore(true)) : setForceConfirming(true)),
                onBlur: () => setForceConfirming(false),
              }, forceConfirming ? t('confirmForce') : t('forceUpdate')))) : null,
      rollback !== null && typeof rollback.command === 'string' && result !== null && result.ok && result.changed ? h('div', { className: 'duc-compat' },
        h('div', { className: 'duc-note' }, t('coreRollbackCmd', { v: rollback.target })),
        h('pre', { className: 'duc-cmd' }, rollback.command)) : null) : null,
    !collapsed && summary !== null && summary.current > 0 ? h('div', { className: 'duc-banner warn' },
      t('compatCurrent', { v: compat.current?.hostVersion ?? '—' }),
      h(CompatDetails, { t, findings: compat.current.findings })) : null,
    !collapsed && summary !== null && summary.target > 0 ? h('div', { className: 'duc-banner warn' },
      t('compatTarget', { v: compat.target?.hostVersion ?? '—' }),
      h(CompatDetails, { t, findings: compat.target.findings })) : null)
}

/**
 * The single plugins card: every package merged across profiles, one row per
 * package, split into two sections — "updates available" always rendered,
 * "up to date" behind a disclosure folded by default. `plugins` is the
 * aggregated list from the scan.
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
  const state = rowAvailabilityState(node.row)
  return node.row.updateAvailable === true
    || rowIsUnreachable(node.row)
    || state === 'broken'
    || state === 'missing'
    || node.children.some(nodeIsBehind)
}

function PluginListCard({ t, plugins, onUpdated, bulkRunning = false, bundleRunning = false, refreshing = false, onRunBundle }) {
  const [showOk, setShowOk] = useState(false)
  const groups = partitionPluginGroups(plugins)
  const renderGroups = (items) => items.map(({ parent, mountedChildren }) => h(PluginRow, {
    t, row: parent, key: parent.name, onUpdated,
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
  const bulkResult = useBulkResult()
  const runAll = useCallback(async (plugins, onUpdated) => {
    const targets = globalUpdateTargets(plugins)
    if (targets.length === 0) return []
    return withMutationLock('all', async () => {
      publishBulkResult(null)
      const queue = targets.map((target) => target.name)
      const snapshot = (index, name) => ({ running: true, index, total: targets.length, name, queue })
      setBulk(snapshot(0, null))
      publishBulkQueue(snapshot(0, null))
      const results = []
      try {
        for (let i = 0; i < targets.length; i += 1) {
          setBulk(snapshot(i + 1, targets[i].name))
          publishBulkQueue(snapshot(i + 1, targets[i].name))
          try {
            results.push({ name: targets[i].name, outcome: await streamUpdate(targets[i].name, () => {}, undefined, targets[i].profiles) })
          } catch (e) {
            results.push({ name: targets[i].name, outcome: { ok: false, error: String(e.message ?? e) } })
          }
        }
        const failed = results.filter((r) => r.outcome.ok !== true).length
        const changed = results.some((r) => r.outcome.changed === true)
        publishBulkResult({ failed, changed, requiresRestart: results.some((r) => r.outcome.requiresRestart === true) })
        if (changed) await onUpdated?.({ requiresRestart: results.some((r) => r.outcome.requiresRestart === true) })
        return results
      } finally {
        const idle = { running: false, index: 0, total: 0, name: null, queue: [] }
        setBulk(idle)
        publishBulkQueue(idle)
      }
    })
  }, [])
  return { bulk, bulkResult, runAll }
}

/**
 * Persistent "an update is executing right now" banner for the popup.
 * Renders whenever the server reports a running update —
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
    // Counters/bytes when the server streams them (no speed here — the
    // banner has no previous event to measure against).
    if (prog.type === 'progress') {
      const counts = progressDetail(t, normalizeProgressEvent(prog), null)
      if (counts !== null) detail += ` · ${counts}`
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
      const queue = targets.map((target) => target.name)
      const snapshot = (index, name) => ({ running: true, index, total: targets.length, name, queue })
      setBundle(snapshot(0, null))
      publishBulkQueue(snapshot(0, null))
      const results = []
      try {
        for (let i = 0; i < targets.length; i += 1) {
          const target = targets[i]
          setBundle(snapshot(i + 1, target.name))
          publishBulkQueue(snapshot(i + 1, target.name))
          try {
            results.push({ ...target, outcome: await streamUpdate(target.name, () => {}, undefined, target.profiles) })
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
        const idle = { running: false, index: 0, total: 0, name: null, queue: [] }
        setBundle(idle)
        publishBulkQueue(idle)
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

/** Toolbar actions for the popup. */
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
// Preferences (rendered inside the popup).
// ---------------------------------------------------------------------------

/** The click-to-auto-update preference row. */
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

function AvailabilityBanners({ t, status }) {
  if (status === null || typeof status !== 'object') return null
  const avail = availabilityBanner(status.summary?.availability, status.plugins)
  const unreachable = unreachableBanner(status.summary?.availability)
  return h(React.Fragment, null,
    avail !== null ? h('div', { className: 'duc-banner warn' },
      t('availBanner', { broken: avail.broken, missing: avail.missing, names: avail.names.join(', ') || '—' })) : null,
    unreachable !== null ? h('div', { className: 'duc-banner warn' },
      t('availUnreachable', { sources: unreachable.sources.join(', ') || String(unreachable.unreachable) })) : null)
}

/**
 * The patch-name audit banner: cordis.patch.yml entries whose pinned `name`
 * the dsh loader can no longer resolve are skipped silently — config and all
 * (e.g. the 0.1.7-rc.2 dsh-llm-deepseek → dsh-llm-deepseek-api-key rename).
 * One line per finding above the plugin list, plus the copy-ready verify
 * command per affected profile: after fixing the name (or dropping it to
 * match by id), an empty grep means the loader accepts the patch again.
 */
function PatchAuditBanner({ t, findings }) {
  if (!Array.isArray(findings) || findings.length === 0) return null
  const profiles = []
  for (const finding of findings) {
    if (!profiles.includes(finding.profile)) profiles.push(finding.profile)
  }
  return h('div', { className: 'duc-banner warn' },
    h('div', { style: { fontWeight: 600 } }, t('patchAuditTitle', { n: findings.length })),
    findings.map((finding, index) => h('div', { key: `${finding.profile}:${finding.id}:${index}` },
      t('patchAuditLine', { profile: finding.profile, id: finding.id, name: finding.pinnedName }))),
    h('div', null, t('patchAuditFix')),
    h('div', { className: 'duc-note' }, t('patchAuditVerify')),
    profiles.map((profile) => h('code', {
      className: 'duc-cmd',
      key: `verify:${profile}`,
      style: { display: 'block', marginTop: '4px' },
    }, `dsh --profile ${profile} --dump-config 2>&1 >/dev/null | grep "mismatch\\|not found"`)))
}

// ---------------------------------------------------------------------------
// Seat 2: the sidebar foot trigger with the lazy badge + one-click quick
// update. ONE slot entry carries both buttons (the shell flexes entries in one
// row with no gap and the cordis entry is width:100%/flex:none, so a second
// entry would overflow rather than sit beside this one).
// ---------------------------------------------------------------------------

function FootTrigger({ t, wide }) {
  const ui = useUi()
  const live = useLive()
  const bulkQueue = useBulkQueue()
  const { runAll } = useBulkUpdate()
  // Terminal quick state: null = idle, { phase } = loading | done | failed |
  // none (auto-resets after 4s), plus the outcome details for tooltips.
  const [quick, setQuick] = useState(null)
  const quickBusyRef = useRef(false)
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
  // Terminal feedback lives 4 seconds, then the button returns to idle.
  useEffect(() => {
    if (quick === null || quick.phase === 'loading') return undefined
    const id = setTimeout(() => setQuick(null), 4000)
    return () => clearTimeout(id)
  }, [quick])

  const behind = ui.summary !== null
    ? (ui.summary.behindPlugins ?? 0) + (ui.summary.behindCore ?? 0)
    : 0
  const liveRunning = liveRunningOf(live)
  const liveName = liveRunning && live.current !== null && live.current !== undefined
    ? live.current.name
    : null
  const showBadge = behind > 0
  // Quick button state: this seat's pass (queue), any live update (agent
  // tools / another tab), or the pre-pass scan read. The queue owns the
  // numeric readout; a foreign live update shows a spinner only.
  const queueRunning = bulkQueue !== null && bulkQueue.running === true
  const quickBusy = (quick !== null && quick.phase === 'loading') || queueRunning || liveRunning
  const quickIndex = queueRunning && bulkQueue !== null ? `${bulkQueue.index}/${bulkQueue.total}` : null

  async function onQuick() {
    // Synchronous re-entrancy guard: `quickBusy` (state) only flips after a
    // render, so a second click in the same tick would otherwise start two
    // passes; the mutation lock inside runAll would reject the second one and
    // surface as a misleading "none" outcome.
    if (quickBusyRef.current || quickBusy) return
    quickBusyRef.current = true
    setQuick({ phase: 'loading', failed: 0, requiresRestart: false })
    try {
      // Reuse the scan cache (usually the startup scan); force only when no
      // scan has ever landed, mirroring the popup's lazy policy.
      const force = ui.summary === null
      const data = await api(`/dsh-update-copilot/status${force ? '?force=1' : ''}`)
      setUi({ summary: data.summary, generatedAt: data.generatedAt })
      const plugins = Array.isArray(data.plugins) ? data.plugins : []
      if (globalUpdateTargets(plugins).length === 0) {
        setQuick({ phase: 'none', failed: 0, requiresRestart: false })
        return
      }
      const results = await runAll(plugins, () => loadBadgeStatus().catch(() => {}))
      // runAll resolves undefined when the mutation lock refused the pass —
      // another seat (row update, agent tool, another tab) already holds it.
      if (results === undefined) {
        setQuick({ phase: 'failed', failed: 1, requiresRestart: false, error: t('liveBusy') })
        setUi({ open: true })
        return
      }
      const outcome = quickOutcome(results)
      setQuick(outcome)
      // Failures and restart-required land the details where they exist:
      // the popup renders the shared bulk result.
      if (outcome.phase === 'failed' || outcome.requiresRestart === true) setUi({ open: true })
    } catch (error) {
      setQuick({ phase: 'failed', failed: 1, requiresRestart: false, error: String(error?.message ?? error) })
      setUi({ open: true })
    } finally {
      quickBusyRef.current = false
      loadBadgeStatus().catch(() => {})
    }
  }

  const trigger = h('button', {
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

  const quickClass = quickBusy
    ? 'duc-foot-quick busy'
    : quick !== null && quick.phase !== 'loading'
      ? `duc-foot-quick ${quick.phase}`
      : 'duc-foot-quick'
  const quickLabel = quickIndex !== null
    ? quickIndex
    : quick !== null && quick.phase === 'loading' ? '…'
      : quick !== null && quick.phase === 'none' ? t('quickNone')
        : quick !== null && quick.phase === 'failed' ? t('quickFailed', { n: quick.failed })
          : quick !== null && quick.phase === 'done' ? t('quickDone')
            : t('quickUpdate')
  const quickTitle = queueRunning && bulkQueue !== null
    ? t('quickUpdatingTitle', { name: bulkQueue.name ?? '…', i: bulkQueue.index, n: bulkQueue.total })
    : liveRunning ? t('liveUpdating', { name: liveName ?? '…' })
      : quick !== null && quick.phase === 'failed' ? (quick.error ?? t('quickFailed', { n: quick.failed }))
        : t('quickUpdateTitle')
  const quickButton = h('button', {
    className: wide === true ? quickClass : `duc-foot-btn duc-rail ${quickClass}`,
    title: quickTitle,
    'aria-label': t('quickUpdate'),
    disabled: quickBusy,
    onClick: onQuick,
  },
    h('span', { className: 'duc-quick-icon' }, BoltIcon()),
    wide === true ? h('span', { className: 'duc-foot-label' }, quickLabel) : null)

  return wide === true
    ? h('div', { className: 'duc-foot-row' }, trigger, quickButton)
    : h('div', { className: 'duc-foot-stack' }, trigger, quickButton)
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
  const { status, error, busy, load, needRestart, opsVersion, notifyUpdated } = useCopilotData(true)
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
    h(AvailabilityBanners, { t, status }),
    h(PatchAuditBanner, { t, findings: status?.patchAudit }),
    bulkResult !== null && !bulk.running ? h('div', { className: `duc-note ${bulkResult.failed > 0 ? 'duc-error' : ''}` },
      `${t('updatedAll')}${bulkResult.failed > 0 ? ` ${t('bulkFailed', { n: bulkResult.failed })}` : ''}`) : null,
    // A pass started elsewhere (the sidebar quick button) still lands its
    // restart requirement here — the local needRestart flag only tracks this
    // seat's own runs; skip when this seat already shows it.
    bulkResult !== null && !bulk.running && bulkResult.requiresRestart === true && needRestart !== true
      ? h('div', { className: 'duc-banner' }, `ℹ️ ${t('restartHint')}`)
      : null,
    bundle.running ? h('div', { className: 'duc-bulk-progress', title: t('updatingBundle', bundle) }, t('updatingBundle', bundle)) : null,
    bundleResult !== null && !bundle.running ? h(BundleUpdateResult, { t, result: bundleResult }) : null,
    needRestart ? h('div', { className: 'duc-banner' }, `ℹ️ ${t('restartHint')}`) : null,
    error !== null ? h('div', { className: 'duc-error' }, `${t('loadFail')}: ${error}`) : null,
    status === null && error === null ? h('div', { className: 'duc-note' }, t('loading')) : null,
    status !== null ? h(CoreCard, { t, core: status.core, compat: status.compat, onUpdated: notifyUpdated }) : null,
    status !== null
      ? h(PluginListCard, {
          t, plugins: status.plugins, onUpdated: notifyUpdated,
          bulkRunning: bulk.running, bundleRunning: bundle.running, refreshing: busy || ui.operation !== null, onRunBundle,
        })
      : null,
    h(AutoUpdatePrefRow, { t }),
    h(LogTail, { t, opsVersion }))
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
  streamUpdate,
  // Render seam: hands back the element for one plugin row so a test can walk
  // it and drive the shipped handlers (see test/row-update-click.test.mjs).
  pluginRowElement: (props) => h(PluginRow, props),
  coreCardElement: (props) => h(CoreCard, props),
  chevronElement: (props) => h(Chevron, props),
  patchAuditBannerElement: (props) => h(PatchAuditBanner, props),
  updateWarningsElement: (props) => h(UpdateWarnings, props),
  autoTargetsOf,
  quickOutcome,
  loadBadgeStatus,
  getUiState: () => uiState,
  acquireMutation,
  releaseMutation,
  withMutationLock,
  partitionPluginGroups,
  groupMountedRows,
  rowActionsDisabled,
  rowQueuedInBulk,
  rowUpdateTarget,
  scopedRowUpdateTarget,
  bundleUpdateTargets,
  globalUpdateTargets,
  mountedUpdateCount,
  shouldShowBundleUpdate,
  mountRelationshipInfo,
  liveMatchesRow,
  liveRowProgress,
  normalizeProgressEvent,
  formatBytes,
  formatEta,
  progressStats,
  progressDetail,
  progressBarElement: (props) => h(ProgressBar, props),
  trapModalFocus,
  compatSummary,
  pluginHasCompat,
  pluginHasTargetCompat,
  availabilityBadge,
  availabilityBanner,
  rowAvailabilityState,
  unreachableBanner,
  updateRisks,
  rowIsUnreachable,
  updateWarnings,
  rollbackOfResult,
  streamCoreUpdate,
}
// 'slots' and 'locale' are safe to require: ui-layout (mandatory in every web
// composition) already hard-depends on them.
exports.inject = ['slots', 'locale']
exports.apply = function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-update-copilot: dictionaries')
  const t = ctx.locale.bind(NS)

  // Beside Settings at the sidebar foot; the shell hands each occupant { wide }.
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'update-copilot-trigger',
    order: 10,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ t }),
  }, (props) => h(FootTrigger, { t, wide: props?.wide === true })))

  // The popup: one frame-wide floating layer occupant that renders null closed.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'update-copilot-popup',
    order: 50,
    label: () => 'dsh-update-copilot',
  }, () => h(CopilotOverlay, { t })))
}

return module.exports; } });
