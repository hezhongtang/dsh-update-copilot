// Client-side progress rendering (client/client.js): the pure model behind
// the bar — event normalization, the byte/ETA formatters, the speed/ETA
// stats between consecutive events, the detail line — plus the ProgressBar
// element tree (crisp determinate fill, striped indeterminate fill, aria
// attributes) driven through the shipped bundle.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBundle } from './bundle-loader.mjs'

const {
  normalizeProgressEvent,
  formatBytes,
  formatEta,
  progressStats,
  progressDetail,
  progressBarElement,
} = loadBundle().__test

const SHAPE = { done: null, total: null, unit: null, package: null, at: null }

// A minimal bilingual `t` for the formatter/detail assertions.
const dict = {
  progressBytes: '{done} / {total}',
  progressPackages: '{done}/{total} packages',
  progressResolved: '{done} packages resolved',
  progressSpeedBytes: '{speed}/s',
  progressSpeedPackages: '{n} packages/s',
  progressEta: '{eta} left',
  etaSeconds: '{n}s',
  etaMinutes: '{m}m {s}s',
  etaSoon: 'less than 1s',
  progressPhase: '{phase}…',
  progress_start: 'Starting update',
  progress_resolving: 'Resolving dependencies',
  progress_downloading: 'Downloading',
  progress_linking: 'Linking dependencies',
  progress_done: 'Finishing up',
  progress_retry: 'Retrying',
  progress_waiting: 'Waiting for the server…',
}
const t = (key, params = {}) => {
  let s = dict[key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) s = s.replace(`{${k}}`, String(v))
  return s
}

test('normalizeProgressEvent degrades garbage to nulls, keeps real fields', () => {
  assert.deepEqual(normalizeProgressEvent({ percent: 42, phase: 'downloading' }), { percent: 42, phase: 'downloading', ...SHAPE })
  assert.deepEqual(normalizeProgressEvent({ percent: 'x', phase: 3, unit: 'parsecs', done: -1, at: 'soon' }), { percent: null, phase: null, ...SHAPE })
  assert.deepEqual(
    normalizeProgressEvent({ percent: 7, phase: 'downloading', done: 1024, total: 4096, unit: 'bytes', package: 'pkg', at: 1790684409743 }),
    { percent: 7, phase: 'downloading', done: 1024, total: 4096, unit: 'bytes', package: 'pkg', at: 1790684409743 })
  // A negative or huge percent is still a number — the bar clamps in CSS.
  assert.equal(normalizeProgressEvent({ percent: 0 }).percent, 0)
})

test('formatBytes and formatEta render human-readable values', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(15439), '15.1 KB')
  assert.equal(formatBytes(9270373), '8.8 MB')
  assert.equal(formatBytes(null), '—')
  assert.equal(formatEta(0.4, t), 'less than 1s')
  assert.equal(formatEta(42, t), '42s')
  assert.equal(formatEta(95, t), '1m 35s')
})

test('progressStats measures speed and ETA between same-unit events', () => {
  const previous = { percent: 20, phase: 'downloading', done: 2048, total: 10240, unit: 'bytes', at: 1000 }
  const current = { percent: 60, phase: 'downloading', done: 6144, total: 10240, unit: 'bytes', at: 2000 }
  const { speed, eta } = progressStats(current, previous)
  assert.equal(speed, 4096, 'bytes per second over the elapsed second')
  assert.equal(eta, 1, 'remaining 4096 bytes at 4096 B/s')
})

test('progressStats stays null without a measurable pair', () => {
  const bytes = { percent: 10, phase: 'downloading', done: 1, total: 10, unit: 'bytes', at: 1000 }
  assert.deepEqual(progressStats(bytes, null), { speed: null, eta: null })
  assert.deepEqual(progressStats(null, bytes), { speed: null, eta: null })
  // Different units, no elapsed time, or no movement — no invented rate.
  assert.deepEqual(progressStats({ ...bytes, at: 1000 }, { ...bytes, unit: 'packages', at: 1000 }), { speed: null, eta: null })
  assert.deepEqual(progressStats({ ...bytes, at: 1000 }, { ...bytes, at: 1000 }), { speed: null, eta: null })
  assert.deepEqual(progressStats({ ...bytes, at: 2000 }, { ...bytes, at: 1000 }), { speed: null, eta: null })
})

