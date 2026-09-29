/**
 * Progress model for the update pipeline.
 *
 * The executors stream one normalized `progress` event per meaningful step
 * so every surface (web rows via SSE, the live status poll, the agent-tool
 * log) can render a determinate bar whenever the underlying numbers allow
 * it. Two producers feed the model:
 *
 *  - **pnpm NDJSON** (`dsh plugin … add <target> --reporter=ndjson`): the
 *    only non-TTY output that carries real byte-level download progress
 *    (`pnpm:fetching-progress` events with `downloaded` / `size`), plus
 *    per-package stage transitions. `NdjsonProgressTracker` accumulates
 *    them; `ndjsonLineToText` rewrites error events back into readable
 *    lines for the captured output tail (the fatal-signature matcher keys
 *    on those codes — ERR_PNPM_*, E404 — so reconstruction keeps the
 *    fail-fast classification intact).
 *  - **plain text** (pnpm's append-only reporter, `npm install -g`): only
 *    coarse counters exist, parsed by `parseProgressLine`. Everything
 *    unparsable stays silent — a wrong number is worse than none.
 *
 * Event shape (superset of the legacy `{ percent, phase }`; unknown fields
 * are ignored by older clients):
 *   { percent, phase, done, total, unit, package?, at }
 * `unit` is 'bytes' or 'packages' and tells the client what done/total
 * count; `percent` is null whenever the total is genuinely unknown
 * (indeterminate) — clients must animate instead of inventing a number.
 */

