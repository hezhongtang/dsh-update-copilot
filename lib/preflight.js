/**
 * Pre-flight checks for dsh-update-copilot's update pipeline: peer-range
 * warnings against the dsh host versions.
 *
 * A dsh upgrade can leave a plugin's declared `peerDependencies` behind:
 * under 0.x prerelease semver the range still *looks* fine while it no longer
 * admits the running (or target) host — the exact class that bricks profiles
 * at boot and that users cannot read from the version strings. This module
 * is the warning half of the gate family: pure evaluation over manifests,
 * filesystem reads only, no network, no spawn. Ambiguity is silence: an
 * unparsable range (workspace:/catalog: placeholders), an unknown version,
 * or a missing manifest produce no finding, never a false alarm.
 *
 * Hard evidence (target host missing a named import) and the breaking-marker
 * signal attach to the same warning shape in later gate tickets.
 */
import { join } from 'node:path'
import { locateDshPackageDir } from './compat.js'
import { profilesRoot, readJson } from './util.js'

const VERSION_RE = /^v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Parse one version/spec segment, preserving wildcard and absence so ranges
 * like `1.2` (means `1.2.x`) and `1.x` expand correctly.
 */
function parseVersion(text) {
  const m = typeof text === 'string' ? VERSION_RE.exec(text.trim()) : null
  if (m === null) return null
  return {
    major: m[1], minor: m[2], patch: m[3], pre: m[4] !== undefined ? m[4].split('.') : null,
  }
}

function numeric(part) {
  if (typeof part === 'number') return part
  return typeof part === 'string' && /^\d+$/.test(part) ? Number(part) : null
}

/** Coerce a parsed segment into fully numeric form (wildcards → 0). */
function tuple(v) {
  return {
    major: numeric(v.major) ?? 0,
    minor: numeric(v.minor) ?? 0,
    patch: numeric(v.patch) ?? 0,
    pre: v.pre,
  }
}

function nextMajor(v) { return { major: String(numeric(v.major) + 1), minor: '0', patch: '0', pre: null } }
function nextMinor(v) { return { major: v.major, minor: String(numeric(v.minor) + 1), patch: '0', pre: null } }
function nextPatch(v) { return { major: v.major, minor: v.minor, patch: String(numeric(v.patch) + 1), pre: null } }

function isWildcard(part) {
  return part === undefined || part === '*' || part === 'x' || part === 'X'
}

/**
 * Full semver precedence between two parsed versions (semver.org §11; build
 * metadata ignored, wildcards coerced to 0 — they never survive expansion
 * except as interval floors).
 */
function compareVersions(a, b) {
  const x = tuple(a)
  const y = tuple(b)
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] - y[key]
  }
  if (x.pre === null && y.pre === null) return 0
  if (x.pre === null) return 1 // release outranks prerelease
  if (y.pre === null) return -1
  const len = Math.min(x.pre.length, y.pre.length)
  for (let i = 0; i < len; i += 1) {
    const xi = x.pre[i]
    const yi = y.pre[i]
    const xn = /^\d+$/.test(xi)
    const yn = /^\d+$/.test(yi)
    if (xn && yn) {
      if (Number(xi) !== Number(yi)) return Number(xi) - Number(yi)
    } else if (xn) return -1 // numeric identifiers rank lower
    else if (yn) return 1
    else if (xi !== yi) return xi < yi ? -1 : 1
  }
  return x.pre.length - y.pre.length
}

/** `^1.2.3` → `>=1.2.3 <2.0.0`, with the 0.x minor-lock (0.0.x patch-lock) rule. */
function caretComparators(v) {
  if (numeric(v.major) !== 0) return [{ op: '>=', v: tuple(v) }, { op: '<', v: tuple(nextMajor(v)) }]
  if (isWildcard(v.minor)) return [{ op: '>=', v: tuple(v) }, { op: '<', v: tuple(nextMajor(v)) }]
  if (numeric(v.minor) !== 0 || isWildcard(v.patch)) return [{ op: '>=', v: tuple(v) }, { op: '<', v: tuple(nextMinor(v)) }]
  return [{ op: '>=', v: tuple(v) }, { op: '<', v: tuple(nextPatch(v)) }]
}

