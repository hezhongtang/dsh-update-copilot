import test from 'node:test'
import assert from 'node:assert/strict'
import { BACKGROUND_SCAN_INTERVAL_MS, startBackgroundScan } from '../lib/background-scan.js'

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
