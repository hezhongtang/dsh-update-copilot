// Update-integrity: only newly introduced broken/missing rows become risks;
// pre-existing damage and failed/unchanged outcomes stay silent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachRisks, snapshotAvailability, verdictAvailability } from '../lib/availability.js'

const profileDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'availability', 'web')

test('snapshot + recheck: newly broken package is a risk; pre-broken is not', () => {
  const before = snapshotAvailability('web', ['ok-plugin', 'broken-entry'], {
    profileDir,
    deps: { 'ok-plugin': '^1.0.0', 'broken-entry': '^1.0.0' },
    bundles: new Set(['ok-plugin', 'broken-entry']),
  })
  assert.equal(before.find((r) => r.name === 'ok-plugin').state, 'ok')
  assert.equal(before.find((r) => r.name === 'broken-entry').state, 'broken')

  const after = before.map((row) => (
    row.name === 'ok-plugin'
      ? { ...row, state: 'broken', reasons: '入口缺失 / entry missing' }
      : row
  ))
  const risks = attachRisks({ ok: true, changed: true }, before, after).risks
  assert.deepEqual(risks.map((r) => r.name), ['ok-plugin'])
  assert.equal(risks[0].state, 'broken')
})

test('failed or unchanged updates never report risks even when after is broken', () => {
  const before = [{ profile: 'web', name: 'pkg', state: 'ok', reasons: 'fine' }]
  const after = [{ profile: 'web', name: 'pkg', state: 'broken', reasons: 'damage' }]
  assert.equal('risks' in attachRisks({ ok: false, changed: true, code: 'update_failed' }, before, after), false)
  assert.equal('risks' in attachRisks({ ok: true, changed: false, code: 'update_noop' }, before, after), false)
})

test('verdictAvailability of the fixture still matches the snapshot', () => {
  const row = verdictAvailability({ profileDir, name: 'ok-plugin', spec: '^1.0.0', inBundles: true })
  assert.equal(row.state, 'ok')
})
