// Progress model (lib/progress.js): the event shapes the update pipeline
// streams to the web panel, the agent-tool log, and the live status poll.
//
// Two producers: pnpm's NDJSON reporter (the byte-level download progress
// the panel renders as a determinate bar) and plain-text lines (pnpm's
// coarse Progress counters, npm's final summary). The tests pin the
// semantics — percent only when a total is really known, monotonic percent,
// event-to-text reconstruction that keeps the fatal-signature matcher
// working — plus the byte formatter.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NdjsonProgressTracker,
  formatBytes,
  ndjsonLineToText,
  parseNdjsonEvent,
  parseProgressLine,
} from '../lib/progress.js'

const ndjson = (obj) => JSON.stringify(obj)

// ---------------------------------------------------------------------------
// Plain-text lines (pnpm append-only reporter / npm)
// ---------------------------------------------------------------------------

test('parseProgressLine reads pnpm counters with pnpm semantics', () => {
  // resolved is the denominator; `added` (imported) is the numerator.
  const early = parseProgressLine('Progress: resolved 305, reused 240, downloaded 0, added 0')
  assert.deepEqual(early, { percent: 0, phase: 'resolving', done: 0, total: 305, unit: 'packages' })

  const fetching = parseProgressLine('Progress: resolved 305, reused 240, downloaded 65, added 0')
  assert.deepEqual(fetching, { percent: 0, phase: 'downloading', done: 0, total: 305, unit: 'packages' })

  const linking = parseProgressLine('Progress: resolved 305, reused 240, downloaded 65, added 65')
  assert.deepEqual(linking, { percent: 21, phase: 'linking', done: 65, total: 305, unit: 'packages' })

  const done = parseProgressLine('Progress: resolved 8, reused 0, downloaded 8, added 8, done')
  assert.deepEqual(done, { percent: 100, phase: 'done', done: 8, total: 8, unit: 'packages' })
})

test('parseProgressLine reads the npm summary and a stray TTY percentage', () => {
  const summary = parseProgressLine('added 120 packages, and audited 121 packages in 12s')
  assert.deepEqual(summary, { percent: 100, phase: 'done', done: 120, total: 120, unit: 'packages' })
  assert.deepEqual(parseProgressLine('⠴ happy-bird: reify ### | 42%'), { percent: 42, phase: 'downloading' })
})

test('parseProgressLine stays silent on noise', () => {
  for (const line of ['', 'dsh: warning: something', 'Packages: +8', '++++++++', null, 7]) {
    assert.equal(parseProgressLine(line), null, `expected silence for ${JSON.stringify(line)}`)
  }
})

test('formatBytes uses binary multiples with one decimal above bytes', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(15439), '15.1 KB')
  assert.equal(formatBytes(9270373), '8.8 MB')
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(-1), '—')
  assert.equal(formatBytes(NaN), '—')
})

// ---------------------------------------------------------------------------
// NDJSON event parsing + the output reconstruction
// ---------------------------------------------------------------------------

test('parseNdjsonEvent maps only the tracked pnpm events', () => {
  assert.deepEqual(parseNdjsonEvent(ndjson({ name: 'pnpm:progress', packageId: 'a@1', status: 'resolved' })), { kind: 'resolved', id: 'a@1' })
  assert.deepEqual(parseNdjsonEvent(ndjson({ name: 'pnpm:progress', packageId: 'a@1', status: 'found_in_store' })), { kind: 'store-hit', id: 'a@1' })
  assert.deepEqual(parseNdjsonEvent(ndjson({ name: 'pnpm:progress', packageId: 'a@1', status: 'fetched' })), { kind: 'fetched', id: 'a@1' })
  assert.deepEqual(parseNdjsonEvent(ndjson({ name: 'pnpm:progress', packageId: 'a@1', status: 'imported' })), { kind: 'linked', id: 'a@1' })
  assert.deepEqual(parseNdjsonEvent(ndjson({ name: 'pnpm:fetching-progress', packageId: 'a@1', size: 10, status: 'started' })), { kind: 'download-start', id: 'a@1', size: 10 })
  assert.deepEqual(parseNdjsonEvent(ndjson({ name: 'pnpm:fetching-progress', packageId: 'a@1', downloaded: 5, status: 'in_progress' })), { kind: 'download-progress', id: 'a@1', downloaded: 5 })
  assert.deepEqual(parseNdjsonEvent(ndjson({ name: 'pnpm:stage', stage: 'resolution_started' })), { kind: 'stage', stage: 'resolving' })
  assert.deepEqual(parseNdjsonEvent(ndjson({ name: 'pnpm:stage', stage: 'importing_started' })), { kind: 'stage', stage: 'linking' })
  assert.deepEqual(parseNdjsonEvent(ndjson({ name: 'pnpm:summary' })), { kind: 'summary' })
  // Untracked events and non-JSON lines are noise.
  assert.equal(parseNdjsonEvent(ndjson({ name: 'pnpm:link', target: 'x' })), null)
  assert.equal(parseNdjsonEvent(ndjson({ name: 'pnpm:progress', packageId: 'a@1', status: 'whatever' })), null)
  assert.equal(parseNdjsonEvent('Progress: resolved 1, reused 0, downloaded 0, added 0'), null)
  assert.equal(parseNdjsonEvent('{"not json'), null)
  assert.equal(parseNdjsonEvent(null), null)
})

