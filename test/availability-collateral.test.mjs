// Whole-profile post-flight: an update can break plugins it never touched —
// pnpm rewrites shared dependencies for the whole tree, so the before/after
// availability diff must cover every profile plugin member, and risks on
// packages other than the update target must read as collateral damage.
import test from 'node:test'
import assert from 'node:assert/strict'
import { diffProfileRisks } from '../lib/availability.js'

const row = (name, state, overrides = {}) => ({ profile: 'web', name, state, reasons: `${name}: ${state}`, ...overrides })

test('risks on packages other than the update target read as collateral', () => {
  const risks = diffProfileRisks(
    [row('target-plugin', 'ok'), row('sibling-plugin', 'ok'), row('unrelated', 'ok')],
    [row('target-plugin', 'ok'), row('sibling-plugin', 'broken'), row('unrelated', 'missing')],
    'target-plugin',
  )
  assert.equal(risks.length, 2)
  const byName = Object.fromEntries(risks.map((r) => [r.name, r]))
  assert.equal(byName['sibling-plugin'].collateral, true)
  assert.equal(byName['unrelated'].collateral, true)
  assert.equal(byName['sibling-plugin'].state, 'broken')
})

test('the update target itself never reads as collateral', () => {
  const risks = diffProfileRisks(
    [row('target-plugin', 'ok')],
    [row('target-plugin', 'broken')],
    'target-plugin',
  )
  assert.equal(risks.length, 1)
  assert.equal(risks[0].collateral, undefined)
})

test('pre-existing damage and healed packages produce no risks', () => {
  assert.deepEqual(diffProfileRisks(
    [row('target-plugin', 'broken'), row('sibling-plugin', 'ok')],
    [row('target-plugin', 'broken'), row('sibling-plugin', 'ok')],
    'target-plugin',
  ), [])
  assert.deepEqual(diffProfileRisks(
    [row('target-plugin', 'broken')],
    [row('target-plugin', 'ok')],
    'target-plugin',
  ), [])
})

test('garbage inputs degrade to no risks', () => {
  assert.deepEqual(diffProfileRisks(null, undefined, 'x'), [])
  assert.deepEqual(diffProfileRisks('nope', [row('a', 'broken')], 'x').length, 1)
})
