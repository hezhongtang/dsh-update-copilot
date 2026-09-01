/**
 * Agent tools for dsh-update-copilot. Three tools keep the copilot loop tight:
 * scan (what is behind, package-centric across profiles), brief (what an
 * update contains + risk), update (execute one confirmed update). The tools
 * are the agent-facing half of the "detect → decide → act" flow; the GUI
 * mirrors the same routes.
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
  const { updatePlugin, updatePluginAll, isUpdateRunning, UPDATE_TOOL_TIMEOUT_MS } = await import('./update.js')

  const disposers = []

  disposers.push(tools.register(defineTool({
    name: 'update_copilot_scan',
    description: 'Scan the DeepSeek Harness install for available updates: the dsh core + shipped bundles, and every plugin across all profiles, merged package-centric (a package installed in several profiles appears once with per-profile channels, ownership, versions, eligible update profiles, and filesystem availability: ok/missing/broken/disabled/inert). Also reports third-party plugins whose named imports of @deepseek-ai/* are missing from the current (and, when the core is behind, the target) DSH host packages — the class of error that can fail the whole plugin tree at boot. Availability and named-export compat are independent axes. Read-only. Call when the user asks "有没有更新/什么落后了/check for updates/哪些插件会挂".',
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
    description: 'Build update highlights for one outdated package: semver distance, risk level, changelog material (versions, GitHub commits/release notes, or local git log), filesystem availability (broken/missing/disabled called out explicitly), and a recommendation. When a `profile` is given, the brief covers that profile only; without it, every visible profile row that has the package installed contributes a brief, including mixed npm, GitHub, and local channels. Read-only. Use it to advise the user before updating.',
    parameters: {
      name: { type: 'string', required: true, description: 'Package name exactly as it appears in the scan result.' },
      profile: { type: 'string', description: 'Optional: restrict the brief to one profile (e.g. "web").' },
      force: { type: 'boolean', description: 'Bypass the brief cache.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      return buildBrief(args.name, args.profile ?? null, args.force === true)
    },
    timeoutMs: 60000,
  })))

  disposers.push(tools.register(defineTool({
    name: 'update_copilot_update',
    description: 'Execute one confirmed plugin update. Without a `profile`, the package is updated only in its explicit eligible profiles; official packages are report-only. With a `profile`, only that profile is targeted. Each profile may use a different channel: npm/GitHub specs run through the official dsh plugin CLI, with automatic retries for transient failures (up to 3 attempts, jittered exponential backoff; deterministic errors such as a missing version or refused auth are not retried and fail fast), while link: local checkouts remain local and update through git pull in their own directory (auto-stash local changes → pull → restore; merge conflicts or failed restores are reported for manual handling). For link: checkouts, source="remote" switches the profile dependency to the published npm version (or a github: spec when the package is not on npm) — this breaks the local link and needs explicit user approval. The result reports attempts and the last output per profile. Blocked for file: installs; the dsh core is report-only. A successful update is hot-reloaded in the running process when phase-1 conditions hold; check hotReloaded/requiresRestart in the result. Always run update_copilot_brief first and present the risk to the user.',
    parameters: {
      name: { type: 'string', required: true, description: 'Installed package name to update.' },
      confirm: { type: 'boolean', required: true, description: 'Must be true — set it only after the user approved this specific update.' },
      profile: { type: 'string', description: 'Optional: update only this profile (e.g. "web"); default uses the scan-selected eligible profiles.' },
      source: { type: 'string', enum: ['local', 'remote'], description: 'For link: checkouts only. "local" (default) pulls in the checkout directory; "remote" switches the profile dependency to the published npm version (or a github: spec when the package is not on npm), breaking the local link — the user must explicitly approve this.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      if (args.confirm !== true) {
        return { ok: false, error: 'confirm=true required — ask the user first, then retry.' }
      }
      if (isUpdateRunning()) return { ok: false, error: 'another update is already running — wait and re-scan' }
      if (args.profile !== undefined && args.profile !== '') {
        return updatePlugin(args.profile, args.name, { reload }, { source: args.source })
      }
      return updatePluginAll(args.name, { reload }, { source: args.source })
    },
    timeoutMs: UPDATE_TOOL_TIMEOUT_MS,
  })))

  return () => { for (const dispose of disposers) dispose() }
}