/** `~1.2.3` → `>=1.2.3 <1.3.0`; `~1` / `~1.x` float the minor like `^1`. */
function tildeComparators(v) {
  if (isWildcard(v.minor)) return [{ op: '>=', v: tuple(v) }, { op: '<', v: tuple(nextMajor(v)) }]
  return [{ op: '>=', v: tuple(v) }, { op: '<', v: tuple(nextMinor(v)) }]
}

/** `1.x` / `1.2.*` / bare `1` / bare `1.2` → interval comparators. */
function wildcardComparators(v) {
  if (isWildcard(v.major)) return [] // unconstrained
  if (isWildcard(v.minor)) return [{ op: '>=', v: tuple({ major: v.major, minor: '0', patch: '0' }) }, { op: '<', v: tuple(nextMajor(v)) }]
  return [{ op: '>=', v: tuple({ major: v.major, minor: v.minor, patch: '0' }) }, { op: '<', v: tuple(nextMinor(v)) }]
}

const OPS = ['>=', '<=', '>', '<', '=']

function parseComparator(text) {
  const raw = text.trim()
  if (raw === '') return null
  let op = '='
  let rest = raw
  for (const candidate of OPS) {
    if (raw.startsWith(candidate)) {
      op = candidate
      rest = raw.slice(candidate.length)
      break
    }
  }
  const v = parseVersion(rest)
  if (v === null) return null
  if (isWildcard(v.major) && op === '=') return { unconstrained: true }
  if (isWildcard(v.major) || isWildcard(v.minor) || isWildcard(v.patch)) {
    if (op === '=') return { comparators: wildcardComparators(v) }
    if (op === '>=' || op === '>') return { comparators: [{ op, v: tuple(v) }] }
    return null // `<1.x`, `<=2` — genuinely ambiguous, stay silent
  }
  if (op === '=') {
    // A bare version matches exactly (build metadata aside): 0.1.2-rc.1 is
    // NOT 0.1.2 — the prerelease ranks below the release.
    return { comparators: [{ op: '=', v: tuple(v) }] }
  }
  return { comparators: [{ op, v: tuple(v) }] }
}

/**
 * Parse a range into a union of comparator sets, or null when the range is
 * not one this module evaluates (workspace:/catalog: placeholders, garbage).
 * An unconstrained range (`*`, `x`) parses to `{ unconstrained: true }` and
 * matches every version, prereleases included — an empty constraint cannot
 * mismatch, so warning about it would only be noise.
 */
export function parseRange(range) {
  if (typeof range !== 'string' || range.trim() === '') return null
  const union = []
  for (const branch of range.split('||')) {
    const parts = branch.trim().split(/\s+/).filter((p) => p !== '')
    if (parts.length === 0) return null
    const comparators = []
    for (const part of parts) {
      if (part === '*' || part === 'x' || part === 'X') return { unconstrained: true }
      if (part.startsWith('^') || part.startsWith('~')) {
        const v = parseVersion(part.slice(1))
        if (v === null) return null
        comparators.push(...(part.startsWith('^') ? caretComparators(v) : tildeComparators(v)))
        continue
      }
      const parsed = parseComparator(part)
      if (parsed === null) return null
      if (parsed.unconstrained === true) return { unconstrained: true }
      comparators.push(...parsed.comparators)
    }
    union.push(comparators)
  }
  return { union }
}

function comparatorSatisfied(comparator, version) {
  const cmp = compareVersions(version, comparator.v)
  if (comparator.op === '>=') return cmp >= 0
  if (comparator.op === '<=') return cmp <= 0
  if (comparator.op === '>') return cmp > 0
  if (comparator.op === '<') return cmp < 0
  return cmp === 0
}

