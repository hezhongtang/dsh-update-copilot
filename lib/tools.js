/**
 * Agent tools for dsh-update-copilot. Four tools keep the copilot loop
 * tight: scan (what is behind, package-centric across profiles), preflight
 * (the gate decision for one package, read-only), update (execute one
 * confirmed plugin update) and update-core (execute the gated harness
 * update — docs/adr/0001). The tools are the agent-facing half of the
 * "detect → decide → act" flow; the GUI mirrors the same routes.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
 * @returns {Promise<(() => void) | null>} disposer, or null when defineTool
 * cannot be located (caller warns; web routes still work).
 */
export async function registerCopilotTools(tools) {
  const defineTool = await loadDefineTool()
  if (defineTool === null) return null
  const { scanAll } = await import('./scan.js')
  const { updatePlugin, updatePluginAll, updateCore, isUpdateRunning, UPDATE_TOOL_TIMEOUT_MS, evaluatePreflight } = await import('./update.js')

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
    name: 'update_copilot_update',
    description: 'Execute one confirmed plugin update. Without a `profile`, the package is updated only in its explicit eligible profiles; official packages follow the harness install (use update_copilot_core for that). With a `profile`, only that profile is targeted. Only npm/GitHub specs auto-update, through the official dsh plugin CLI with automatic retries for transient failures (up to 3 attempts, jittered exponential backoff; deterministic errors such as a missing version or refused auth are not retried and fail fast). link:/file: checkouts are not managed — update them inside their own checkout. The result reports attempts and the last output per profile; a changed update always requires a dsh restart (check requiresRestart).',
    parameters: {
      name: { type: 'string', required: true, description: 'Installed package name to update.' },
      confirm: { type: 'boolean', required: true, description: 'Must be true — set it only after the user approved this specific update.' },
      profile: { type: 'string', description: 'Optional: update only this profile (e.g. "web"); default uses the scan-selected eligible profiles.' },
      target: { type: 'string', description: 'Optional exact target for a rollback: "name@1.2.3" (npm) or "github:owner/repo#sha" — validated to address this same package. Omit to update to the newest version.' },
      force: { type: 'boolean', description: 'Set true ONLY after the user explicitly approved overriding a preflight hard block (the target dsh no longer exports names this plugin imports — forcing can brick the whole profile at boot). Without it, a blocked update returns preflight_blocked with the evidence.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      if (args.confirm !== true) {
        return { ok: false, error: 'confirm=true required — ask the user first, then retry.' }
      }
      if (isUpdateRunning()) return { ok: false, error: 'another update is already running — wait and re-scan' }
      if (args.profile !== undefined && args.profile !== '') {
        return updatePlugin(args.profile, args.name, {}, { ...(args.target !== undefined ? { target: args.target } : {}), ...(args.force === true ? { force: true } : {}) })
      }
      return updatePluginAll(args.name, {}, { ...(args.target !== undefined ? { target: args.target } : {}), ...(args.force === true ? { force: true } : {}) })
    },
    timeoutMs: UPDATE_TOOL_TIMEOUT_MS,
  })))

  disposers.push(tools.register(defineTool({
    name: 'update_copilot_core',
    description: 'Execute the DSH core (harness) update after explicit user confirmation. Target: the newest healthy published version the radar verified — always resolved to a concrete version first (never a dist-tag string), and a resolved DOWNGRADE is refused unless force. Gates before anything runs: upgrade-card corridor, session-format storage boundary, and per-plugin missing-export evidence across every profile — force overrides only after user approval, the evidence stays on the outcome. Only a writable global npm install can be executed; npx or untraceable launches return the manual command (code core_install_unsupported). Runs npm install -g @deepseek-ai/dsh@<version> with retries; the running process is never the updated one — the result reports requiresRestart=true and carries a rollback command (reinstall of the before-version). Run update_copilot_preflight or the scan first and present the risks.',
    parameters: {
      confirm: { type: 'boolean', required: true, description: 'Must be true — set it only after the user approved updating the dsh harness itself.' },
      target: { type: 'string', description: 'Optional exact version (e.g. 0.1.7-rc.2) for a rollback/downgrade; omit to install the newest healthy version.' },
      force: { type: 'boolean', description: 'Set true ONLY after the user explicitly approved overriding a gate block or a downgrade refusal. Without it, blocked updates return preflight_blocked / core_downgrade_blocked with the evidence.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      if (args.confirm !== true) {
        return { ok: false, error: 'confirm=true required — ask the user first, then retry.' }
      }
      if (isUpdateRunning()) return { ok: false, error: 'another update is already running — wait and re-scan' }
      return updateCore({
        ...(args.target !== undefined ? { target: args.target } : {}),
        ...(args.force === true ? { force: true } : {}),
      })
    },
    timeoutMs: UPDATE_TOOL_TIMEOUT_MS,
  })))

  disposers.push(tools.register(defineTool({
    name: 'update_copilot_preflight',
    description: 'Read-only preflight check for one installed package: the decision the update gate would make, WITHOUT updating anything. Reports the overall decision (ok / warning / blocked) with per-profile items — hard blockers (named imports the target dsh host no longer exports, missing upgrade-card corridor edges, session-format boundaries), host-API capability risks, and breaking-change signals from release notes and commits. Findings carry `layer` (link-time / mount-time / run-time / storage / breaking-card) and `layerFindings`. Without a `profile`, every profile that has the package is evaluated; `target` overrides the dsh version line the evidence is gathered against (default: the newest published dsh when the core is behind). Use it to answer "will updating X break anything?" before calling update_copilot_update.',
    parameters: {
      name: { type: 'string', required: true, description: 'Installed package name to evaluate (exactly as it appears in the scan result).' },
      profile: { type: 'string', description: 'Optional: restrict the evaluation to one profile; default evaluates every profile that has the package.' },
      target: { type: 'string', description: 'Optional: evaluate against this dsh version instead of the newest published one.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      return evaluatePreflight({ name: args.name, profile: args.profile ?? null, target: args.target ?? null })
    },
    timeoutMs: 120000,
  })))

  return () => { for (const dispose of disposers) dispose() }
}