test('ndjsonLineToText reconstructs error lines and drops event noise', () => {
  // The fatal-signature matcher keys on these codes — they must survive.
  const fatal = ndjsonLineToText(ndjson({
    level: 'error', name: 'pnpm', code: 'ERR_PNPM_NO_MATCHING_VERSION',
    err: { name: 'pnpm', message: 'No matching version found for left-pad@999.999.999', code: 'ERR_PNPM_NO_MATCHING_VERSION' },
  }))
  assert.match(fatal, /^pnpm: ERR_PNPM_NO_MATCHING_VERSION No matching version found/)

  const auth = ndjsonLineToText(ndjson({
    level: 'error', name: 'pnpm', code: 'ERR_PNPM_FETCH_401',
    err: { message: 'GET https://registry.npmjs.org/x: 401 Unauthorized' },
  }))
  assert.match(auth, /401 Unauthorized/)

  const warn = ndjsonLineToText(ndjson({ level: 'warn', name: 'pnpm', msg: 'lockfile-verified cache: append failed' }))
  assert.match(warn, /^pnpm: warning lockfile-verified cache/)

  // Debug progress events are noise for the captured tail — dropped.
  assert.equal(ndjsonLineToText(ndjson({ level: 'debug', name: 'pnpm:progress', packageId: 'a@1', status: 'resolved' })), null)
  // Non-JSON lines (dsh's own messages, lifecycle-script output) pass through.
  assert.equal(ndjsonLineToText('dsh: warning: pinned name is gone'), 'dsh: warning: pinned name is gone')
  assert.equal(ndjsonLineToText('Progress: resolved 1, reused 0, downloaded 0, added 0'), 'Progress: resolved 1, reused 0, downloaded 0, added 0')
  // JSON that is not a pnpm event (a script printing an object) passes through.
  assert.equal(ndjsonLineToText('{"hello":"world"}'), '{"hello":"world"}')
  // An error event without a message still yields a code line.
  assert.equal(ndjsonLineToText(ndjson({ level: 'error', name: 'pnpm', code: 'ERR_PNPM_UNEXPECTED_STORE' })), 'pnpm: ERR_PNPM_UNEXPECTED_STORE')
})

// ---------------------------------------------------------------------------
// The tracker: the event sequence a real capture produces
// ---------------------------------------------------------------------------

/** Feed lines spaced past the 120ms emit throttle, collecting the events. */
async function feed(lines) {
  const tracker = new NdjsonProgressTracker()
  const events = []
  for (const line of lines) {
    const event = tracker.feed(line)
    if (event !== null) events.push(event)
    await new Promise((r) => setTimeout(r, 130))
  }
  return events
}

