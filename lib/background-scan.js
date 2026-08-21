export const BACKGROUND_SCAN_INTERVAL_MS = 30 * 60 * 1000

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
