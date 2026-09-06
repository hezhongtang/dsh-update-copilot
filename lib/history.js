/**
 * Update history: pre-mutation snapshots and rollback targets.
 *
 * Every update records what was installed before the mutation — version,
 * spec, pinned commit, and the bundle patch text — under the copilot's own
 * directory below $DSH_HOME (never inside a profile), keeping the newest
 * snapshots per package. Rolling back is then just an update with the
 * recorded old target through the normal confirmed update flow: no second
 * mutating route, no new trust surface. The writer is best-effort: a
 * refusing disk degrades to no history and never blocks an update.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, recordOp, semverCompare } from './util.js'

const KEEP_PER_PACKAGE = 10

const NPM_TARGET_RE = /^([\w@][\w.@/-]*?)@([0-9A-Za-z][0-9A-Za-z._-]*)$/
const GITHUB_TARGET_RE = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(#[^\s]*)?$/

/**
 * Filesystem-safe directory segment for a profile/package name. Scoped
 * packages flatten (`@scope/pkg` → `@scope__pkg`); anything that could
 * escape the history directory is rejected.
 */
export function sanitizeName(name) {
  const safe = String(name ?? '').replace(/\//g, '__')
  return safe !== '' && !safe.includes('..') && /^[A-Za-z0-9@._-]+$/.test(safe) ? safe : null
}

export function historyRoot() {
  return join(dshHome(), 'dsh-update-copilot', 'history')
}

/**
 * Persist one pre-mutation snapshot. Fields: at, profile, name, target,
 * before {version, spec, commit}, patch {path, fingerprint, text} | null.
 * Returns the snapshot file path, or null when nothing could be written.
 */
export function recordUpdateSnapshot({ profile, name, target = null, before = {}, patch = null, at = new Date().toISOString() }) {
  try {
    const safeProfile = sanitizeName(profile)
    const safeName = sanitizeName(name)
    if (safeProfile === null || safeName === null) return null
    const dir = join(historyRoot(), safeProfile, safeName)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${at.replace(/[:.]/g, '-')}.json`)
    writeFileSync(file, JSON.stringify({ at, profile, name, target, before, ...(patch !== null ? { patch } : {}) }))
    pruneSnapshots(dir)
    return file
  } catch (error) {
    recordOp('warn', 'update:history', `${profile}/${name}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/** Keep only the newest KEEP_PER_PACKAGE snapshot files in one directory. */
function pruneSnapshots(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  for (const stale of files.slice(0, Math.max(0, files.length - KEEP_PER_PACKAGE))) {
    try { rmSync(join(dir, stale)) } catch { /* best effort */ }
  }
}

/** Snapshots of one profile/package, newest first. Missing history → []. */
export function listSnapshots(profile, name) {
  try {
    const safeProfile = sanitizeName(profile)
    const safeName = sanitizeName(name)
    if (safeProfile === null || safeName === null) return []
    const dir = join(historyRoot(), safeProfile, safeName)
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse()
      .flatMap((f) => {
        try { return [JSON.parse(readFileSync(join(dir, f), 'utf8'))] } catch { return [] }
      })
  } catch {
    return []
  }
}

/** Profile names that have at least one snapshot. */
export function listHistoryProfiles() {
  try {
    return readdirSync(historyRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/** Package names with snapshots under one profile. */
export function listHistoryPackages(profile) {
  const safeProfile = sanitizeName(profile)
  if (safeProfile === null) return []
  try {
    return readdirSync(join(historyRoot(), safeProfile), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/**
 * Rollback target derived from a snapshot: the exact npm version, or the
 * github spec pinned to the previous commit. link:/file: checkouts have no
 * re-installable target — the CLI prints the git command instead. Null when
 * nothing safe to derive.
 */
export function rollbackTargetOf(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return null
  const before = snapshot.before ?? {}
  const spec = typeof before.spec === 'string' ? before.spec : ''
  const commit = typeof before.commit === 'string' && /^[0-9a-f]{40}$/.test(before.commit) ? before.commit : null
  const m = /^(?:github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#.*)?$/.exec(spec)
  if (m !== null) {
    // The github channel reinstalls from the pinned old commit — a version
    // reinstall would silently switch the dependency to the npm channel.
    if (commit === null) return null
    return { channel: 'github', target: `github:${m[1]}#${commit}` }
  }
  if (spec.startsWith('link:') || spec.startsWith('file:')) {
    const dir = spec.replace(/^(link:|file:)/, '')
    if (commit === null || dir === '') return null
    return { channel: 'linked', command: `git -C ${dir} checkout ${commit}` }
  }
  const version = typeof before.version === 'string' && before.version !== '' ? before.version : null
  if (version !== null && typeof snapshot.name === 'string' && semverCompare(version, version) !== null) {
    return { channel: 'npm', target: `${snapshot.name}@${version}` }
  }
  return null
}

/**
 * Attach a rollback suggestion onto an update outcome that actually changed
 * disk state. Empty when the snapshot is missing or no safe target exists.
 */
export function attachRollback(outcome, snapshot) {
  if (outcome === null || typeof outcome !== 'object' || outcome.changed !== true) return outcome
  if (snapshot === null || typeof snapshot !== 'object') return outcome
  const rollback = rollbackTargetOf(snapshot)
  if (rollback === null) return outcome
  return { ...outcome, rollback: { ...rollback, at: snapshot.at, profile: snapshot.profile, name: snapshot.name } }
}

/**
 * Validate an explicitly requested update target (the rollback path) against
 * the package being updated: an npm target must address exactly that package
 * (`name@version` — anything else would make pnpm install a different
 * package), a github target must stay on the same repo and keep a pin.
 * Returns { target, targetVersion, repoKey } or null when rejected.
 */
export function validateRollbackTarget(name, spec, target) {
  if (typeof name !== 'string' || typeof target !== 'string' || target === '') return null
  const npm = NPM_TARGET_RE.exec(target)
  if (npm !== null) {
    if (npm[1] !== name) return null
    const version = npm[2]
    if (semverCompare(version, version) === null) return null
    return { target, targetVersion: version, repoKey: null }
  }
  const gh = GITHUB_TARGET_RE.exec(target)
  if (gh !== null) {
    const specRepo = /^(?:github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#.*)?$/.exec(typeof spec === 'string' ? spec : '')
    if (specRepo === null || specRepo[1].toLowerCase() !== gh[1].toLowerCase()) return null
    if (typeof gh[2] !== 'string' || gh[2] === '#' || gh[2] === '#path:') return null
    const repoKey = `${gh[1].toLowerCase()}${gh[2]}`
    return { target, targetVersion: null, repoKey }
  }
  return null
}
