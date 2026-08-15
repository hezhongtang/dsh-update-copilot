/**
 * Shared helpers: paths, guarded network fetch, guarded exec, TTL cache, op log.
 * Everything here is importable outside Cordis (plain ESM over node builtins),
 * which keeps the scanner unit-testable with `node -e`.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function profilesRoot() {
  return join(dshHome(), 'profiles')
}

export function profileDir(profile) {
  return join(profilesRoot(), profile)
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * `owner/repo` from any GitHub remote/repo URL form — https, git+https, ssh,
 * git://, and the scp-like `git@github.com:owner/repo.git`. Null otherwise
 * (non-GitHub hosts stay unlinkable rather than guessed).
 */
export function repoFromRemote(url) {
  if (typeof url !== 'string') return null
  const u = url.trim()
  let m = /^(?:git\+)?(?:https?|ssh|git|git\+ssh):\/\/[^/@]*github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/.exec(u)
  if (m === null) m = /^git@github\.com:([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/.exec(u)
  return m !== null ? `${m[1]}/${m[2]}` : null
}

/** `owner/repo` from an npm registry `repository` field (string or .url). */
export function repoOf(repository) {
  if (typeof repository !== 'string' && typeof repository?.url !== 'string') return null
  return repoFromRemote(typeof repository === 'string' ? repository : repository.url)
}

/** Fetch JSON with a hard timeout; failures reject (callers degrade per-item). */
export async function fetchJson(url, timeoutMs = 5000) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-update-copilot' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

/** Run a command, capture stdout, never throw. Returns null on any failure. */
export function execText(cmd, args, options = {}) {
  const { timeoutMs = 15000, cwd } = options
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        resolve(error ? null : String(stdout).trim())
      })
    } catch {
      resolve(null)
    }
  })
}

/** Tiny TTL cache keyed by string; force=true bypasses and refreshes. */
export class TtlCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs
    this.map = new Map()
  }

  get(key, force = false) {
    if (force) return undefined
    const hit = this.map.get(key)
    if (hit === undefined) return undefined
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key)
      return undefined
    }
    return hit.value
  }

  set(key, value) {
    this.map.set(key, { at: Date.now(), value })
  }
}

const opLogEntries = []
const OP_LOG_LIMIT = 200

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parse(v) {
  const m = typeof v === 'string' ? SEMVER_RE.exec(v) : null
  if (m === null) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] !== undefined ? m[4].split('.') : null,
  }
}

/**
 * Full semver precedence compare (semver.org §11, build metadata ignored).
 * Returns >0 when a > b, <0 when a < b, 0 on equal, null when unparsable.
 */
export function semverCompare(a, b) {
  const x = parse(a)
  const y = parse(b)
  if (x === null || y === null) return null
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

/** Append one sanitized operation-log entry (bounded ring). */
export function recordOp(level, event, detail) {
  opLogEntries.push({ at: new Date().toISOString(), level, event, detail: String(detail).slice(0, 2000) })
  if (opLogEntries.length > OP_LOG_LIMIT) opLogEntries.splice(0, opLogEntries.length - OP_LOG_LIMIT)
}

/** Recent op-log entries, newest last. */
export function recentOps() {
  return [...opLogEntries]
}