test('tracker walks resolving → downloading (bytes) → linking → done', async () => {
  const events = await feed([
    ndjson({ name: 'pnpm:stage', stage: 'resolution_started' }),
    ndjson({ name: 'pnpm:progress', packageId: 'left-pad@1.3.0', status: 'resolved' }),
    ndjson({ name: 'pnpm:progress', packageId: 'typescript@7.0.2', status: 'resolved' }),
    ndjson({ name: 'pnpm:progress', packageId: '@ts/darwin-arm64@1.0.0', status: 'resolved' }),
    ndjson({ name: 'pnpm:stage', stage: 'resolution_done' }),
    ndjson({ name: 'pnpm:fetching-progress', packageId: '@ts/darwin-arm64@1.0.0', size: 10000, status: 'started' }),
    ndjson({ name: 'pnpm:fetching-progress', packageId: '@ts/darwin-arm64@1.0.0', downloaded: 2500, status: 'in_progress' }),
    ndjson({ name: 'pnpm:fetching-progress', packageId: '@ts/darwin-arm64@1.0.0', downloaded: 7500, status: 'in_progress' }),
    ndjson({ name: 'pnpm:progress', packageId: '@ts/darwin-arm64@1.0.0', status: 'fetched' }),
    ndjson({ name: 'pnpm:progress', packageId: 'left-pad@1.3.0', status: 'found_in_store' }),
    ndjson({ name: 'pnpm:progress', packageId: 'typescript@7.0.2', status: 'found_in_store' }),
    ndjson({ name: 'pnpm:stage', stage: 'importing_started' }),
    ndjson({ name: 'pnpm:progress', packageId: 'left-pad@1.3.0', status: 'imported' }),
    ndjson({ name: 'pnpm:progress', packageId: 'typescript@7.0.2', status: 'imported' }),
    ndjson({ name: 'pnpm:stage', stage: 'importing_done' }),
    ndjson({ name: 'pnpm:summary' }),
  ])
  const phases = events.map((e) => e.phase)
  assert.ok(phases.includes('resolving'), 'resolving phase reported')
  assert.ok(phases.includes('downloading'), 'downloading phase reported')
  assert.ok(phases.includes('linking'), 'linking phase reported')
  assert.equal(events[events.length - 1].phase, 'done')
  assert.equal(events[events.length - 1].percent, 100)

  // Resolution is indeterminate — the total is genuinely unknown there; the
  // label counts the packages resolved so far.
  const resolving = events.filter((e) => e.phase === 'resolving' && e.unit === 'packages')
  assert.ok(resolving.length >= 1, 'counting snapshots during resolution')
  assert.ok(resolving.every((e) => e.percent === null && e.total === undefined))
  assert.equal(resolving[resolving.length - 1].done, 3)

  // Downloads carry byte counters, the current package, and a rising percent.
  const downloading = events.filter((e) => e.phase === 'downloading' && e.unit === 'bytes')
  assert.ok(downloading.length >= 3, 'byte snapshots emitted')
  const dones = downloading.map((e) => e.done)
  assert.ok(dones.every((d, i) => i === 0 || d >= dones[i - 1]), 'bytes never decrease')
  assert.equal(dones[0], 0, 'download start reports 0 bytes')
  assert.deepEqual(dones.filter((d) => d > 0), [2500, 7500, 10000, 10000, 10000])
  assert.ok(downloading.every((e) => e.total === 10000))
  assert.ok(downloading.every((e) => e.package === '@ts/darwin-arm64'), 'scoped package keeps its scope, drops the version')
  const percents = downloading.map((e) => e.percent)
  assert.deepEqual(percents, [...percents].sort((a, b) => a - b), 'percent never decreases')
  assert.equal(percents[percents.length - 1], 100)

  // Linking counts imported over resolved.
  const linking = events.filter((e) => e.phase === 'linking' && e.unit === 'packages')
  assert.ok(linking.length >= 1 && linking.every((e) => e.total === 3), 'three resolved packages')
})

test('tracker clamps percent when new packages grow the known total', async () => {
  const tracker = new NdjsonProgressTracker()
  tracker.feed(ndjson({ name: 'pnpm:stage', stage: 'resolution_done' }))
  tracker.feed(ndjson({ name: 'pnpm:fetching-progress', packageId: 'a@1', size: 1000, status: 'started' }))
  await new Promise((r) => setTimeout(r, 150))
  const first = tracker.feed(ndjson({ name: 'pnpm:fetching-progress', packageId: 'a@1', downloaded: 900, status: 'in_progress' }))
  assert.equal(first.percent, 90)
  // A second, untouched package doubles the total — the bar must not rewind.
  tracker.feed(ndjson({ name: 'pnpm:fetching-progress', packageId: 'b@1', size: 1000, status: 'started' }))
  await new Promise((r) => setTimeout(r, 150))
  const second = tracker.feed(ndjson({ name: 'pnpm:progress', packageId: 'a@1', status: 'fetched' }))
  assert.equal(second.percent, 90, 'frozen at the previous high-water mark')
  assert.equal(second.done, 1000, 'a finished package counts its full tarball')
})

test('tracker stays silent on noise and throttles bursts', async () => {
  const tracker = new NdjsonProgressTracker()
  const events = []
  // A burst of resolved events inside the throttle window emits once.
  for (let i = 0; i < 30; i += 1) {
    const event = tracker.feed(ndjson({ name: 'pnpm:progress', packageId: `p${i}@1`, status: 'resolved' }))
    if (event !== null) events.push(event)
  }
  assert.equal(events.length, 1)
  assert.equal(events[0].phase, 'resolving')
  for (const line of ['', 'dsh: warning: x', '{"not json', 'Progress: resolved 1, reused 0, downloaded 0, added 0', null]) {
    assert.equal(tracker.feed(line), null)
  }
})

test('a store-only install (nothing to download) still completes', async () => {
  const events = await feed([
    ndjson({ name: 'pnpm:stage', stage: 'resolution_started' }),
    ndjson({ name: 'pnpm:progress', packageId: 'a@1', status: 'resolved' }),
    ndjson({ name: 'pnpm:progress', packageId: 'a@1', status: 'found_in_store' }),
    ndjson({ name: 'pnpm:stage', stage: 'resolution_done' }),
    ndjson({ name: 'pnpm:stage', stage: 'importing_started' }),
    ndjson({ name: 'pnpm:progress', packageId: 'a@1', status: 'imported' }),
    ndjson({ name: 'pnpm:stage', stage: 'importing_done' }),
    ndjson({ name: 'pnpm:stats', added: 0, removed: 0 }),
  ])
  const last = events[events.length - 1]
  assert.equal(last.phase, 'done')
  assert.equal(last.percent, 100)
})
