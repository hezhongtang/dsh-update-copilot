export const BACKGROUND_SCAN_INTERVAL_MS = 30 * 60 * 1000

function timerFunctions(timer) {
  const owner = timer?.timer ?? timer
  const set = owner?.setInterval ?? owner?.interval
  const clear = owner?.clearInterval ?? owner?.clear
  if (typeof set !== 'function' || typeof clear !== 'function') return null
  return {
    setIntervalFn: set.bind(owner),
    clearIntervalFn: clear.bind(owner),
  }
}

/** Start fresh background scans without allowing a slow scan to overlap another. */
export function startBackgroundScan({ scan, setIntervalFn = setInterval, clearIntervalFn = clearInterval, logger } = {}) {
  let disposed = false
  let scanning = false

  const run = async () => {
    if (disposed || scanning) return
    scanning = true
    try {
      await scan(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`[dsh-update-copilot] background scan failed: ${message}`)
    } finally {
      scanning = false
    }
  }

  void run()
  const timer = setIntervalFn(() => { void run() }, BACKGROUND_SCAN_INTERVAL_MS)
  return () => {
    disposed = true
    clearIntervalFn(timer)
  }
}

/**
 * Attach the scheduler only to a web host with Cordis' lifecycle timer
 * capability. The returned disposer also handles an injection callback that
 * races with plugin disposal.
 */
export function startBackgroundScanWhenReady({ inject, scan, logger } = {}) {
  let disposed = false
  let started = false
  let stop = () => {}
  const uninject = inject?.(['webServer', 'timer'], (host) => {
    if (disposed || started) return
    const timer = timerFunctions(host?.timer ?? host?.interval ?? host)
    if (timer === null) return
    started = true
    stop = startBackgroundScan({ scan, logger, ...timer })
  })
  return () => {
    disposed = true
    stop()
    uninject?.()
  }
}
