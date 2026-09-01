/**
 * Filesystem-only plugin availability verdicts.
 *
 * Answers "will this package load on the next boot" from disk evidence.
 * No loader inventory, no live/restart — those need a running composition.
 * Ambiguity is never broken: unresolvable entries, missing client files, and
 * ESM syntax are silence, not damage.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { cordisEntryId, disablePatchSnippet, entryFromManifest, removeCommand } from './compat.js'
import { readJson } from './util.js'

const RANK = { broken: 0, missing: 1, disabled: 2, inert: 3, ok: 4 }

const MODULE_SYNTAX_ERROR = /Unexpected token 'export'|Unexpected token 'import'|Cannot use import statement outside a module|Cannot use 'import\.meta' outside a module|await is only valid in async functions and the top level bodies of modules/

function bilingual(zh, en) {
  return `${zh} / ${en}`
}

function result(state, reasons, bundle) {
  return { state, reasons, bundle }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * Package directory for one dependency: a link:/file: spec that actually
 * exists on disk wins, otherwise the profile's node_modules entry.
 */
export function packageDirOf(profileDir, name, spec) {
  if (typeof spec === 'string' && (spec.startsWith('link:') || spec.startsWith('file:'))) {
    const dir = spec.replace(/^(link:|file:)/, '')
    if (dir !== '' && existsSync(join(dir, 'package.json'))) return dir
  }
  return join(profileDir, 'node_modules', name)
}

function isLinkedSpec(spec) {
  return typeof spec === 'string' && (spec.startsWith('link:') || spec.startsWith('file:'))
}

function hasDshSurface(pkg) {
  const dsh = pkg?.dsh
  if (dsh === null || dsh === undefined || typeof dsh !== 'object') return false
  return dsh.bundle !== undefined || dsh.client !== undefined
}

/**
 * Client bundle path a package's `exports["./client"]` names, relative to
 * the package root — or null when it cannot be resolved confidently.
 * Unresolvable is not evidence of damage.
 */
export function clientBundlePath(exportsField, depth = 0) {
  if (depth > 4) return null
  if (typeof exportsField === 'string') return exportsField.startsWith('./') ? exportsField : null
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) return null
  const conditions = exportsField
  for (const key of ['browser', 'default']) {
    if (conditions[key] === undefined) continue
    const resolved = clientBundlePath(conditions[key], depth + 1)
    if (resolved !== null) return resolved
  }
  return null
}

/**
 * Compile-only parse of a package's client bundle. Returns `{ ok: true }`
 * unless the file was actually read AND failed as a classic script (ESM
 * syntax is silence).
 */
export function checkClientBundle(packageDir) {
  const pkg = readJson(join(packageDir, 'package.json'))
  if (pkg === null || pkg.dsh?.client === undefined) return { ok: true, reason: null }
  const exportsField = pkg.exports
  const relative = exportsField !== null && typeof exportsField === 'object' && !Array.isArray(exportsField)
    ? clientBundlePath(exportsField['./client'])
    : null
  if (relative === null) return { ok: true, reason: null }
  let source
  try {
    source = readFileSync(join(packageDir, relative), 'utf8')
  } catch {
    return { ok: true, reason: null }
  }
  try {
    new Script(source, { filename: relative })
    return { ok: true, reason: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (MODULE_SYNTAX_ERROR.test(message)) return { ok: true, reason: null }
    return { ok: false, reason: message }
  }
}

/** Row ids the user patch disables (`disabled: true`). */
export function disabledEntryIds(patchText) {
  const ids = []
  if (typeof patchText !== 'string' || patchText === '') return ids
  const lines = patchText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const row = /^- id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/.exec(lines[i])
    if (row === null) continue
    const next = lines[i + 1] ?? ''
    if (/^ {2}disabled:\s*true\s*$/.test(next)) ids.push(row[1])
  }
  return ids
}

/**
 * Filesystem availability verdict for one package in one profile.
 * @param {{ profileDir: string, name: string, spec?: string, inBundles?: boolean }} input
 * @returns {{ state: 'ok'|'missing'|'broken'|'disabled'|'inert', reasons: string, bundle: boolean }}
 */
export function verdictAvailability(input) {
  const profileDir = input?.profileDir
  const name = input?.name
  const spec = input?.spec ?? ''
  const inBundles = input?.inBundles === true
  const bundle = inBundles
  // Mounted children that are not in `dsh.profile.bundles` and not a
  // link:/file: checkout stay out of inLayer — missing entry is only
  // evidence for packages the next boot will try to load as a plugin.
  const inLayer = inBundles || isLinkedSpec(spec)
  const packageDir = packageDirOf(profileDir, name, spec)
  const pkg = readJson(join(packageDir, 'package.json'))

  if (pkg === null) {
    return result('missing', bilingual('未安装', 'not installed'), bundle)
  }

  const entryId = cordisEntryId(packageDir)
  const patchText = readText(join(profileDir, 'cordis.patch.yml'))
  if (entryId !== null && disabledEntryIds(patchText ?? '').includes(entryId)) {
    return result('disabled', bilingual('已在补丁层停用,重启后保持关闭', 'disabled in the patch layer — stays off across restarts'), bundle)
  }

  if (!hasDshSurface(pkg)) {
    if (inLayer) {
      return result('broken', bilingual(
        '处于 bundle 层或本地检出但未声明可加载的 dsh 表面,下次启动会失败',
        'in the bundle layer or a local checkout but declares no loadable dsh surface — the next boot would fail',
      ), bundle)
    }
    return result('inert', bilingual(
      '普通依赖(未声明 dsh 表面),不是 profile 层插件',
      'a plain dependency with no dsh surface — not a profile-layer plugin',
    ), bundle)
  }

  if (inLayer) {
    const entry = entryFromManifest(pkg)
    if (typeof entry === 'string' && entry !== '' && !existsSync(join(packageDir, entry))) {
      return result('broken', bilingual(
        '声明的入口产物缺失(源码检出或构建被拦),下次启动会失败',
        'the declared entry artifact is missing (source-only checkout or blocked build) — the next boot would fail',
      ), bundle)
    }
  }

  const client = checkClientBundle(packageDir)
  if (!client.ok) {
    return result('broken', bilingual(
      `client bundle 解析失败: ${client.reason}`,
      `client bundle failed to parse: ${client.reason}`,
    ), bundle)
  }

  return result('ok', bilingual('可加载', 'loadable'), bundle)
}

