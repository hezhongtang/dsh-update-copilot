window.__ModuleLoader__.load({ id: "dsh-update-copilot", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-update-copilot client.
 *
 * Three seats:
 *  - Settings section: the full update radar page (core + every profile's
 *    plugins, inline decision briefs, two-step confirm updates, op log).
 *  - sidebar.footer.action: a trigger beside the Settings button. Lazy badge:
 *    the behind-plugin count appears only after the popup has been opened at
 *    least once this session — no background polling, upstream APIs are only
 *    touched on user action.
 *  - shell.overlay: a modal popup with the compact radar — behind rows first,
 *    up-to-date rows folded away; same two-step confirm updates. Opened via
 *    the sidebar button or the `?duc=1` URL parameter (visual-test hook).
 *
 * Hand-authored CJS bundle (no build step); the only external is `react`.
 */

const React = require('react')
const h = React.createElement
const { useState, useEffect, useCallback, useRef, useSyncExternalStore } = React

const NS = 'dsh-update-copilot'

const zh = {
  nav: '更新助手',
  subtitle: 'DSH 本体、bundle 与全部 profile 插件的版本雷达',
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
  profilesTitle: 'Profile 插件',
  noPlugins: '该 profile 没有插件依赖',
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
  brief: '决策简报',
  hideBrief: '收起',
  update: '更新',
  confirmUpdate: '确认更新？',
  updating: '更新中…',
  updated: '✓ 已更新，重启后生效',
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
  noMaterial: '暂无变更详情（可能网络受限或已是最新）',
  officialNote: '官方包随 dsh 本体更新',
  linkedNote: '本地开发链接，请在其仓库内 git pull',
  logs: '操作日志',
  logsCollapse: '收起日志',
  empty: '还没有任何记录',
  scanSummary: '{p} 个插件 · {b} 个可更新',
  upToDateFold: '{n} 项已最新',
  badgeTitle: '{n} 个插件可更新',
  hideBadge: '隐藏更新红点',
  hideBadgeDesc: '关闭侧栏按钮上的「可更新数量」徽章；弹窗与本页仍会显示完整信息',
  semverMajor: '主版本 ×{n}',
  semverMinor: '次版本 ×{n}',
  semverPatch: '补丁 ×{n}',
  recCurrent: '已是最新，无需操作。',
  recLow: '可以放心更新：仅补丁级修复。',
  recMedium: '通常可以更新；建议先浏览发行说明确认行为变化。',
  recHigh: '建议暂缓：大版本跳跃，先读迁移说明与 dsh 兼容范围再决定。',
  recLinked: '请在本地仓库查看列出的提交，然后自行 git pull。',
  recUnknown: '无 semver 信号：阅读简报中的提交 / 发行说明后再决定。',
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
  errTimeout: '更新超时',
  errNoop: 'pnpm 跑完了，但本地没有变化；请重新扫描后再试，如果一直这样，把下方输出发来排查。',
  errLatestUnavailable: '拿不到 npm 上的最新版本，稍后再试。',
  errUnsupportedChannel: '这种安装方式暂不支持自动更新。',
}

const en = {
  nav: 'Update Copilot',
  subtitle: 'Version radar for the DSH core, bundles, and every profile plugin',
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
  profilesTitle: 'Profile plugins',
  noPlugins: 'No plugin dependencies in this profile',
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
  brief: 'Brief',
  hideBrief: 'Hide',
  update: 'Update',
  confirmUpdate: 'Confirm update?',
  updating: 'Updating…',
  updated: '✓ Updated — restart to apply',
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
  noMaterial: 'No changelog material (network-limited or already current)',
  officialNote: 'Official packages follow the dsh core',
  linkedNote: 'Local dev link — git pull inside its checkout',
  logs: 'Operation log',
  logsCollapse: 'Collapse log',
  empty: 'Nothing recorded yet',
  scanSummary: '{p} plugin(s) · {b} update(s) available',
  upToDateFold: '{n} up to date',
  badgeTitle: '{n} plugin update(s) available',
  hideBadge: 'Hide update badge',
  hideBadgeDesc: 'Turn off the update-count badge on the sidebar button; the popup and this page keep full details',
  semverMajor: 'major ×{n}',
  semverMinor: 'minor ×{n}',
  semverPatch: 'patch ×{n}',
  recCurrent: 'Already current — nothing to do.',
  recLow: 'Safe to update: patch-level fixes only.',
  recMedium: 'Usually safe to update; skim the release notes for behavior changes first.',
  recHigh: 'Hold: major version jump. Read the migration notes, check dsh peer ranges, then decide.',
  recLinked: 'Review the listed commits in your checkout, then git pull there yourself.',
  recUnknown: 'No semver signal: read the commits/release notes linked in the brief, then decide.',
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
  errTimeout: 'Update timed out',
  errNoop: 'pnpm finished but nothing changed. Re-scan and retry; if it persists, share the output below for debugging.',
  errLatestUnavailable: 'Could not resolve the latest version from npm. Try again shortly.',
  errUnsupportedChannel: 'This install channel is not auto-updatable yet.',
}

function injectStyles() {
  if (document.getElementById('duc-styles') !== null) return
  const style = document.createElement('style')
  style.id = 'duc-styles'
  style.textContent = [
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
    '.duc-note{font-size:12px;opacity:.65}',
    '.duc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0;border-top:1px solid rgba(127,127,127,.15)}',
    '.duc-row:first-of-type{border-top:none}',
    '.duc-name{font-weight:500;word-break:break-all}',
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
    '.duc-brief{border-top:1px dashed rgba(127,127,127,.3);margin-top:6px;padding:8px 0 2px;display:flex;flex-direction:column;gap:6px;font-size:12.5px}',
    '.duc-brief b{font-weight:600}',
    '.duc-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:2px}',
    '.duc-list a{color:inherit}',
    '.duc a{color:inherit}',
    '.duc-repolink{color:inherit;text-decoration:none;opacity:.55;font-size:12px;line-height:1;flex:none}',
    '.duc-repolink:hover{opacity:1;text-decoration:underline}',
    '.duc-chip.duc-repolink{text-decoration:none;opacity:.85}',
    '.duc-chip.duc-repolink:hover{opacity:1;border-color:rgba(127,127,127,.9)}',
    '.duc-cmd{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;border:1px dashed rgba(127,127,127,.4);border-radius:6px;padding:6px 8px;word-break:break-all}',
    '.duc-banner{border:1px solid rgba(80,140,255,.45);background:rgba(80,140,255,.08);border-radius:8px;padding:8px 12px;font-size:12.5px}',
    '.duc-log{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-all;border:1px solid rgba(127,127,127,.25);border-radius:6px;padding:8px;max-height:220px;overflow:auto;opacity:.85}',
    '.duc-error{color:#c25050}',
    '.duc-fold{border:none;background:transparent;color:inherit;font-size:12px;opacity:.7;cursor:pointer;padding:4px 0 0;text-align:left}',
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
    // modal popup
    '.duc-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999;padding:24px}',
    '.duc-modal{background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);width:min(680px,100%);max-height:min(82vh,780px);display:flex;flex-direction:column;outline:none}',
    '.duc-modal-head{display:flex;align-items:flex-start;gap:12px;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25))}',
    '.duc-modal-head h2{margin:0;font-size:15px;font-weight:600}',
    '.duc-modal-head .duc-sub{margin-top:2px}',
    '.duc-modal-x{margin-left:auto;flex:none;border:none;background:transparent;color:inherit;font-size:14px;line-height:1;cursor:pointer;opacity:.6;padding:5px 7px;border-radius:6px}',
    '.duc-modal-x:hover{opacity:1;background:rgba(127,127,127,.15)}',
    '.duc-modal-body{padding:12px 16px 16px;overflow:auto;display:flex;flex-direction:column;gap:12px}',
    '.duc-toolbar{display:flex;align-items:center;gap:8px;font-size:12px;opacity:.75}',
  ].join('\n')
  document.head.appendChild(style)
}

async function api(path, options) {
  const res = await fetch(path, { cache: 'no-store', ...options })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
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
// Shared cross-seat UI state: popup open flag + the lazy badge summary.
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

let uiState = { open: false, everOpened: false, summary: null, generatedAt: null, hideBadge: readBadgePref() }
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

function subscribeUi(notify) {
  uiSubs.add(notify)
  return () => uiSubs.delete(notify)
}

function useUi() {
  // Third arg = getServerSnapshot: identical to the client snapshot, which
  // keeps the component server-renderable (harmless in the browser).
  return useSyncExternalStore(subscribeUi, () => uiState, () => uiState)
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
    api(`/dsh-update-copilot/status${force ? '?force=1' : ''}`)
      .then((data) => {
        setStatus(data)
        setUi({ summary: data.summary, generatedAt: data.generatedAt })
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setBusy(false))
  }, [])

  useEffect(() => { if (active) load(false) }, [active, load])

  const notifyUpdated = useCallback(() => {
    setNeedRestart(true)
    setOpsVersion((v) => v + 1)
    load(true)
  }, [load])

  return { status, error, busy, load, needRestart, opsVersion, notifyUpdated }
}

function RadarIcon() {
  return h('svg', { viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true', fill: 'none' },
    h('circle', { cx: '8', cy: '8', r: '6.2', stroke: 'currentColor', strokeWidth: '1.1' }),
    h('circle', { cx: '8', cy: '8', r: '3', stroke: 'currentColor', strokeWidth: '.9', opacity: '.5' }),
    h('path', { d: 'M8 8 L12.2 3.8', stroke: 'currentColor', strokeWidth: '1.1', strokeLinecap: 'round' }))
}

function KindChip({ t, kind }) {
  const map = { npm: 'kindNpm', github: 'kindGithub', linked: 'kindLinked', file: 'kindFile', git: 'kindGit', other: 'kindOther' }
  return h('span', { className: 'duc-chip' }, t(map[kind] ?? 'kindOther'))
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
}

function localizedUpdateError(t, result) {
  const key = ERROR_CODE_KEYS[result?.code ?? '']
  if (key !== undefined) return t(key)
  return `${t('errFailed')}: ${result?.error ?? ''}`
}

function BriefPanel({ t, profile, name }) {
  const [brief, setBrief] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let cancelled = false
    api(`/dsh-update-copilot/brief?profile=${encodeURIComponent(profile)}&name=${encodeURIComponent(name)}`)
      .then((data) => { if (!cancelled) setBrief(data) })
      .catch((e) => { if (!cancelled) setError(String(e.message ?? e)) })
    return () => { cancelled = true }
  }, [profile, name])

  if (error !== null) return h('div', { className: 'duc-brief duc-error' }, `${t('loadFail')}: ${error}`)
  if (brief === null) return h('div', { className: 'duc-brief' }, t('loading'))
  if (brief.error !== undefined) return h('div', { className: 'duc-brief duc-error' }, brief.error)

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
        m.releases.slice(0, 3).map((r, i) => h('li', { key: i },
          h('a', { href: r.url, target: '_blank', rel: 'noreferrer' }, r.name ?? r.tag),
          r.publishedAt !== undefined ? ` (${fmtDate(r.publishedAt)})` : '')))))
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