test('progressDetail composes counters, speed, and ETA', () => {
  const previous = { percent: 20, phase: 'downloading', done: 2048, total: 10240, unit: 'bytes', at: 1000 }
  const current = { percent: 60, phase: 'downloading', done: 6144, total: 10240, unit: 'bytes', at: 2000 }
  assert.equal(progressDetail(t, current, previous), '6.0 KB / 10.0 KB · 4.0 KB/s · 1s left')

  // Package counters, including the resolution phase (no total yet).
  assert.equal(progressDetail(t, { percent: null, phase: 'resolving', done: 12, unit: 'packages' }, null), '12 packages resolved')
  assert.equal(progressDetail(t, { percent: 21, phase: 'linking', done: 65, total: 305, unit: 'packages' }, null), '65/305 packages')

  // Phases without counters (start, retry, waiting) render no detail line.
  assert.equal(progressDetail(t, { percent: null, phase: 'start' }, null), null)
  assert.equal(progressDetail(t, null, null), null)
})

// ---------------------------------------------------------------------------
// The ProgressBar element tree.
// ---------------------------------------------------------------------------

function walk(node, visit) {
  if (node === null || node === undefined) return
  if (typeof node === 'string') {
    visit(node)
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function renderTexts(descriptor) {
  const texts = []
  walk(descriptor.type(descriptor.props), (node) => { if (typeof node === 'string') texts.push(node) })
  return texts.join(' | ')
}

function findByClass(node, className) {
  const found = []
  walk(node, (n) => {
    const cn = n?.props?.className
    if (typeof cn === 'string' && cn.split(' ').includes(className)) found.push(n)
  })
  return found
}

test('ProgressBar: determinate fill carries the percent width and aria state', () => {
  const descriptor = progressBarElement({
    t,
    progress: { percent: 64, phase: 'downloading', done: 15439, total: 9270373, unit: 'bytes', at: 1000 },
  })
  const tree = descriptor.type(descriptor.props)
  const track = findByClass(tree, 'duc-progress')[0]
  assert.equal(track.props.role, 'progressbar')
  assert.equal(track.props['aria-valuenow'], 64)
  assert.equal(track.props['aria-valuemin'], 0)
  assert.equal(track.props['aria-valuemax'], 100)
  const fill = findByClass(tree, 'duc-progress-fill')[0]
  assert.equal(fill.props.className, 'duc-progress-fill', 'no indeterminate class when determinate')
  assert.deepEqual(fill.props.style, { width: '64%' })
  const texts = renderTexts(descriptor)
  assert.ok(texts.includes('64%'), 'percent label')
  assert.ok(texts.includes('15.1 KB / 8.8 MB'), 'byte counters in the detail line')
})

test('ProgressBar: indeterminate phases use the striped fill and a phase label', () => {
  for (const phase of ['resolving', 'retry', 'start']) {
    const descriptor = progressBarElement({ t, progress: { percent: null, phase } })
    const tree = descriptor.type(descriptor.props)
    const track = findByClass(tree, 'duc-progress')[0]
    assert.equal(track.props['aria-valuenow'], undefined, 'no fake percent in aria')
    const fill = findByClass(tree, 'duc-progress-fill')[0]
    assert.equal(fill.props.className, 'duc-progress-fill duc-indet')
    assert.equal(fill.props.style, undefined, 'indeterminate fill has no inline width')
    assert.ok(renderTexts(descriptor).includes(t(`progress_${phase}`)), `phase label for ${phase}`)
  }
})

test('ProgressBar: idle (null) renders nothing', () => {
  assert.equal(progressBarElement({ t, progress: null }).type(progressBarElement({ t, progress: null }).props), null)
})
