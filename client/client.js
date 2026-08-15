window.__ModuleLoader__.load({ id: "dsh-update-copilot", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-update-copilot client: a Settings section that shows the update status of
 * the DSH core, bundle packages, and every profile plugin. Per-item decision
 * briefs (risk, semver distance, changelog material) expand inline; updates run
 * only after a two-step confirm and report the restart requirement.
 * Hand-authored CJS bundle (no build step); the only external is `react`.
 */

const React = require('react')
const h = React.createElement
const { useState, useEffect, useCallback } = React

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
  'commitsUnit': '个提交',
  noMaterial: '暂无变更详情（可能网络受限或已是最新）',
  officialNote: '官方包随 dsh 本体更新',
  linkedNote: '本地开发链接，请在其仓库内 git pull',
  logs: '操作日志',
  logsCollapse: '收起日志',
  empty: '还没有任何记录',
  scanSummary: '{p} 个插件 · {b} 个可更新',
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
    '.duc-cmd{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;border:1px dashed rgba(127,127,127,.4);border-radius:6px;padding:6px 8px;word-break:break-all}',
    '.duc-banner{border:1px solid rgba(80,140,255,.45);background:rgba(80,140,255,.08);border-radius:8px;padding:8px 12px;font-size:12.5px}',
    '.duc-log{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-all;border:1px solid rgba(127,127,127,.25);border-radius:6px;padding:8px;max-height:220px;overflow:auto;opacity:.85}',
    '.duc-error{color:#c25050}',
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

function KindChip({ t, kind }) {
  const map = { npm: 'kindNpm', github: 'kindGithub', linked: 'kindLinked', file: 'kindFile', git: 'kindGit', other: 'kindOther' }
  return h('span', { className: 'duc-chip' }, t(map[kind] ?? 'kindOther'))
}

function RiskChip({ t, level }) {
  const map = { high: 'riskHigh', medium: 'riskMedium', low: 'riskLow', unknown: 'riskUnknown', none: 'riskNone' }
  return h('span', { className: `duc-badge ${level}` }, `${t('risk')}: ${t(map[level] ?? 'riskUnknown')}`)
}

function SemverSpan({ semver }) {
  if (semver === null || semver === undefined) return null
  const parts = []
  if (semver.major > 0) parts.push(`major ×${semver.major}`)
  if (semver.minor > 0) parts.push(`minor ×${semver.minor}`)
  if (semver.patch > 0) parts.push(`patch ×${semver.patch}`)
  return h('span', { className: 'duc-chip' }, parts.length > 0 ? parts.join(' · ') : '0')
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
    listItems.push(h('li', { key: 'v' },
      h('b', null, `${t('versions')}: `),
      m.versions.map((v) => v.version).join(' ← ')))
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
          r.publishedAt !== undefined ? ` (${String(r.publishedAt).slice(0, 10)})` : '')))))
  }
  if (m.compareUrl !== null && m.compareUrl !== undefined) {
    listItems.push(h('li', { key: 'u' },
      h('a', { href: m.compareUrl, target: '_blank', rel: 'noreferrer' }, t('compare'))))
  }

  return h('div', { className: 'duc-brief' },
    h('div', null, h(RiskChip, { t, level: brief.risk.level }), ' ', h(SemverSpan, { semver: brief.semver })),
    h('div', null, h('b', null, `${t('recommendation')}: `), brief.recommendation),
    m.note !== null && m.note !== undefined ? h('div', { className: 'duc-note' }, m.note) : null,
    listItems.length > 0
      ? h('ul', { className: 'duc-list' }, listItems)
      : h('div', { className: 'duc-note' }, t('noMaterial')))
}

function PluginRow({ t, profile, row, onUpdated }) {
  const [open, setOpen] = useState(false)
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
      : `${t('updateFail')}: ${result.error ?? ''}`) : null,
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

function ProfileCard({ t, data, onUpdated }) {
  return h('div', { className: 'duc-card', key: data.profile },
    h('div', { className: 'duc-card-title' },
      `${t('profilesTitle')} — ${data.profile} `,
      h('span', { className: 'duc-note' }, t('scanSummary', { p: data.plugins.length, b: data.behind }))),
    data.plugins.length === 0
      ? h('div', { className: 'duc-note' }, t('noPlugins'))
      : data.plugins.map((row) => h(PluginRow, { t, profile: data.profile, row, key: row.name, onUpdated })))
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
        lines.map((op, i) => `${op.at.slice(11, 19)} [${op.level}] ${op.event} ${op.detail}`).join('\n')))
}

function CopilotSection({ t }) {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [needRestart, setNeedRestart] = useState(false)
  const [opsVersion, setOpsVersion] = useState(0)

  const load = useCallback((force) => {
    setBusy(true)
    setError(null)
    api(`/dsh-update-copilot/status${force ? '?force=1' : ''}`)
      .then((data) => setStatus(data))
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setBusy(false))
  }, [])

  useEffect(() => { injectStyles(); load(false) }, [load])

  return h('div', { className: 'duc' },
    h('div', { className: 'duc-head' },
      h('h2', null, t('nav')),
      h('span', { className: 'duc-sub' }, t('subtitle')),
      status !== null ? h('span', { className: 'duc-meta' },
        `${t('lastScan')}: ${String(status.generatedAt).slice(11, 19)}`,
        h('button', { className: 'duc-btn', onClick: () => load(true), disabled: busy },
          busy ? t('rescanning') : t('refresh'))) : null),
    error !== null ? h('div', { className: 'duc-error' }, `${t('loadFail')}: ${error} `,
      h('button', { className: 'duc-btn', onClick: () => load(false) }, t('retry'))) : null,
    needRestart ? h('div', { className: 'duc-banner' }, `ℹ️ ${t('restartHint')}`) : null,
    status === null && error === null ? h('div', { className: 'duc-note' }, t('loading')) : null,
    status !== null ? h(CoreCard, { t, core: status.core }) : null,
    status !== null
      ? status.profiles.map((p) => h(ProfileCard, {
          t, data: p, key: p.profile,
          onUpdated: () => { setNeedRestart(true); setOpsVersion((v) => v + 1); load(true) },
        }))
      : null,
    h(LogTail, { t, opsVersion }))
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
}

return module.exports; } });
