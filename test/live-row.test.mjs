// Regression tests for the row-level live-progress mirror.
//
// The gap: an update started outside a row (popup, bulk pass, agent tool,
// another tab) rendered only the global banner — the matching row showed no
// progress, and an older failure line sat next to the fresh "updating" state.
// The client now matches the live slot against the row (liveMatchesRow),
// mirrors the slot's latest progress event into the row's {percent, phase}
// rendering shape (liveRowProgress), and clears the stale row result on the
// not-updating → updating edge (component-local wiring). These tests pin the
// pure seam against the real shipped bundle.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBundle } from './bundle-loader.mjs'

const { liveMatchesRow, liveRowProgress } = loadBundle().__test

const RUNNING = (current, progress) => ({ running: true, current, progress })

test('liveMatchesRow: null / idle / mismatch / match', () => {
  assert.equal(liveMatchesRow(null, 'a'), false)
  assert.equal(liveMatchesRow(undefined, 'a'), false)
  assert.equal(liveMatchesRow({ running: false, current: null, progress: null }, 'a'), false)
  assert.equal(liveMatchesRow(RUNNING(null, null), 'a'), false)
  assert.equal(liveMatchesRow(RUNNING({ name: 'b' }, null), 'a'), false)
  assert.equal(liveMatchesRow(RUNNING({ name: 'a' }, null), 'a'), true)
  assert.equal(liveMatchesRow(RUNNING({ name: 'a', profile: 'web' }, null), 'a'), true)
})

test('liveRowProgress: not running → null (no mirror)', () => {
  assert.equal(liveRowProgress(null), null)
  assert.equal(liveRowProgress({ running: false, current: null, progress: null }), null)
})

test('liveRowProgress: progress events carry percent + phase', () => {
  assert.deepEqual(
    liveRowProgress(RUNNING({ name: 'a' }, { type: 'progress', percent: 42, phase: 'downloading' })),
    { percent: 42, phase: 'downloading' })
  assert.deepEqual(
    liveRowProgress(RUNNING({ name: 'a' }, { type: 'progress', phase: 'resolving' })),
    { percent: null, phase: 'resolving' })
  assert.deepEqual(
    liveRowProgress(RUNNING({ name: 'a' }, { type: 'progress', percent: '7', phase: 'downloading' })),
    { percent: null, phase: 'downloading' })
})

test('liveRowProgress: retry maps to the retry phase, indeterminate', () => {
  assert.deepEqual(
    liveRowProgress(RUNNING({ name: 'a' }, { type: 'retry', attempt: 2, total: 3 })),
    { percent: null, phase: 'retry' })
})

test('liveRowProgress: phase events render indeterminate with a label', () => {
  for (const phase of ['start', 'stash', 'pull', 'pop']) {
    assert.deepEqual(
      liveRowProgress(RUNNING({ name: 'a' }, { type: 'phase', phase, attempt: 1, total: 3 })),
      { percent: null, phase })
  }
})

test('liveRowProgress: no event yet or unknown shape → bare indeterminate bar', () => {
  assert.deepEqual(liveRowProgress(RUNNING({ name: 'a' }, null)), { percent: null, phase: null })
  assert.deepEqual(liveRowProgress(RUNNING({ name: 'a' }, { type: 'line', text: 'noise' })), { percent: null, phase: null })
})