const BYTES_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** 1234567 → '1.2 MB' (binary multiples, one decimal above KB). */
export function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—'
  let value = n
  let unit = 0
  while (value >= 1024 && unit < BYTES_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${BYTES_UNITS[unit]}`
}

/** Count pnpm's coarse `Progress:` counters out of one output line. */
function progressCounters(line) {
  const resolved = /Progress:\s*resolved\s+(\d+)\s*,/.exec(line)
  if (resolved === null) return null
  // The final counter ends the line (or is followed by ", done") — accept
  // both; every counter but the first may be the last one.
  const grab = (label) => {
    const m = new RegExp(`${label}\\s+(\\d+)(?:\\s*,|$)`).exec(line)
    return m !== null ? Number(m[1]) : 0
  }
  return {
    total: Number(resolved[1]),
    reused: grab('reused'),
    downloaded: grab('downloaded'),
    added: grab('added'),
  }
}

/** Parse one plain-text output line into a progress event, or null.
 * Covers pnpm's append-only reporter (`Progress: resolved 12, reused 8,
 * downloaded 4, added 2`) — pnpm's own counter semantics: `resolved`
 * counts every package whose manifest resolved; `reused` / `downloaded` /
 * `added` count the disjoint stage events (found-in-store / fetched /
 * imported), so the packages fully linked into the tree are `added`, and
 * `(resolved → added)` is the honest completion fraction; npm's final
 * summary (`added 120 packages, and audited 121 packages in 12s`), and a
 * stray TTY-spill percentage (`… | 42%`) — nothing else, deliberately.
 */
export function parseProgressLine(line) {
  if (typeof line !== 'string') return null
  const counters = progressCounters(line)
  if (counters !== null) {
    if (counters.total > 0 && counters.added >= counters.total) {
      return { percent: 100, phase: 'done', done: counters.added, total: counters.total, unit: 'packages' }
    }
    let phase = 'resolving'
    if (counters.added > 0) phase = 'linking'
    else if (counters.downloaded > 0) phase = 'downloading'
    return {
      percent: counters.total > 0 ? Math.min(100, Math.round((counters.added / counters.total) * 100)) : null,
      phase,
      done: counters.added,
      total: counters.total,
      unit: 'packages',
    }
  }
  const added = /\badded (\d+) packages?\b/.exec(line)
  if (added !== null) {
    const n = Number(added[1])
    return { percent: 100, phase: 'done', done: n, total: n, unit: 'packages' }
  }
  const pct = /\|\s*(\d{1,3})%/.exec(line)
  if (pct !== null) {
    const n = Number(pct[1])
    if (n >= 0 && n <= 100) return { percent: n, phase: 'downloading' }
  }
  return null
}

/**
 * Parse one pnpm NDJSON line into the tracked event shape, or null when
 * the line is not JSON, not a pnpm event, or not one the tracker uses.
 * Returns one of:
 *   { kind: 'resolved', id }
 *   { kind: 'store-hit', id }
 *   { kind: 'fetched', id }
 *   { kind: 'download-start', id, size }
 *   { kind: 'download-progress', id, downloaded }
 *   { kind: 'stage', stage }
 *   { kind: 'stats', added, removed }
 *   { kind: 'summary' }
 */
export function parseNdjsonEvent(line) {
  if (typeof line !== 'string' || line.startsWith('{') === false) return null
  let event = null
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  if (event === null || typeof event !== 'object' || typeof event.name !== 'string') return null
  const name = event.name
  if (name === 'pnpm:fetching-progress') {
    if (event.status === 'started' && typeof event.packageId === 'string') {
      return { kind: 'download-start', id: event.packageId, size: typeof event.size === 'number' ? event.size : 0 }
    }
    if (event.status === 'in_progress' && typeof event.packageId === 'string') {
      return { kind: 'download-progress', id: event.packageId, downloaded: typeof event.downloaded === 'number' ? event.downloaded : 0 }
    }
    return null
  }
  if (name === 'pnpm:progress' && typeof event.packageId === 'string') {
    if (event.status === 'resolved') return { kind: 'resolved', id: event.packageId }
    if (event.status === 'found_in_store') return { kind: 'store-hit', id: event.packageId }
    if (event.status === 'fetched') return { kind: 'fetched', id: event.packageId }
    if (event.status === 'imported') return { kind: 'linked', id: event.packageId }
    return null
  }
  if (name === 'pnpm:stage') {
    if (event.stage === 'resolution_started') return { kind: 'stage', stage: 'resolving' }
    if (event.stage === 'resolution_done') return { kind: 'stage', stage: 'downloading' }
    if (event.stage === 'importing_started') return { kind: 'stage', stage: 'linking' }
    if (event.stage === 'importing_done') return { kind: 'stage', stage: 'done' }
    return null
  }
  if (name === 'pnpm:stats') {
    const added = typeof event.added === 'number' ? event.added : 0
    const removed = typeof event.removed === 'number' ? event.removed : 0
    return { kind: 'stats', added, removed }
  }
  if (name === 'pnpm:summary') return { kind: 'summary' }
  return null
}

/**
 * Rewrite one pnpm NDJSON line into human-readable text for the captured
 * output, or null to drop it. Error and warn events become
 * `pnpm: <code> <message>` lines — reconstruction keeps the fatal-signature
 * matcher (ERR_PNPM_NO_MATCHING_VERSION, E404, auth refusals) working and
 * the failure tail readable. Every other ndjson event is progress noise
 * and disappears. Non-JSON lines (dsh's own messages, lifecycle-script
 * output) pass through unchanged.
 */
export function ndjsonLineToText(line) {
  if (typeof line !== 'string' || line.startsWith('{') === false) return line
  let event = null
  try {
    event = JSON.parse(line)
  } catch {
    return line // not JSON after all — keep the raw line
  }
  // pnpm's logger names events `pnpm:<channel>`; its own errors use the
  // bare `pnpm` name. Anything else printing JSON passes through.
  if (event === null || typeof event !== 'object'
    || typeof event.name !== 'string'
    || (event.name !== 'pnpm' && event.name.startsWith('pnpm:') === false)) {
    return line
  }
  if (event.level !== 'error' && event.level !== 'warn') return null
  const message = typeof event.err?.message === 'string'
    ? event.err.message
    : (typeof event.msg === 'string' ? event.msg : '')
  const code = typeof event.code === 'string' && event.code !== '' ? event.code : ''
  const head = event.level === 'warn'
    ? 'pnpm: warning'
    : (code !== '' ? `pnpm: ${code}` : 'pnpm')
  const text = message !== '' ? `${head} ${message}` : head
  return text.slice(0, 500)
}

const MIN_EMIT_INTERVAL_MS = 120

/**
 * Accumulates pnpm NDJSON events into normalized progress events.
 *
 * Percent policy per phase, each with the numbers that ARE known:
 *  - resolving: indeterminate (the total is genuinely unknown) — the
 *    label counts the packages resolved so far;
 *  - downloading: bytes received over bytes announced (the only real
 *    determinate phase non-TTY pnpm exposes);
 *  - linking: packages imported over packages resolved;
 *  - done: 100.
 * Emitted percent never goes backwards: newly-started packages grow the
 * known total and would otherwise rewind the bar.
 */
export class NdjsonProgressTracker {
  constructor() {
    this.sizes = new Map() // packageId → tarball bytes
    this.downloaded = new Map() // packageId → bytes received
    this.fetched = new Set()
    this.resolved = new Set()
    this.linked = new Set()
    this.phase = 'resolving'
    this.current = null
    this.lastPercent = 0
    this.lastEmitAt = 0
  }

  /** Bytes known to be coming (sum of started downloads). */
  get knownBytes() {
    let sum = 0
    for (const size of this.sizes.values()) sum += size
    return sum
  }

  /** Bytes already on disk: completed tarballs plus in-flight receipts. */
  get doneBytes() {
    let sum = 0
    for (const id of this.fetched) sum += this.sizes.get(id) ?? 0
    for (const [id, size] of this.sizes) {
      if (this.fetched.has(id)) continue
      sum += Math.min(this.downloaded.get(id) ?? 0, size)
    }
    return sum
  }

  /** Snapshot event for the current state (before throttling). */
  #snapshot(force) {
    const at = Date.now()
    if (force !== true && at - this.lastEmitAt < MIN_EMIT_INTERVAL_MS) return null
    this.lastEmitAt = at
    let percent = null
    let done = null
    let total = null
    let unit = null
    if (this.phase === 'downloading' && this.knownBytes > 0) {
      done = this.doneBytes
      total = this.knownBytes
      unit = 'bytes'
      percent = Math.min(100, Math.round((done / total) * 100))
    } else if (this.phase === 'linking' && this.resolved.size > 0) {
      done = this.linked.size
      total = this.resolved.size
      unit = 'packages'
      percent = Math.min(100, Math.round((done / total) * 100))
    } else if (this.phase === 'resolving' && this.resolved.size > 0) {
      done = this.resolved.size
      unit = 'packages' // total unknown until resolution completes
    }
    if (percent !== null && percent < this.lastPercent) percent = this.lastPercent
    this.lastPercent = percent ?? this.lastPercent
    const event = { percent, phase: this.phase, at }
    if (unit !== null) {
      event.done = done
      event.unit = unit
      if (total !== null) event.total = total
    }
    if (this.current !== null && this.phase === 'downloading') {
      event.package = this.current.replace(/@[^@/]*$/, '')
    }
    return event
  }

  /**
   * Feed one raw output line. Returns a normalized progress event when
   * the state changed meaningfully, else null (unparsable lines, throttled
   * snapshots, and non-progress events never produce an event).
   */
  feed(line) {
    const parsed = parseNdjsonEvent(line)
    if (parsed === null) return null
    switch (parsed.kind) {
      case 'download-start':
        this.sizes.set(parsed.id, parsed.size)
        if (!this.downloaded.has(parsed.id)) this.downloaded.set(parsed.id, 0)
        this.phase = 'downloading'
        this.current = parsed.id
        break
      case 'download-progress':
        this.downloaded.set(parsed.id, parsed.downloaded)
        this.phase = 'downloading'
        this.current = parsed.id
        break
      case 'resolved':
      case 'store-hit':
        this.resolved.add(parsed.id)
        break
      case 'fetched':
        this.fetched.add(parsed.id)
        if (this.sizes.has(parsed.id) && !this.downloaded.has(parsed.id)) {
          this.downloaded.set(parsed.id, this.sizes.get(parsed.id))
        }
        break
      case 'linked':
        this.linked.add(parsed.id)
        break
      case 'stage':
        // resolution_done / importing_started / importing_done always
        // surface — a phase change is information even when throttled.
        this.phase = parsed.stage
        if (parsed.stage === 'done') {
          this.lastPercent = 100
          return { percent: 100, phase: 'done', at: Date.now() }
        }
        return this.#snapshot(true)
      case 'summary':
        this.phase = 'done'
        this.lastPercent = 100
        return { percent: 100, phase: 'done', at: Date.now() }
      default:
        return null
    }
    return this.#snapshot(false)
  }
}
