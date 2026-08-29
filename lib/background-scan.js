/**
 * One fresh scan when the web host comes up, so the badge and panel have
 * data without waiting for a first user action. No recurring schedule lives
 * here: upstreams are only touched at startup, on user action, or when the
 * user opts into the client's periodic refresh (Settings → Update Copilot).
 */

/** Start a single fresh scan; failures are logged, never thrown. */
export function startBackgroundScan({ scan, logger } = {}) {
  let disposed = false
  void (async () => {
    if (disposed) return
    try {
      await scan(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`[dsh-update-copilot] background scan failed: ${message}`)
    }
  })()
  return () => {
    disposed = true
  }
}

/**
 * Attach the startup scan only to a web host. The returned disposer also
 * handles an injection callback that races with plugin disposal.
 */
export function startBackgroundScanWhenReady({ inject, scan, logger } = {}) {
  let disposed = false
  let started = false
  let stop = () => {}
  const uninject = inject?.(['webServer'], () => {
    if (disposed || started) return
    started = true
    stop = startBackgroundScan({ scan, logger })
  })
  return () => {
    disposed = true
    stop()
    uninject?.()
  }
}
