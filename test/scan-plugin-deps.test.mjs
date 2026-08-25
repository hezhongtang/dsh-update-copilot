// Unit tests for the plugin-row membership rule (lib/scan.js).
//
// A profile manifest may carry plain dependencies that the host never loads
// as plugins (a CLI, a server runtime). Rendering those as plugin rows put a
// ghost update button next to the real plugin from the same repository —
// e.g. `OpenViking` beside `@openviking/dsh-memory-plugin`, both floating on
// github:volcengine/OpenViking. The membership rule is bundle-declared names
// plus visible dev checkouts; these tests pin it with fixtures, no fs or
// network involved.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bundleNamesOf, pluginEntries } from '../lib/scan.js'

const WEB_BUNDLES = bundleNamesOf({
  dsh: { profile: { bundles: ['@openviking/dsh-memory-plugin', 'dshmarket', 'dsh-update-copilot'] } },
})

test('bundleNamesOf reads the manifest declaration as a Set', () => {
  assert.ok(WEB_BUNDLES instanceof Set)
  assert.equal(WEB_BUNDLES.has('@openviking/dsh-memory-plugin'), true)
  assert.equal(WEB_BUNDLES.has('OpenViking'), false)
})

test('missing or empty bundle list falls back to every dependency', () => {
  const deps = { 'some-plugin': '^1.0.0', util: '^2.0.0' }
  assert.deepEqual(pluginEntries(deps, null), Object.entries(deps)) // field absent
  assert.deepEqual(pluginEntries(deps, bundleNamesOf({})), Object.entries(deps)) // manifest w/o dsh
  assert.deepEqual(pluginEntries(deps, bundleNamesOf({ dsh: { profile: { bundles: [] } } })), Object.entries(deps))
  assert.deepEqual(pluginEntries(deps, undefined), Object.entries(deps))
})

test('a bundled plugin stays; an unbundled same-repo package is dropped', () => {
  const deps = {
    '@openviking/dsh-memory-plugin': 'github:volcengine/OpenViking#path:/examples/dsh-memory-plugin',
    OpenViking: 'github:volcengine/OpenViking',
    dshmarket: '1.26.0',
  }
  const kept = pluginEntries(deps, WEB_BUNDLES)
  assert.deepEqual(kept.map(([name]) => name), ['@openviking/dsh-memory-plugin', 'dshmarket'])
})

test('link:/file: checkouts stay visible even when not yet bundled', () => {
  const deps = {
    'dev-plugin': 'link:/Users/me/dev/dev-plugin',
    'local-plugin': 'file:./local-plugin',
    util: '^2.0.0',
  }
  const kept = pluginEntries(deps, WEB_BUNDLES)
  assert.deepEqual(kept.map(([name]) => name), ['dev-plugin', 'local-plugin'])
})

test('insertion order is preserved for the surviving rows', () => {
  const deps = { b: '^1.0.0', a: '^1.0.0', c: '^1.0.0' }
  const bundles = new Set(['b', 'a', 'c'])
  assert.deepEqual(pluginEntries(deps, bundles).map(([n]) => n), ['b', 'a', 'c'])
})
