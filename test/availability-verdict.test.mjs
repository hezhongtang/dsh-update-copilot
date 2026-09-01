// Filesystem availability verdicts. Each state is pinned against a disk
// fixture under test/fixtures/availability/web — no network, no loader.
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  attachRisks,
  formatAvailabilityReport,
  newlyBrokenOrMissing,
  summarizeAvailability,
  verdictAvailability,
  worstAvailability,
} from '../lib/availability.js'

const profileDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'availability', 'web')

function verdict(name, overrides = {}) {
  return verdictAvailability({ profileDir, name, ...overrides })
}

test('missing: declared in the manifest but no package.json in node_modules', () => {
  const result = verdict('missing-plugin', { spec: '^1.0.0', inBundles: true })
  assert.equal(result.state, 'missing')
  assert.match(result.reasons, /未安装/)
  assert.match(result.reasons, /not installed/)
  assert.match(result.reasons, / \/ /)
  assert.equal(result.bundle, true)
})

test('broken: bundle-layer package with no dsh.bundle and no dsh.client', () => {
  const result = verdict('broken-surface', { spec: '^1.0.0', inBundles: true })
  assert.equal(result.state, 'broken')
  assert.match(result.reasons, /dsh/)
})

test('broken: declared entry artifact is missing from disk', () => {
  const result = verdict('broken-entry', { spec: '^1.0.0', inBundles: true })
  assert.equal(result.state, 'broken')
  assert.match(result.reasons, /入口|entry/i)
})

test('broken: client bundle was read and failed to parse as classic script', () => {
  const result = verdict('broken-client', { spec: '^1.0.0', inBundles: true })
  assert.equal(result.state, 'broken')
  assert.match(result.reasons, /client|bundle|解析|parse/i)
})

test('ok: ESM client bundle is silent (parser cannot judge, not corrupt)', () => {
  const result = verdict('esm-client', { spec: '^1.0.0', inBundles: true })
  assert.equal(result.state, 'ok')
})

test('ok: import.meta in a client bundle is ESM silence, not broken', () => {
  const result = verdict('import-meta-client', { spec: '^1.0.0', inBundles: true })
  assert.equal(result.state, 'ok')
})

test('ok: declared ./client is absent — missing file is not parse-failure evidence', () => {
  const result = verdict('absent-client', { spec: '^1.0.0', inBundles: true })
  assert.equal(result.state, 'ok')
})

test('ok: dsh surface present but no resolvable entry is not evidence of damage', () => {
  const result = verdict('unresolvable-entry', { spec: '^1.0.0', inBundles: true })
  assert.equal(result.state, 'ok')
})

test('disabled: profile patch layer has disabled: true for the loader entry id', () => {
  const result = verdict('disabled-plugin', { spec: '^1.0.0', inBundles: true })
  assert.equal(result.state, 'disabled')
  assert.match(result.reasons, /停用|disabled/i)
})

test('inert: installed library with no plugin surface and not in the bundle layer', () => {
  const result = verdict('inert-lib', { spec: '^1.0.0', inBundles: false })
  assert.equal(result.state, 'inert')
})

test('ok: healthy bundle-layer plugin with an existing entry', () => {
  const result = verdict('ok-plugin', { spec: '^1.0.0', inBundles: true })
  assert.equal(result.state, 'ok')
  assert.equal(result.bundle, true)
})

test('broken: link:/file: checkout with no dsh surface (inLayer via spec)', () => {
  const result = verdict('inert-lib', { spec: 'link:/tmp/inert-lib', inBundles: false })
  assert.equal(result.state, 'broken')
})

test('verdict stays lossless-JSON (no undefined values)', () => {
  const result = verdict('ok-plugin', { spec: '^1.0.0', inBundles: true })
  function walk(value, path = '$') {
    assert.notEqual(value, undefined, `undefined at ${path}`)
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`)
    }
  }
  walk(result)
})

test('worstAvailability ranks broken > missing > disabled > inert > ok', () => {
  assert.equal(worstAvailability(['ok', 'inert', 'disabled']), 'disabled')
  assert.equal(worstAvailability(['ok', 'missing', 'broken']), 'broken')
  assert.equal(worstAvailability(['inert']), 'inert')
  assert.equal(worstAvailability([]), 'ok')
})

test('summarizeAvailability counts per-row states', () => {
  const summary = summarizeAvailability([
    { name: 'a', availability: { state: 'broken' } },
    { name: 'b', availability: { state: 'broken' } },
    { name: 'c', availability: { state: 'missing' } },
    { name: 'd', availability: { state: 'disabled' } },
    { name: 'e', availability: { state: 'inert' } },
    { name: 'f', availability: { state: 'ok' } },
  ])
  assert.deepEqual(summary, { broken: 2, missing: 1, disabled: 1, inert: 1 })
})

test('newlyBrokenOrMissing reports only names that became broken/missing after', () => {
  const before = [
    { profile: 'web', name: 'pre-broken', state: 'broken', reasons: 'already' },
    { profile: 'web', name: 'ok-then-broken', state: 'ok', reasons: 'fine' },
    { profile: 'web', name: 'still-ok', state: 'ok', reasons: 'fine' },
  ]
  const after = [
    { profile: 'web', name: 'pre-broken', state: 'broken', reasons: 'already' },
    { profile: 'web', name: 'ok-then-broken', state: 'broken', reasons: 'new damage' },
    { profile: 'web', name: 'still-ok', state: 'ok', reasons: 'fine' },
    { profile: 'web', name: 'newly-missing', state: 'missing', reasons: 'gone' },
  ]
  const risks = newlyBrokenOrMissing(before, after)
  assert.deepEqual(risks.map((r) => r.name).sort(), ['newly-missing', 'ok-then-broken'])
  assert.equal(risks.every((r) => r.state === 'broken' || r.state === 'missing'), true)
})

test('attachRisks only fills outcome.risks on successful changed updates', () => {
  const before = [{ profile: 'web', name: 'pkg', state: 'ok', reasons: 'fine' }]
  const after = [{ profile: 'web', name: 'pkg', state: 'broken', reasons: 'new damage' }]
  assert.equal(attachRisks({ ok: false, changed: true }, before, after).risks, undefined)
  assert.equal(attachRisks({ ok: true, changed: false }, before, after).risks, undefined)
  const hit = attachRisks({ ok: true, changed: true }, before, after)
  assert.equal(hit.risks.length, 1)
  assert.equal(hit.risks[0].name, 'pkg')
  const clean = attachRisks({ ok: true, changed: true }, before, before)
  assert.equal('risks' in clean, false)
})

test('formatAvailabilityReport lists broken/missing names and counts', () => {
  const rows = [
    { name: 'broken-entry', profile: 'web', availability: { state: 'broken', reasons: '入口缺失 / entry missing' } },
    { name: 'missing-plugin', profile: 'web', availability: { state: 'missing', reasons: '未安装 / not installed' } },
  ]
  const summary = { broken: 1, missing: 1, disabled: 0, inert: 0 }
  const zh = formatAvailabilityReport(summary, rows, 'zh-CN')
  assert.match(zh, /broken=1/)
  assert.match(zh, /missing=1/)
  assert.match(zh, /broken-entry/)
  assert.match(zh, /missing-plugin/)
  const en = formatAvailabilityReport(summary, rows, 'en_US')
  assert.match(en, /broken=1/)
  assert.match(en, /missing-plugin/)
})
