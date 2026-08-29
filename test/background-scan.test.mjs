import test from 'node:test'
import assert from 'node:assert/strict'
import { startBackgroundScan, startBackgroundScanWhenReady } from '../lib/background-scan.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('startup scan runs one fresh forced scan and logs failures', async () => {
  const pending = []
  const scans = []
  const stop = startBackgroundScan({
    scan: (force) => {
      scans.push(force)
      const next = deferred()
      pending.push(next)
      return next.promise
    },
  })

  assert.deepEqual(scans, [true], 'exactly one startup scan, forced')
  stop()
  assert.deepEqual(scans, [true], 'disposal never re-triggers a scan')
  pending[0].resolve()
})

test('startup scan failures are logged, not thrown', async () => {
  const warnings = []
  startBackgroundScan({
    scan: async () => { throw new Error('offline') },
    logger: { warn: (message) => warnings.push(message) },
  })

  await Promise.resolve()
  assert.deepEqual(warnings, ['[dsh-update-copilot] background scan failed: offline'])
})

test('startup scan starts only after a web host appears, exactly once', async () => {
  let injected
  let unregistered = false
  const scans = []
  const stop = startBackgroundScanWhenReady({
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['webServer'])
      injected = callback
      return () => { unregistered = true }
    },
    scan: async (force) => { scans.push(force) },
  })

  assert.deepEqual(scans, [])
  injected({ webServer: {} })
  assert.deepEqual(scans, [true])
  injected({ webServer: {} })
  assert.deepEqual(scans, [true], 'a repeated capability callback does not duplicate the startup scan')

  stop()
  assert.equal(unregistered, true, 'disposal unregisters the injection callback')
  stop()
  assert.deepEqual(scans, [true], 'disposal is idempotent')
})