/** Worst state among a list; empty → ok. */
export function worstAvailability(states) {
  let worst = 'ok'
  let worstRank = RANK.ok
  for (const state of states ?? []) {
    const rank = RANK[state]
    if (typeof rank === 'number' && rank < worstRank) {
      worst = state
      worstRank = rank
    }
  }
  return worst
}

function emptySummary() {
  return { broken: 0, missing: 0, disabled: 0, inert: 0 }
}

/** Count broken/missing/disabled/inert across scan rows. */
export function summarizeAvailability(rows) {
  const summary = emptySummary()
  for (const row of rows ?? []) {
    const state = row?.availability?.state
    if (state === 'broken' || state === 'missing' || state === 'disabled' || state === 'inert') {
      summary[state] += 1
    }
  }
  return summary
}

function rowKey(row) {
  return `${row?.profile ?? ''}\0${row?.name ?? ''}`
}

function isProblem(state) {
  return state === 'broken' || state === 'missing'
}

/**
 * Name-level before/after: after-rows that are broken/missing and were not
 * already broken/missing for the same profile+name.
 */
export function newlyBrokenOrMissing(before, after) {
  const prior = new Set()
  for (const row of before ?? []) {
    if (isProblem(row?.state)) prior.add(rowKey(row))
  }
  const risks = []
  for (const row of after ?? []) {
    if (!isProblem(row?.state)) continue
    if (prior.has(rowKey(row))) continue
    risks.push({
      profile: row.profile,
      name: row.name,
      state: row.state,
      reasons: row.reasons ?? '',
      ...(row.disablePatch !== undefined ? { disablePatch: row.disablePatch } : {}),
      ...(row.removeCommands !== undefined ? { removeCommands: row.removeCommands } : {}),
    })
  }
  return risks
}

/**
 * Attach `risks` onto an update outcome only when the operation succeeded
 * and actually changed disk state. Empty risks stay absent (lossless-JSON).
 */
export function attachRisks(outcome, before, after) {
  if (outcome === null || typeof outcome !== 'object') return outcome
  if (outcome.ok !== true || outcome.changed !== true) return outcome
  const risks = newlyBrokenOrMissing(before, after)
  if (risks.length === 0) return outcome
  return { ...outcome, risks }
}

/** Disable snippet + uninstall command for one risk row. */
export function availabilityHints(profile, name, packageDir) {
  const hints = {}
  const entryId = typeof packageDir === 'string' ? cordisEntryId(packageDir) : null
  if (entryId !== null) hints.disablePatch = disablePatchSnippet(entryId)
  if (typeof profile === 'string' && typeof name === 'string') {
    hints.removeCommands = [removeCommand(profile, name)]
  }
  return hints
}

/**
 * Snapshot availability for a set of package names in one profile.
 * @returns {Array<{ profile: string, name: string, state: string, reasons: string, disablePatch?: string, removeCommands?: string[] }>}
 */
export function snapshotAvailability(profile, names, { profileDir, deps = {}, bundles = null } = {}) {
  const rows = []
  for (const name of names ?? []) {
    const spec = deps[name] ?? ''
    const inBundles = bundles instanceof Set ? bundles.has(name) : false
    const verdict = verdictAvailability({ profileDir, name, spec, inBundles })
    const packageDir = packageDirOf(profileDir, name, spec)
    const hints = availabilityHints(profile, name, packageDir)
    rows.push({
      profile,
      name,
      state: verdict.state,
      reasons: verdict.reasons,
      ...hints,
    })
  }
  return rows
}

/**
 * Human-readable availability lines for the offline CLI.
 * `lang` starting with `zh` selects Chinese labels; anything else is English.
 */
export function formatAvailabilityReport(summary, rows, lang = 'en') {
  const zh = typeof lang === 'string' && lang.toLowerCase().startsWith('zh')
  const broken = summary?.broken ?? 0
  const missing = summary?.missing ?? 0
  const disabled = summary?.disabled ?? 0
  const inert = summary?.inert ?? 0
  const unreachable = summary?.unreachable
  const lines = []
  lines.push(zh
    ? `可用性：broken=${broken} missing=${missing} disabled=${disabled} inert=${inert}`
    : `availability: broken=${broken} missing=${missing} disabled=${disabled} inert=${inert}`)
  if (typeof unreachable === 'number') {
    lines[0] += ` unreachable=${unreachable}`
  }
  const problems = (rows ?? []).filter((row) => isProblem(row?.availability?.state ?? row?.state))
  for (const row of problems) {
    const state = row.availability?.state ?? row.state
    const reasons = row.availability?.reasons ?? row.reasons ?? ''
    const profile = row.profile ?? '—'
    lines.push(`  ${state}: ${row.name} (${profile}): ${reasons}`)
  }
  if (Array.isArray(summary?.unreachableSources) && summary.unreachableSources.length > 0) {
    lines.push(zh
      ? `不可达源头：${summary.unreachableSources.join(', ')}`
      : `unreachable sources: ${summary.unreachableSources.join(', ')}`)
  }
  return lines.join('\n')
}


