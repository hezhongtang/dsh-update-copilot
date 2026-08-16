/**
 * Agent tools for dsh-update-copilot. Three tools keep the copilot loop tight:
 * scan (what is behind), brief (what an update contains + risk), update
 * (execute one confirmed update). The tools are the agent-facing half of the
 * "detect → decide → act" flow; the GUI mirrors the same routes.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPluginReloader } from './reload.js'
import { profilesRoot } from './util.js'

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Locate defineTool. The bare import works for published installs inside a
 * profile tree; link:/dev installs real-path outside it, so fall back to the
 * harness-maintained flat modules dir and the running dsh installation.
 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod.defineTool === 'function') return mod.defineTool
  } catch { /* try anchors below */ }

  const anchors = [join(profilesRoot(), 'node_modules')]
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1.length > 0) {
    // argv[1] is the running dsh bin: walk up to its package node_modules.
    let dir = dirname(argv1)
    for (let i = 0; i < 4; i += 1) {
      anchors.push(join(dir, 'node_modules'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  for (const anchor of anchors) {
    try {
      const req = createRequire(join(anchor, 'noop.js'))
      const spec = req.resolve('@deepseek-ai/dsh-tools')
      const mod = await import(pathToFileURL(spec).href)
      if (typeof mod.defineTool === 'function') return mod.defineTool
    } catch { /* next anchor */ }
  }
  return null
}

/**
 * Register the copilot tools on a tools service.
 * @param {object} tools - the tools service.
 * @param {object} [ctx] - the injected Cordis context; when present, update
 * succeeds can hot-reload the updated plugin in this process.
 * @returns {Promise<(() => void) | null>} disposer, or null when defineTool
 * cannot be located (caller warns; web routes still work).
 */
export async function registerCopilotTools(tools, ctx = null) {
  const defineTool = await loadDefineTool()
  if (defineTool === null) return null
  const reload = createPluginReloader(ctx)
  const { scanAll } = await import('./scan.js')
  const { buildBrief } = await import('./advise.js')
  const { updatePlugin, isUpdateRunning, UPDATE_TOOL_TIMEOUT_MS } = await import('./update.js')

  const disposers = []

  disposers.push(tools.register(defineTool({
    name: 'update_copilot_scan',
    description: 'Scan the DeepSeek Harness install for available updates: the dsh core + shipped bundles, and every profile plugin (npm registry versions and git-pinned upstreams). Read-only. Call when the user asks "有没有更新/什么落后了/check for updates".',
    parameters: {
      force: { type: 'boolean', description: 'Bypass the 10-minute cache and re-query every upstream (slower, fresher).' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      return scanAll(args.force === true)
    },
    timeoutMs: 120000,
  })))

  disposers.push(tools.register(defineTool({
    name: 'update_copilot_brief',
    description: 'Build a decision brief for one outdated item: semver distance, risk level, changelog material (versions, GitHub commits/release notes, or local git log), and a recommendation. Read-only. Use it to advise the user before updating.',
    parameters: {
      profile: { type: 'string', required: true, description: 'Profile name that has the plugin installed (e.g. "web").' },
      name: { type: 'string', required: true, description: 'Package name exactly as it appears in the scan result.' },
      force: { type: 'boolean', description: 'Bypass the brief cache.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      return buildBrief(args.profile, args.name, args.force === true)
    },
    timeoutMs: 60000,
  })))

  disposers.push(tools.register(defineTool({
    name: 'update_copilot_update',
    description: 'Execute one plugin update through the official dsh plugin CLI, after the user explicitly confirmed it. Failed or timed-out attempts are retried automatically (3 total attempts, 1s/3s backoff); the result reports attempts and the last output. Blocked for linked/file installs and @deepseek-ai/* official packages; the dsh core is report-only. A successful update is hot-reloaded in the running process when phase-1 conditions hold; check hotReloaded/requiresRestart in the result. Always run update_copilot_brief first and present the risk to the user.',
    parameters: {
      profile: { type: 'string', required: true, description: 'Profile name to update in (e.g. "web").' },
      name: { type: 'string', required: true, description: 'Installed package name to update.' },
      confirm: { type: 'boolean', required: true, description: 'Must be true — set it only after the user approved this specific update.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      if (args.confirm !== true) {
        return { ok: false, error: 'confirm=true required — ask the user first, then retry.' }
      }
      if (isUpdateRunning()) return { ok: false, error: 'another update is already running — wait and re-scan' }
      return updatePlugin(args.profile, args.name, { reload })
    },
    timeoutMs: UPDATE_TOOL_TIMEOUT_MS,
  })))

  return () => { for (const dispose of disposers) dispose() }
}
