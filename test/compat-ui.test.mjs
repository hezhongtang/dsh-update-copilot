import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBundle } from './bundle-loader.mjs'

const { compatSummary, pluginHasCompat } = loadBundle().__test

test('compatSummary: null when no findings', () => {
  assert.equal(compatSummary(null), null)
  assert.equal(compatSummary({ current: { findings: [] }, target: null }), null)
})

test('compatSummary: counts current and target, unique plugin names', () => {
  assert.deepEqual(compatSummary({
    current: { findings: [{ plugin: 'a' }, { plugin: 'a' }] },
    target: { findings: [{ plugin: 'b' }] },
  }), { current: 2, target: 1, plugins: ['a', 'b'] })
})

test('pluginHasCompat: true only for current-host findings', () => {
  assert.equal(pluginHasCompat({}), false)
  assert.equal(pluginHasCompat({ compat: [] }), false)
  assert.equal(pluginHasCompat({ compat: [{ against: 'target', missing: ['x'] }] }), false)
  assert.equal(pluginHasCompat({ compat: [{ against: 'current', missing: ['x'] }] }), true)
})
