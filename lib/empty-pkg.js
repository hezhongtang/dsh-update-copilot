/**
 * Empty / unpublishable registry version detector.
 *
 * `@deepseek-ai/dsh-*` (and some community monorepos) freeze the `latest`
 * dist-tag on an empty 0.0.1-rc.1 build: no entry, no dsh.bundle, tiny
 * unpacked size. Resolving that version as an update target installs a
 * husk and then fails with a misleading "does not provide an export named".
 * Callers must pin a real version — never the empty one.
 */

/**
 * Does one registry version document look like a real installable package?
 * Conservative (宁漏拦不错拦): a husk is only declared when the packument
 * row is obviously empty — a tiny tarball, or no entry surface at all on a
 * row that at least carries `dist`. Sparse rows (tests, partial docs) stay
 * "not empty".
 * @param {object} versionMeta - `doc.versions[version]` from the npm packument.
 */
export function looksEmptyPackage(versionMeta) {
  if (versionMeta === null || typeof versionMeta !== 'object') return true
  const hasDsh = versionMeta.dsh !== undefined && versionMeta.dsh !== null
  const hasEntry = Boolean(
    (typeof versionMeta.main === 'string' && versionMeta.main !== '')
    || versionMeta.exports !== undefined
    || versionMeta.bin !== undefined
    || versionMeta.module !== undefined
    || hasDsh,
  )
  const size = versionMeta.dist?.unpackedSize
  // Tiny tarball is the reliable husk signal (the frozen latest=0.0.1-rc.1 family).
  if (typeof size === 'number' && Number.isFinite(size) && size >= 0 && size < 64) return true
  // Published row with dist but no entry surface and a near-empty archive.
  if (!hasEntry && versionMeta.dist !== undefined && (size === undefined || (typeof size === 'number' && size < 256))) return true
  return false
}

/**
 * Pick the highest version that is not an empty husk.
 * @param {Record<string, object>} versions - packument `versions` map.
 * @param {(a: string, b: string) => number|null} compare
 * @returns {{ version: string|null, skippedEmpty: string[], meta: object|null }}
 */
export function newestHealthyVersion(versions, compare) {
  const skippedEmpty = []
  let best = null
  let bestMeta = null
  for (const [v, meta] of Object.entries(versions ?? {})) {
    if (compare(v, v) !== 0) continue // unparsable
    if (looksEmptyPackage(meta)) {
      skippedEmpty.push(v)
      continue
    }
    if (best === null || (compare(v, best) ?? -1) > 0) {
      best = v
      bestMeta = meta
    }
  }
  return { version: best, skippedEmpty, meta: bestMeta }
}

/**
 * Update-gate decision for a resolved npm target.
 * @param {{ name: string, targetVersion: string|null, versionMeta: object|null, distLatest: string|null, distLatestMeta: object|null }} args
 */
export function emptyTargetGate({ name, targetVersion, versionMeta = null, distLatest = null, distLatestMeta = null } = {}) {
  if (targetVersion !== null && versionMeta !== null && looksEmptyPackage(versionMeta)) {
    return {
      blocked: true,
      code: 'empty_target',
      message: `${name}@${targetVersion} looks like an empty publish (no entry / no dsh.bundle / tiny tarball) — pin a real version instead`,
    }
  }
  if (targetVersion === null && distLatest !== null && distLatestMeta !== null && looksEmptyPackage(distLatestMeta)) {
    return {
      blocked: true,
      code: 'empty_latest',
      message: `${name} dist-tag latest=${distLatest} is an empty publish — install with an explicit version or next/alpha tag, never bare latest`,
    }
  }
  return { blocked: false, code: null, message: null }
}
