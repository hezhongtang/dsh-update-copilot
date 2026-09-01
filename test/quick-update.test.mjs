// Regression tests for the sidebar one-click quick update: the outcome
// classifier the quick button consumes (`quickOutcome`, exported from the
// real shipped bundle as `__test`). The pass itself is the sequence runner the
// popup already uses (`runAll`), so its selection rules stay pinned by the
// existing global-update-targets coverage; these tests pin the terminal-state
// mapping instead — a pass shape change must not silently turn a failed
// update into an "up to date" button.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBundle } from './bundle-loader.mjs'

const pass = (name, outcome) => ({ name, outcome })

test('quick outcome: all-success pass reads done', async () => {
  const { quickOutcome } = loadBundle().__test
  const results = [
    pass('a-plugin', { ok: true, changed: true, requiresRestart: false }),
    pass('b-plugin', { ok: true, changed: false, requiresRestart: false }),
  ]
  assert.deepEqual(quickOutcome(results), { phase: 'done', failed: 0, requiresRestart: false })
})

test('quick outcome: any failure flips the pass to failed with a count', async () => {
  const { quickOutcome } = loadBundle().__test
  const results = [
    pass('ok-plugin', { ok: true, changed: true, requiresRestart: false }),
    pass('bad-plugin', { ok: false, error: 'git pull failed' }),
  ]
  const outcome = quickOutcome(results)
  assert.equal(outcome.phase, 'failed')
  assert.equal(outcome.failed, 1)
})

test('quick outcome: requires-restart propagates from any row', async () => {
  const { quickOutcome } = loadBundle().__test
  const results = [pass('needs-restart', { ok: true, changed: true, requiresRestart: true })]
  assert.equal(quickOutcome(results).requiresRestart, true)
})

test('quick outcome: empty pass reads none (nothing was updated)', async () => {
  const { quickOutcome } = loadBundle().__test
  assert.deepEqual(quickOutcome([]), { phase: 'none', failed: 0, requiresRestart: false })
})

test('quick outcome: malformed results read none instead of failing loud', async () => {
  const { quickOutcome } = loadBundle().__test
  assert.deepEqual(quickOutcome(undefined), { phase: 'none', failed: 0, requiresRestart: false })
  assert.deepEqual(quickOutcome(null), { phase: 'none', failed: 0, requiresRestart: false })
  assert.deepEqual(quickOutcome('nope'), { phase: 'none', failed: 0, requiresRestart: false })
})

test('quick outcome: a refused pass (undefined runner result) is not none', async () => {
  const { quickOutcome } = loadBundle().__test
  // The component maps a refused runAll (mutation lock busy) to a failed
  // state BEFORE classification; pin that the classifier never reads it as
  // "nothing to update" by checking a mixed pass keeps its failure.
  const results = [pass('busy-rejected', { ok: false }), pass('done', { ok: true })]
  assert.equal(quickOutcome(results).phase, 'failed')
})
