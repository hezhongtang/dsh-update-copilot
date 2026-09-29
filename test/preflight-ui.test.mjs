// Client-bundle helper for preflight warnings: the shipped bundle's
// updateWarnings selector must tolerate the shapes the server actually emits
// (outcome-level warnings, per-profile items, garbage).
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBundle } from './bundle-loader.mjs'

const warning = (overrides = {}) => ({
  type: 'breaking', source: 'release', line: 'BREAKING CHANGE: removed settingsNamespace', message: 'BREAKING CHANGE: removed settingsNamespace', ...overrides,
})

test('updateWarnings reads the outcome warnings field', async () => {
  const { updateWarnings } = loadBundle().__test
  assert.equal(updateWarnings({ warnings: [warning()] }).length, 1)
  assert.deepEqual(updateWarnings({ name: 'clean' }), [])
})

test('updateWarnings falls back to per-profile item warnings', async () => {
  const { updateWarnings } = loadBundle().__test
  assert.equal(updateWarnings({ items: [{ profile: 'web' }, { profile: 'web', warnings: [warning()] }] }).length, 1)
})

test('updateWarnings tolerates malformed payloads', async () => {
  const { updateWarnings } = loadBundle().__test
  assert.deepEqual(updateWarnings({}), [])
  assert.deepEqual(updateWarnings(null), [])
  assert.deepEqual(updateWarnings('nope'), [])
  assert.deepEqual(updateWarnings({ warnings: 'nope' }), [])
})
