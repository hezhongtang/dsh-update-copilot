// Regression tests for the per-row "queued" (待更新 / Queued) status.
//
// During a sequential pass ("一键更新全部" or "更新 bundle"), rows that are
// still waiting behind the running item render a disabled "待更新" button
// instead of a plain disabled "Update", so the list reads as one queue: the
// running row shows "更新中…" + live progress, the rest say "pending, starts
// right after". Position-aware: rows already attempted earlier in the pass
// keep the regular disabled button, because the scan does not refresh
// mid-pass and a stale "pending" would lie about an already-updated package.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBundle } from './bundle-loader.mjs'

test('queued status is off when no sequential pass is running', () => {
  const { rowQueuedInBulk } = loadBundle().__test
  assert.equal(rowQueuedInBulk(null, 'dshmarket'), false)
  assert.equal(rowQueuedInBulk(undefined, 'dshmarket'), false)
  assert.equal(rowQueuedInBulk({ running: false, index: 0, name: null, queue: ['dshmarket'] }, 'dshmarket'), false)
  // A pass that is running but never queued this package is not marked.
  assert.equal(rowQueuedInBulk({ running: true, index: 1, name: 'other', queue: [] }, 'dshmarket'), false)
})

test('queued status marks rows behind the running item, never the running one', () => {
  const { rowQueuedInBulk } = loadBundle().__test
  const bulk = {
    running: true, index: 1, total: 2,
    name: '@openviking/dsh-memory-plugin',
    queue: ['@openviking/dsh-memory-plugin', 'dshmarket'],
  }
  // The executing row belongs to the live mirror ("更新中…" + progress bar).
  assert.equal(rowQueuedInBulk(bulk, '@openviking/dsh-memory-plugin'), false)
  assert.equal(rowQueuedInBulk(bulk, 'dshmarket'), true)
})

test('queued status drops rows already attempted earlier in the pass', () => {
  const { rowQueuedInBulk } = loadBundle().__test
  const bulk = { running: true, index: 2, total: 3, name: 'second', queue: ['first', 'second', 'third'] }
  assert.equal(rowQueuedInBulk(bulk, 'first'), false)
  assert.equal(rowQueuedInBulk(bulk, 'second'), false)
  assert.equal(rowQueuedInBulk(bulk, 'third'), true)
})

test('queue membership is required: unrelated rows are never marked', () => {
  const { rowQueuedInBulk } = loadBundle().__test
  const bulk = { running: true, index: 1, total: 2, name: 'a', queue: ['a', 'b'] }
  assert.equal(rowQueuedInBulk(bulk, 'unrelated'), false)
})

test('pass-start snapshot (index 0, no running name) queues every target', () => {
  const { rowQueuedInBulk } = loadBundle().__test
  const bulk = { running: true, index: 0, total: 2, name: null, queue: ['a', 'b'] }
  assert.equal(rowQueuedInBulk(bulk, 'a'), true)
  assert.equal(rowQueuedInBulk(bulk, 'b'), true)
})

test('malformed queue shapes never crash and degrade to pass-start semantics', () => {
  const { rowQueuedInBulk } = loadBundle().__test
  assert.equal(rowQueuedInBulk({ running: true, queue: 'not-an-array' }, 'a'), false)
  // A non-finite index cannot be compared, so the snapshot degrades to
  // pass-start semantics: every queue member except the running one is pending.
  assert.equal(rowQueuedInBulk({ running: true, queue: ['a', 'b'], index: Number.NaN, name: 'b' }, 'a'), true)
  assert.equal(rowQueuedInBulk({ running: true, queue: ['a', 'b'], index: Number.NaN, name: 'b' }, 'b'), false)
  assert.equal(rowQueuedInBulk('nope', 'a'), false)
})
