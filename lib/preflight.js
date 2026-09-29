/**
 * Pre-flight checks for dsh-update-copilot's update pipeline: the on-disk
 * current dsh version and breaking-change signal extraction.
 *
 * The peer-range warning half that used to live here (declared
 * `peerDependencies` on `@deepseek-ai/*` evaluated against the running /
 * target host with prerelease-correct semver) was removed in 0.12.0 — see
 * docs/adr/0003. A range that reads "fine" can still hide a broken plugin,
 * but the warning it produced named no actionable fix: a plugin whose range
 * excludes the host is broken either way, and the signals that DO name a fix
 * (missing named exports, upgrade-card corridor, session-format boundary)
 * are the hard gates the executor enforces.
 *
 * Hard evidence (target host missing a named import) and the breaking-marker
 * signal attach to the gate in later steps; this module stays a pure,
 * filesystem-only helper with no network and no spawn. Ambiguity is silence:
 * a missing manifest or unreadable file produces no finding.
 */

import { join } from 'node:path'
import { locateDshPackageDir } from './compat.js'
import { profilesRoot, readJson } from './util.js'

/**
 * On-disk dsh version: the install next to the running process first, then
 * the flat profiles-level fallback. Null when neither resolves — callers
 * then skip the current-version check rather than guessing.
 */
export function currentDshVersion(argv1 = process.argv[1]) {
  const dshDir = locateDshPackageDir(argv1, { fallbackFlat: false })
  const version = dshDir !== null ? readJson(join(dshDir, 'package.json'))?.version : null
  if (typeof version === 'string' && version !== '') return version
  const flat = readJson(join(profilesRoot(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  return typeof flat?.version === 'string' ? flat.version : null
}

/**
 * Breaking-change signals over already-fetched changelog material —
 * release bodies/titles and commit subjects. Heuristic and line-level: the
 * matched line IS the evidence. Purely informational; a hit never gates an
 * update, and empty material degrades to no signal.
 */
const CONVENTIONAL_BANG_RE = /^\s*(?:build|ci|docs|feat|fix|perf|refactor|style|test|chore)\s*(?:\([^)]*\))?\s*!:\s*/i
const BREAKING_LINE_RE = /BREAKING[ _-]?CHANGE|breaking|remov\w*|renam\w*|dropp?ed|drops?\b|delet\w*|移除|删除|更名|重命名|废弃/i
const BREAKING_LIMIT = 10

export function breakingFindings(material = {}) {
  const findings = []
  const push = (source, raw) => {
    if (findings.length >= BREAKING_LIMIT) return
    const line = String(raw ?? '').trim().slice(0, 200)
    if (line === '') return
    if (!CONVENTIONAL_BANG_RE.test(line) && !BREAKING_LINE_RE.test(line)) return
    findings.push({ type: 'breaking', source, line, message: line })
  }
  const releases = Array.isArray(material?.releases) ? material.releases : []
  const commits = Array.isArray(material?.commits) ? material.commits : []
  // Commits first — subject lines usually carry the `!:` marker.
  for (const commit of commits) push('commit', commit?.message)
  for (const release of releases) {
    push('release', release?.name)
    for (const line of String(release?.body ?? '').split(/\r?\n/)) push('release', line)
  }
  return findings
}