/**
 * node-semver prerelease rule: a prerelease version satisfies a comparator
 * set only when some comparator in the set carries a prerelease on the same
 * [major, minor, patch] tuple. `^0.1.2-alpha.1` admits `0.1.2-rc.1` but not
 * `0.1.3-alpha.1`; `^0.1.2` admits no prerelease at all.
 */
function setAllowsPrerelease(comparators, version) {
  return comparators.some((c) => c.v.pre !== null
    && c.v.major === version.major && c.v.minor === version.minor && c.v.patch === version.patch)
}

/**
 * Does `version` satisfy `range`? Returns true/false, or null when either
 * side is unparsable — callers treat null as "cannot evaluate" (silence).
 */
export function satisfiesRange(range, version) {
  const parsed = parseRange(range)
  if (parsed === null) return null
  const v = parseVersion(version)
  if (v === null || numeric(v.major) === null || numeric(v.minor) === null || numeric(v.patch) === null) return null
  const full = tuple(v)
  if (parsed.unconstrained === true) return true
  for (const comparators of parsed.union) {
    if (comparators.length === 0) return true
    if (!comparators.every((c) => comparatorSatisfied(c, full))) continue
    if (full.pre !== null && !setAllowsPrerelease(comparators, full)) continue
    return true
  }
  return false
}

/**
 * Peer-range findings for one plugin manifest against one or more host
 * versions. Only `@deepseek-ai/*` peers are evaluated — everything else is
 * outside the harness contract. Findings carry the evidence fields; wording
 * stays with the consumers (client i18n, CLI formatter).
 * @param {{ name?: string|null, peerDependencies?: Record<string, string>, versions: Array<{ role: 'current'|'target', version: string|null }> }} args
 * @returns {Array<{ plugin: string|null, type: 'peer', specifier: string, range: string, against: string, version: string }>}
 */
export function peerRangeFindings({ name = null, peerDependencies, versions }) {
  const findings = []
  for (const [specifier, range] of Object.entries(peerDependencies ?? {})) {
    if (typeof range !== 'string') continue
    if (!specifier.startsWith('@deepseek-ai/')) continue
    for (const { role, version } of versions ?? []) {
      if (typeof version !== 'string' || version === '') continue
      const satisfied = satisfiesRange(range, version)
      if (satisfied !== false) continue
      findings.push({
        plugin: name,
        type: 'peer',
        specifier,
        range,
        against: role,
        version,
      })
    }
  }
  return findings
}

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
 * Host version roles for the peer check from a core scan row: the running
 * version as `current`, and — only when the core is actually behind — the
 * upgrade target as `target`. A stale `latest` dist-tag must not read as a
 * target.
 */
export function hostVersionsFromCore(core, fallbackCurrent = null) {
  const coreRow = core?.packages?.[0]
  const current = typeof coreRow?.current === 'string' && coreRow.current !== '' ? coreRow.current : fallbackCurrent
  const target = coreRow?.updateAvailable === true && typeof coreRow?.latest === 'string' ? coreRow.latest : null
  const versions = []
  if (typeof current === 'string' && current !== '') versions.push({ role: 'current', version: current })
  if (typeof target === 'string' && target !== '') versions.push({ role: 'target', version: target })
  return versions
}

/**
 * Peer warnings for one installed package directory (the manifest's
 * `peerDependencies`) against the given host versions. Missing manifests
 * degrade to no warnings.
 * @param {string} packageDir
 * @param {Array<{ role: string, version: string }>} versions
 */
export function peerWarningsForPackageDir(packageDir, versions) {
  if (typeof packageDir !== 'string' || packageDir === '' || !Array.isArray(versions) || versions.length === 0) return []
  const pkg = readJson(join(packageDir, 'package.json'))
  if (pkg === null) return []
  return peerRangeFindings({ name: pkg.name ?? null, peerDependencies: pkg.peerDependencies, versions })
}
