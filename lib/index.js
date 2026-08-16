/**
 * dsh-update-copilot host entry.
 *
 * Contributes, all optional so the bundle never blocks a profile boot:
 *  - three agent tools (scan / brief / update) when a `tools` service exists;
 *  - four HTTP routes for the web panel when a `webServer` service exists.
 *
 * Nothing here publishes a service, so the row is safe loose in any profile.
 */

export const name = 'dsh-update-copilot'

export function apply(ctx) {
  const disposers = []
  let disposed = false

  // Agent tools. Callback-form inject: fires when the tools service registers
  // (the Loader mounts entries concurrently, so a synchronous ctx.get at apply
  // time races and usually loses); never blocks this fiber when absent.
  const uninjectTools = ctx.inject(['tools'], (toolsCtx) => {
    import('./tools.js')
      .then((mod) => mod.registerCopilotTools(toolsCtx.tools, toolsCtx))
      .then((dispose) => {
        if (dispose === null) {
          ctx.logger?.warn('[dsh-update-copilot] @deepseek-ai/dsh-tools not locatable — agent tools skipped (web routes unaffected)')
          return
        }
        if (disposed) {
          dispose()
        } else {
          disposers.push(dispose)
          ctx.logger?.info?.('[dsh-update-copilot] agent tools registered')
        }
      })
      .catch((error) => {
        ctx.logger?.warn(`[dsh-update-copilot] tools unavailable: ${error instanceof Error ? error.message : String(error)}`)
      })
  })

  // Web panel routes — mount only when the profile composes a webServer.
  const uninjectRoutes = ctx.inject(['webServer'], (webCtx) => {
    import('./routes.js')
      .then((mod) => {
        if (disposed) return undefined
        const dispose = mod.mountCopilotRoutes(webCtx)
        disposers.push(dispose)
        ctx.logger?.info?.('[dsh-update-copilot] web routes mounted')
        return dispose
      })
      .then((dispose) => {
        // Race: disposed while the dynamic import was in flight.
        if (disposed && dispose !== undefined) dispose()
      })
      .catch((error) => {
        ctx.logger?.warn(`[dsh-update-copilot] routes unavailable: ${error instanceof Error ? error.message : String(error)}`)
      })
  })

  return () => {
    disposed = true
    for (const dispose of disposers) {
      try { dispose() } catch { /* best effort */ }
    }
    uninjectTools?.()
    uninjectRoutes?.()
  }
}
