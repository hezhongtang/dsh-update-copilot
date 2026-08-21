import test from 'node:test'
import assert from 'node:assert/strict'
import { BACKGROUND_SCAN_INTERVAL_MS, startBackgroundScan, startBackgroundScanWhenReady } from '../lib/background-scan.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('background scheduler runs fresh scans immediately and every 30 minutes without overlap', async () => {
  const pending = []
  const scans = []
  const timers = []
  const cleared = []
  const stop = startBackgroundScan({
    scan: (force) => {
      scans.push(force)
      const next = deferred()
      pending.push(next)
      return next.promise
    },
    setIntervalFn: (callback, delay) => {
      timers.push({ callback, delay })
      return 'timer-id'
    },
    clearIntervalFn: (id) => cleared.push(id),
  })

  assert.deepEqual(scans, [true])
  assert.equal(timers[0].delay, BACKGROUND_SCAN_INTERVAL_MS)
  timers[0].callback()
  assert.deepEqual(scans, [true], 'a running scan blocks an overlapping interval scan')

  pending[0].resolve()
  await Promise.resolve()
  timers[0].callback()
  assert.deepEqual(scans, [true, true])

  stop()
  assert.deepEqual(cleared, ['timer-id'])
  pending[1].resolve()
  await Promise.resolve()
  timers[0].callback()
  assert.deepEqual(scans, [true, true], 'disposed scheduler does not scan again')
})

test('background scheduler logs failures and continues scheduling', async () => {
  const warnings = []
  let callback
  const stop = startBackgroundScan({
    scan: async () => { throw new Error('offline') },
    setIntervalFn: (fn) => { callback = fn; return 1 },
    clearIntervalFn: () => {},
    logger: { warn: (message) => warnings.push(message) },
  })

  await Promise.resolve()
  callback()
  await Promise.resolve()
  assert.equal(warnings.length, 2)
  assert.ok(warnings.every((message) => message.includes('background scan failed: offline')))
  stop()
})

test('background scheduler starts only after a web host provides lifecycle timers', async () => {
  let injected
  const scans = []
  const timers = []
  const cleared = []
  const stop = startBackgroundScanWhenReady({
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['webServer', 'timer'])
      injected = callback
      return () => { injected = null }
    },
    scan: async (force) => { scans.push(force) },
  })

  assert.deepEqual(scans, [])
  injected({ webServer: {}, timer: {} })
  assert.deepEqual(scans, [], 'a web host without lifecycle timers does not start a scheduler')

  injected({
    webServer: {},
    timer: {
      setInterval: (callback, delay) => { timers.push({ callback, delay }); return 'timer-id' },
      clearInterval: (id) => cleared.push(id),
    },
  })
  assert.deepEqual(scans, [true])
  assert.equal(timers[0].delay, BACKGROUND_SCAN_INTERVAL_MS)
  injected({
    webServer: {},
    timer: {
      setInterval: () => { throw new Error('duplicate lifecycle scheduler') },
      clearInterval: () => {},
    },
  })
  assert.deepEqual(scans, [true], 'a repeated capability callback does not duplicate the scheduler')
  await Promise.resolve()
  timers[0].callback()
  await Promise.resolve()
  assert.deepEqual(scans, [true, true])

  stop()
  assert.deepEqual(cleared, ['timer-id'])
})
