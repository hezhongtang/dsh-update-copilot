/**
 * Session / workspace storage fingerprint gate.
 *
 * DSH session logs migrate forward only (V3 at 0.1.5, V4 at 0.1.7-alpha).
 * A host jump across a format boundary is data-loss-class: require a
 * snapshot (or explicit force) rather than discovering `no Session format
 * codec` after the fact. Magic-byte sniffing only — never decode.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './util.js'
import { compareDshVersions, normalizeDshVersion, sessionFormatOf } from './cards.js'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary')
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b])

function sniffBuffer(buf) {
  if (buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC)) return 'zstd'
  if (buf.length >= 16 && buf.subarray(0, 16).equals(SQLITE_MAGIC)) return 'sqlite'
  if (buf.length >= 2 && buf.subarray(0, 2).equals(GZIP_MAGIC)) return 'gzip'
  // JSONL / plain text heuristics: starts with `{` after optional whitespace.
  const head = buf.subarray(0, 64).toString('utf8').trimStart()
  if (head.startsWith('{') || head.startsWith('[')) return 'jsonl'
  return 'unknown'
}

/**
 * Best-effort on-disk session store fingerprint under `$DSH_HOME`.
 * @param {string} [home]
 * @returns {{ sessionFormat: string|null, samples: number, paths: string[], projcacheVersion: number|null }}
 */
export function detectStorageFingerprint(home = dshHome()) {
  const paths = []
  const counts = { zstd: 0, sqlite: 0, gzip: 0, jsonl: 0, unknown: 0 }
  let projcacheVersion = null
  const roots = [
    join(home, 'sessions'),
    join(home, 'session'),
    join(home, 'logs'),
    home,
  ]
  const seen = new Set()
  for (const root of roots) {
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (seen.has(ent.name)) continue
      seen.add(ent.name)
      if (/projcache/i.test(ent.name)) {
        // projcache version often rides a directory name like projcache-v3
        const m = /v(\d+)/i.exec(ent.name)
        if (m !== null) projcacheVersion = Number(m[1])
      }
      if (!ent.isFile()) continue
      if (!/\.(jsonl|jsonl\.zst|zst|sqlite|db|log|gz|json)$/i.test(ent.name) && !/session/i.test(ent.name)) continue
      const file = join(root, ent.name)
      try {
        const st = statSync(file)
        if (!st.isFile() || st.size === 0) continue
        const fd = readFileSync(file).subarray(0, 16)
        const kind = sniffBuffer(fd)
        counts[kind] = (counts[kind] ?? 0) + 1
        if (paths.length < 8) paths.push(file)
      } catch { /* unreadable sample — skip */ }
    }
  }
  let sessionFormat = null
  let best = 0
  for (const [kind, n] of Object.entries(counts)) {
    if (kind === 'unknown') continue
    if (n > best) {
      best = n
      sessionFormat = kind
    }
  }
  return { sessionFormat, samples: best, paths, projcacheVersion }
}

/**
 * Compare the on-disk (or declared current) session format family against
 * the target host line. Compatible when equal or target is a forward
 * migration the host itself will perform; incompatible when the target
 * expects an older format than disk (downgrade read) or a forward jump the
 * user has not been warned about.
 * @param {{ currentVersion?: string|null, targetVersion?: string|null, disk?: object|null }} args
 */
export function storageGate({ currentVersion = null, targetVersion = null, disk = null } = {}) {
  const cur = normalizeDshVersion(currentVersion)
  const tgt = normalizeDshVersion(targetVersion)
  if (tgt === null) {
    return { compatible: true, reason: 'no target host version', current: null, target: null }
  }
  const targetFmt = sessionFormatOf(tgt)
  const currentFmt = cur !== null ? sessionFormatOf(cur) : null
  const fingerprint = disk ?? detectStorageFingerprint()
  const onDisk = fingerprint?.sessionFormat ?? null

  if (currentFmt !== null && targetFmt !== null) {
    const cmp = compareDshVersions(targetFmt.atLeast, currentFmt.atLeast)
    if (cmp !== null && cmp > 0) {
      return {
        compatible: false,
        reason: `session format jumps ${currentFmt.sessionFormat} → ${targetFmt.sessionFormat} at dsh ${targetFmt.atLeast} — logs migrate forward only`,
        current: currentFmt.sessionFormat,
        target: targetFmt.sessionFormat,
        projcacheVersion: targetFmt.projcacheVersion,
        disk: onDisk,
        fingerprint,
      }
    }
    if (cmp !== null && cmp < 0) {
      return {
        compatible: false,
        reason: `downgrade would leave session logs at ${currentFmt.sessionFormat} while dsh ${tgt} reads ${targetFmt.sessionFormat} — old builds cannot read newer formats`,
        current: currentFmt.sessionFormat,
        target: targetFmt.sessionFormat,
        disk: onDisk,
        fingerprint,
      }
    }
  }
  return {
    compatible: true,
    reason: 'no session-format boundary in this host hop',
    current: currentFmt?.sessionFormat ?? onDisk,
    target: targetFmt?.sessionFormat ?? null,
    disk: onDisk,
    fingerprint,
  }
}
