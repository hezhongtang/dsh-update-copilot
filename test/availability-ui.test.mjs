import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBundle } from './bundle-loader.mjs'

const {
  availabilityBadge,
  availabilityBanner,
  rowAvailabilityState,
  unreachableBanner,
} = loadBundle().__test

test('availabilityBadge: broken/missing use the high badge; disabled is neutral; ok/inert silent', () => {
  assert.deepEqual(availabilityBadge('broken'), { className: 'high', key: 'availBroken' })
  assert.deepEqual(availabilityBadge('missing'), { className: 'high', key: 'availMissing' })
  assert.deepEqual(availabilityBadge('disabled'), { className: 'unknown', key: 'availDisabled' })
  assert.equal(availabilityBadge('inert'), null)
  assert.equal(availabilityBadge('ok'), null)
  assert.equal(availabilityBadge(null), null)
  assert.equal(availabilityBadge(undefined), null)
})

test('rowAvailabilityState prefers the aggregated state, else the worst per-profile state', () => {
  assert.equal(rowAvailabilityState({ availability: { state: 'broken' } }), 'broken')
  assert.equal(rowAvailabilityState({
    profiles: [
      { availability: { state: 'ok' } },
      { availability: { state: 'disabled' } },
      { availability: { state: 'missing' } },
    ],
  }), 'missing')
  assert.equal(rowAvailabilityState({ profiles: [] }), 'ok')
})

test('availabilityBanner: null when no broken/missing; otherwise counts and names', () => {
  assert.equal(availabilityBanner(null, []), null)
  assert.equal(availabilityBanner({ broken: 0, missing: 0 }, []), null)
  const plugins = [
    { name: 'alpha', availability: { state: 'broken' } },
    { name: 'beta', availability: { state: 'missing' } },
    { name: 'gamma', availability: { state: 'ok' } },
    { name: 'alpha', availability: { state: 'broken' } },
  ]
  assert.deepEqual(availabilityBanner({ broken: 2, missing: 1 }, plugins), {
    broken: 2,
    missing: 1,
    names: ['alpha', 'beta'],
  })
})

test('unreachableBanner: null when none; otherwise unique sources', () => {
  assert.equal(unreachableBanner(null), null)
  assert.equal(unreachableBanner({ unreachable: 0, unreachableSources: [] }), null)
  assert.deepEqual(unreachableBanner({
    unreachable: 2,
    unreachableSources: ['npm:registry.npmjs.org', 'github:owner/repo'],
  }), {
    unreachable: 2,
    sources: ['npm:registry.npmjs.org', 'github:owner/repo'],
  })
})
