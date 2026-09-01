import test from 'node:test'
import assert from 'node:assert/strict'
import { captureProbe } from '../lib/util.js'
import { clearScanCache, npmNewest } from '../lib/scan.js'

test('captureProbe records elapsedMs and the thrown reason', async () => {
  const ok = await captureProbe(async () => 'yes')
  assert.equal(ok.ok, true)
  assert.equal(ok.value, 'yes')
  assert.equal(typeof ok.elapsedMs, 'number')
  assert.equal(ok.elapsedMs >= 0, true)

  const fail = await captureProbe(async () => { throw new Error('ECONNREFUSED') })
  assert.equal(fail.ok, false)
  assert.equal(fail.value, null)
  assert.equal(fail.reason, 'ECONNREFUSED')
  assert.equal(typeof fail.elapsedMs, 'number')
})

test('npmNewest failure is reached:false and negative-cached for a minute', async () => {
  clearScanCache()
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    calls += 1
    throw new Error('registry down')
  }
  try {
    const first = await npmNewest('some-plugin', true)
    assert.equal(first.reached, false)
    assert.match(first.reason, /registry down/)
    assert.equal(typeof first.elapsedMs, 'number')
    assert.equal(first.newest, null)

    const second = await npmNewest('some-plugin', false)
    assert.equal(second.reached, false)
    assert.equal(calls, 1, 'negative cache must skip the second fetch')

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ versions: { '1.0.0': {} }, 'dist-tags': { latest: '1.0.0' } }),
    })
    const recovered = await npmNewest('some-plugin', true)
    assert.equal(recovered.reached, undefined)
    assert.equal(recovered.newest, '1.0.0')
    const afterSuccess = await npmNewest('some-plugin', false)
    assert.equal(afterSuccess.newest, '1.0.0')
    assert.equal(afterSuccess.reached, undefined)
  } finally {
    globalThis.fetch = originalFetch
    clearScanCache()
  }
})