// Visual-test hook: set once by the `&brief=1` URL parameter — behind rows
// then start with their decision brief already expanded (screenshot-visible).
let autoBrief = false

function PluginRow({ t, profile, row, onUpdated }) {
  const [open, setOpen] = useState(autoBrief && row.updateAvailable === true)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  const canUpdate = row.updateAvailable && (row.kind === 'npm' || row.kind === 'github')
  const note = row.official ? t('officialNote') : row.kind === 'linked' || row.kind === 'file' ? t('linkedNote') : null

  async function runUpdate() {
    setBusy(true)
    setResult(null)
    try {
      const outcome = await api('/dsh-update-copilot/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile, name: row.name, confirm: true }),
      })
      setResult(outcome)
      if (outcome.ok && outcome.changed) onUpdated()
    } catch (e) {
      setResult({ ok: false, error: String(e.message ?? e) })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return h('div', null,
    h('div', { className: 'duc-row' },
      h('span', { className: 'duc-name' }, row.name),
      h(RepoLink, { t, repo: row.repo, repoUrl: row.repoUrl, npmName: row.kind === 'npm' ? row.name : undefined }),
      h(KindChip, { t, kind: row.kind }),
      h('span', { className: 'duc-ver' },
        h('span', { title: t('current') }, shortVer(row.current)),
        row.updateAvailable ? h(React.Fragment, null,
          h('span', { className: 'duc-arrow' }, ' → '),
          h('span', { title: t('latest') }, shortVer(row.latest))) : null),
      h('span', { className: `duc-badge ${row.updateAvailable ? 'behind' : 'ok'}` },
        row.updateAvailable ? t('behind') : t('upToDate')),
      note !== null ? h('span', { className: 'duc-note' }, note) : null,
      h('span', { className: 'duc-actions' },
        row.updateAvailable ? h('button', { className: 'duc-btn', onClick: () => setOpen(!open), disabled: busy },
          open ? t('hideBrief') : t('brief')) : null,
        canUpdate ? (busy
          ? h('button', { className: 'duc-btn', disabled: true }, t('updating'))
          : h('button', {
              className: `duc-btn ${confirming ? 'danger' : 'primary'}`,
              onClick: () => (confirming ? runUpdate() : setConfirming(true)),
              onBlur: () => setConfirming(false),
            }, confirming ? t('confirmUpdate') : t('update'))) : null)),
    result !== null ? h('div', {
      className: `duc-note ${result.ok ? '' : 'duc-error'}`,
    }, result.ok
      ? (result.changed ? `${t('updated')}` : t('updateNoChange'))
      : localizedUpdateError(t, result)) : null,
    open ? h(BriefPanel, { t, profile, name: row.name }) : null)
}

function CoreCard({ t, core }) {
  const [copied, setCopied] = useState(false)
  const coreRow = core.packages[0]
  function copyCmd() {
    navigator.clipboard?.writeText(core.updateCommand ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return h('div', { className: 'duc-card' },
    h('div', { className: 'duc-card-title' }, t('coreTitle')),
    core.packages.map((p) => h('div', { className: 'duc-row', key: p.name },
      h('span', { className: 'duc-name' }, p.name),
      h(RepoLink, { t, repo: p.repo, repoUrl: p.repoUrl, npmName: p.name }),
      h('span', { className: 'duc-chip' }, p.kind),
      h('span', { className: 'duc-ver' }, shortVer(p.current),
        p.updateAvailable ? h('span', { className: 'duc-arrow' }, ' → ') : null,
        p.updateAvailable ? shortVer(p.latest) : null),
      h('span', { className: `duc-badge ${p.updateAvailable ? 'behind' : 'ok'}` },
        p.updateAvailable ? t('coreBehind') : t('coreCurrent')))),
    core.updateCommand !== null ? h('div', null,
      h('div', { className: 'duc-note' }, t('corePolicy')),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        h('code', { className: 'duc-cmd', style: { flex: 1 } }, core.updateCommand),
        h('button', { className: 'duc-btn', onClick: copyCmd }, copied ? t('copied') : t('copyCmd')))) : null,
    coreRow !== undefined && !coreRow.updateAvailable ? h('div', { className: 'duc-note' }, t('corePolicy')) : null)
}

function ProfileCard({ t, data, onUpdated, compact = false }) {
  const [showOk, setShowOk] = useState(false)
  const behindRows = data.plugins.filter((r) => r.updateAvailable)
  const okRows = data.plugins.filter((r) => !r.updateAvailable)
  const rows = compact ? [...behindRows, ...(showOk ? okRows : [])] : data.plugins

  return h('div', { className: 'duc-card', key: data.profile },
    h('div', { className: 'duc-card-title' },
      `${t('profilesTitle')} — ${data.profile} `,
      h('span', { className: 'duc-note' }, t('scanSummary', { p: data.plugins.length, b: data.behind }))),
    data.plugins.length === 0
      ? h('div', { className: 'duc-note' }, t('noPlugins'))
      : rows.map((row) => h(PluginRow, { t, profile: data.profile, row, key: row.name, onUpdated })),
    compact && okRows.length > 0
      ? h('button', { className: 'duc-fold', onClick: () => setShowOk(!showOk) },
          `${showOk ? '▾' : '▸'} ${t('upToDateFold', { n: okRows.length })}`)
      : null)
}

function LogTail({ t, opsVersion }) {
  const [ops, setOps] = useState(null)
  useEffect(() => {
    let cancelled = false
    api('/dsh-update-copilot/logs')
      .then((data) => { if (!cancelled) setOps(data.ops ?? []) })
      .catch(() => { if (!cancelled) setOps([]) })
    return () => { cancelled = true }
  }, [opsVersion])
  if (ops === null) return null
  const lines = ops.slice(-30)
  return h('div', { className: 'duc-card' },
    h('div', { className: 'duc-card-title' }, t('logs')),
    lines.length === 0
      ? h('div', { className: 'duc-note' }, t('empty'))
      : h('div', { className: 'duc-log' },
        lines.map((op, i) => `${fmtClock(op.at)} [${op.level}] ${op.event} ${op.detail}`).join('\n')))
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

function CopilotSection({ t }) {
  const { status, error, busy, load, needRestart, opsVersion, notifyUpdated } = useCopilotData(true)

  useEffect(() => { injectStyles() }, [])

  return h('div', { className: 'duc' },
    h('div', { className: 'duc-head' },
      h('h2', null, t('nav')),
      h('span', { className: 'duc-sub' }, t('subtitle')),
      status !== null ? h('span', { className: 'duc-meta' },
        `${t('lastScan')}: ${fmtClock(status.generatedAt)}`,
        h('button', { className: 'duc-btn', onClick: () => load(true), disabled: busy },
          busy ? t('rescanning') : t('refresh'))) : null),
    error !== null ? h('div', { className: 'duc-error' }, `${t('loadFail')}: ${error} `,
      h('button', { className: 'duc-btn', onClick: () => load(false) }, t('retry'))) : null,
    needRestart ? h('div', { className: 'duc-banner' }, `ℹ️ ${t('restartHint')}`) : null,
    status === null && error === null ? h('div', { className: 'duc-note' }, t('loading')) : null,
    h('div', { className: 'duc-card', style: { padding: '10px 12px' } }, h(BadgePrefRow, { t })),
    status !== null ? h(CoreCard, { t, core: status.core }) : null,
    status !== null
      ? status.profiles.map((p) => h(ProfileCard, {
          t, data: p, key: p.profile, onUpdated: notifyUpdated,
        }))
      : null,
    h(LogTail, { t, opsVersion }))
}

// ---------------------------------------------------------------------------
// Seat 2: the sidebar foot trigger with the lazy badge.
// ---------------------------------------------------------------------------

function FooterButton({ t, wide }) {
  const ui = useUi()
  useEffect(() => { injectStyles() }, [])
  const behind = ui.summary !== null ? ui.summary.behindPlugins : 0
  const showBadge = ui.everOpened && behind > 0 && ui.hideBadge !== true

  return h('button', {
    className: wide === true ? 'duc-foot-btn' : 'duc-foot-btn duc-rail',
    title: showBadge ? t('badgeTitle', { n: behind }) : t('nav'),
    'aria-label': t('nav'),
    'aria-haspopup': 'dialog',
    onClick: () => setUi({ open: true, everOpened: true }),
  },
    h('span', { className: 'duc-foot-icon' }, RadarIcon()),
    wide === true ? h('span', { className: 'duc-foot-label' }, t('nav')) : null,
    showBadge
      ? h('span', { className: 'duc-foot-badge' }, String(behind))
      : null)
}

// ---------------------------------------------------------------------------
// Seat 3: the popup modal in the shell overlay layer.
// ---------------------------------------------------------------------------

function PopupBody({ t }) {
  const { status, error, busy, load, needRestart, notifyUpdated } = useCopilotData(true)

  return h('div', { className: 'duc' },
    h('div', { className: 'duc-toolbar' },
      status !== null
        ? h(React.Fragment, null,
            `${t('lastScan')}: ${fmtClock(status.generatedAt)}`,
            h('button', { className: 'duc-btn', onClick: () => load(true), disabled: busy },
              busy ? t('rescanning') : t('refresh')))
        : null),
    needRestart ? h('div', { className: 'duc-banner' }, `ℹ️ ${t('restartHint')}`) : null,
    error !== null ? h('div', { className: 'duc-error' }, `${t('loadFail')}: ${error}`) : null,
    status === null && error === null ? h('div', { className: 'duc-note' }, t('loading')) : null,
    status !== null ? h(CoreCard, { t, core: status.core }) : null,
    status !== null
      ? status.profiles.map((p) => h(ProfileCard, {
          t, data: p, key: p.profile, compact: true, onUpdated: notifyUpdated,
        }))
      : null)
}

function CopilotOverlay({ t }) {
  const ui = useUi()
  const modalRef = useRef(null)

  useEffect(() => {
    if (!ui.open) return undefined
    injectStyles()
    modalRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') setUi({ open: false }) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ui.open])

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
      h('div', { className: 'duc-modal-body' }, h(PopupBody, { t }))))
}

exports.name = 'dsh-update-copilot'
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
  // row with its decision brief expanded, so brief-panel changes are
  // screenshot-visible too.
  ctx.effect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const mode = params.get('duc')
      if (params.get('brief') === '1') autoBrief = true
      if (mode === '1') {
        setUi({ open: true, everOpened: true })
      } else if (mode === 'badge') {
        setUi({ everOpened: true, ...(params.get('hide') === '1' ? { hideBadge: true } : {}) })
        fetch('/dsh-update-copilot/status', { cache: 'no-store' })
          .then((res) => res.json())
          .then((data) => setUi({ summary: data.summary, generatedAt: data.generatedAt }))
          .catch(() => {})
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
