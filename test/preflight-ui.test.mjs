// Client-bundle helpers for preflight warnings: the shipped bundle's
// rowPeerWarnings / updateWarnings selectors must tolerate the shapes the
// server actually emits (aggregate rows, per-profile items, garbage).
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBundle } from './bundle-loader.mjs'

const warning = (overrides = {}) => ({
  type: 'peer', specifier: '@deepseek-ai/dsh', range: '^0.1.2', against: 'target', version: '0.1.3-alpha.1', ...overrides,
})

test('rowPeerWarnings reads the aggregate row field', async () => {
  const { rowPeerWarnings } = loadBundle().__test
  const row = { name: 'p', peerWarnings: [warning()] }
  assert.equal(rowPeerWarnings(row).length, 1)
  assert.deepEqual(rowPeerWarnings({ name: 'clean' }), [])
})

test('rowPeerWarnings tolerates malformed payloads', async () => {
  const { rowPeerWarnings } = loadBundle().__test
  assert.deepEqual(rowPeerWarnings(null), [])
  assert.deepEqual(rowPeerWarnings(undefined), [])
  assert.deepEqual(rowPeerWarnings({ peerWarnings: 'nope' }), [])
  assert.deepEqual(rowPeerWarnings({ peerWarnings: [null, 7, warning()] }).length, 1)
})

test('updateWarnings prefers the outcome field and falls back to items', async () => {
  const { updateWarnings } = loadBundle().__test
  assert.equal(updateWarnings({ warnings: [warning()] }).length, 1)
  assert.equal(updateWarnings({ items: [{ profile: 'web' }, { profile: 'web', warnings: [warning()] }] }).length, 1)
  assert.deepEqual(updateWarnings({}), [])
  assert.deepEqual(updateWarnings(null), [])
  assert.deepEqual(updateWarnings('nope'), [])
})
