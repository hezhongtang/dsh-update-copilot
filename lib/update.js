/**
 * Update executor for dsh-update-copilot. npm/github specs run only through
 * the official `dsh plugin` CLI (which forwards to pnpm inside the profile
 * directory), one update at a time, with a strict target allowlist — never
 * raw shell strings. link:/file: checkouts are NOT managed: they have no
 * re-installable upstream, so update them in their own checkout. The DSH core
 * is executed ONLY as a gated global npm install (corridor/storage/export
 * evidence first, writable prefix required, restart always required — see
 * updateCore and docs/adr/0001).
 *
 * The core gate also emits advisory `warnings` (never blockers, no force
 * needed): profile cordis.patch.yml entries pinning a `@deepseek-ai/*` name
 * the target line no longer ships — the loader's strict-name check silently
 * skips the whole entry (config included; the 2026-09-28 llm-deepseek
 * rename incident) — and, after a successful replacement, a post-flight
 * `--dump-config` probe per profile surfaces the new loader's own skip
 * lines.
 *
 * Package-centric: `updatePluginAll` runs the same per-profile executor in
 * every profile that has the package installed, because the update command
 * is identical for all profiles.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { diffProfileRisks, packageDirOf, snapshotAvailability } from './availability.js'
import { bundleNamesOf, classifySpec, clearScanCache, githubCommitKey, inferMountRelationships, installedVersion, listProfiles, npmNewest, pinnedCommits, pluginMemberNames, profileDependencyMetadata, readDeps, scanCore, scanProfile } from './scan.js'
import { execText, profileDir, profilesRoot, readJson, recordOp } from './util.js'
import { currentDshVersion, breakingFindings } from './preflight.js'
import { buildLayerFindings, capabilityFindings, classifyFailureSignature, corridorFindings, normalizeDshVersion } from './cards.js'
import { gatherTargetBlockers, pluginScanTargets, targetDshPackageNames } from './compat.js'
import { detectCoreInstall, resolveCoreTarget } from './core-install.js'
import { parsePatchEntries } from './patch-audit.js'
import { emptyTargetGate, looksEmptyPackage } from './empty-pkg.js'
import { storageGate } from './storage.js'
import { clearLiveUpdate, readLiveUpdate, setLiveProgress, setLiveUpdate } from './live.js'
import { NdjsonProgressTracker, ndjsonLineToText, parseProgressLine } from './progress.js'
import { attachRollback, recordUpdateSnapshot, validateRollbackTarget } from './history.js'

/**
 * The full preflight pass for one plugin update: breaking-change signals
 * from release notes/commits as warnings, the hard blocker evidence (the
 * target dsh lacks a named export the plugin statically imports),
 * upgrade-card corridor (missing edge = stop), storage format boundary, and
 * host-API capability risks. The export blocker check only arms when the
 * core is behind — a current host has no target to be incompatible with —
 * and `force` never suppresses the evidence, only the refusal. Corridor /
 * storage gaps refuse by default and honor the same `force` override the
 * caller already understands.
 */
async function runPreflight(profile, name, spec) {
  let core = null
  try {
    core = await scanCore(false)
  } catch { /* the on-disk current version still applies */ }
  // Breaking-change signals ride the shared 10-minute signal cache — a cold
  // cache does fetch the changelog material once.
  let breaking = []
  try {
    const { collectBreakingSignals } = await import('./advise.js')
    breaking = await collectBreakingSignals(profile, name)
  } catch { /* breaking signals never fail preflight */ }
  const coreRow = core?.packages?.[0]
  const dshCurrent = currentDshVersion()
  const dshTarget = coreRow?.updateAvailable === true && typeof coreRow?.latest === 'string' && coreRow.latest !== ''
    ? coreRow.latest
    : null
  let blockers = []
  if (dshTarget !== null) {
    try {
      const dir = packageDirOf(profileDir(profile), name, spec)
      blockers = await gatherTargetBlockers({ profile, name, dir, targetVersion: dshTarget })
    } catch (error) {
      recordOp('warn', 'update:preflight', `${profile}/${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Upgrade-card corridor: a hop without curated cards must stop the move.
  const corridor = dshTarget !== null
    ? corridorFindings(dshCurrent ?? coreRow?.current, dshTarget)
    : null
  const corridorBlockers = corridor !== null && corridor.missingEdge === true
    ? [{
        type: 'corridor',
        layer: 'breaking-card',
        specifier: `dsh ${corridor.from} → ${corridor.to}`,
        missing: [],
        against: 'target',
        hostVersion: dshTarget,
        message: corridor.reason ?? 'missing curated upgrade-card edge',
        disablePatch: null,
        removeCommands: [],
      }]
    : []

  const storage = dshTarget !== null
    ? storageGate({ currentVersion: dshCurrent ?? coreRow?.current, targetVersion: dshTarget })
    : null
  const storageBlockers = storage !== null && storage.compatible === false
    ? [{
        type: 'storage',
        layer: 'storage',
        specifier: 'session-format',
        missing: [],
        against: 'target',
        hostVersion: dshTarget,
        message: storage.reason,
        disablePatch: null,
        removeCommands: [],
      }]
    : []

  let capability = []
  try {
    const dir = packageDirOf(profileDir(profile), name, spec)
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const entry = readJson(join(dir, 'package.json'))?.main ?? 'index.js'
    const source = readFileSync(join(dir, entry), 'utf8')
    capability = capabilityFindings(source)
  } catch { /* capability heuristics never fail preflight */ }

  const hard = [...blockers, ...corridorBlockers, ...storageBlockers]
  const layerFindings = buildLayerFindings({
    blockers: hard,
    warnings: capability.filter((c) => c.actionLevel !== 'informational'),
    breaking,
    corridor,
    storage,
    capability,
  })
  return {
    warnings: breaking,
    blockers: hard,
    dshTarget,
    dshCurrent: dshCurrent ?? coreRow?.current ?? null,
    corridor,
    storage,
    capability,
    layerFindings,
  }
}

/**
 * Read-only preflight evaluation behind the update_copilot_preflight agent
 * tool: the decision the gate would make for one package, per installing
 * profile, without touching anything. `target` overrides the dsh version
 * line the evidence is gathered against; without it the scan-derived target
 * applies (null when the core is current — the gate then has nothing to arm
 * against and only breaking/capability signals report). Results carry the
 * shared `layerFindings` vocabulary (link-time / mount-time / run-time /
 * storage / breaking-card) alongside the legacy blockers/breaking lists.
 */
export async function evaluatePreflight({ name, profile = null, target = null, loadTargetExports } = {}) {
  if (typeof name !== 'string' || name === '') return { name, decision: 'unknown', items: [], note: 'name is required' }
  let core = null
  try {
    core = await scanCore(false)
  } catch { /* the on-disk current version still applies */ }
  const coreRow = core?.packages?.[0]
  // A hostile or malformed target string would end up inside an `npm pack`
  // spec — restrict it to semver-ish characters and fall back to the
  // scan-derived target otherwise.
  const explicitTarget = typeof target === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(target) ? target : null
  const dshTarget = explicitTarget !== null
    ? explicitTarget
    : (coreRow?.updateAvailable === true && typeof coreRow?.latest === 'string' && coreRow.latest !== '' ? coreRow.latest : null)
  const dshCurrent = currentDshVersion() ?? coreRow?.current ?? null
  const profiles = typeof profile === 'string' && profile !== ''
    ? [profile]
    : listProfiles().filter((p) => readDeps(p)[name] !== undefined)
  const items = []
  for (const p of profiles) {
    const spec = readDeps(p)[name]
    if (spec === undefined) {
      items.push({ profile: p, decision: 'unknown', error: `${name} is not installed in profile "${p}"`, blockers: [], breaking: [], capability: [], layerFindings: [] })
      continue
    }
    let breaking = []
    try {
      const { collectBreakingSignals } = await import('./advise.js')
      breaking = await collectBreakingSignals(p, name)
    } catch { /* breaking signals never fail preflight */ }
    let blockers = []
    if (dshTarget !== null) {
      try {
        const dir = packageDirOf(profileDir(p), name, spec)
        blockers = await gatherTargetBlockers({ profile: p, name, dir, targetVersion: dshTarget, ...(loadTargetExports !== undefined ? { loadTargetExports } : {}) })
      } catch (error) {
        recordOp('warn', 'update:preflight', `${p}/${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const corridor = dshTarget !== null ? corridorFindings(dshCurrent, dshTarget) : null
    const corridorBlockers = corridor !== null && corridor.missingEdge === true
      ? [{
          type: 'corridor',
          layer: 'breaking-card',
          specifier: `dsh ${corridor.from} → ${corridor.to}`,
          missing: [],
          against: 'target',
          hostVersion: dshTarget,
          message: corridor.reason ?? 'missing curated upgrade-card edge',
        }]
      : []
    const storage = dshTarget !== null
      ? storageGate({ currentVersion: dshCurrent, targetVersion: dshTarget })
      : null
    const storageBlockers = storage !== null && storage.compatible === false
      ? [{
          type: 'storage',
          layer: 'storage',
          specifier: 'session-format',
          missing: [],
          against: 'target',
          hostVersion: dshTarget,
          message: storage.reason,
        }]
      : []
    let capability = []
    try {
      const { readFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const dir = packageDirOf(profileDir(p), name, spec)
      const entry = readJson(join(dir, 'package.json'))?.main ?? 'index.js'
      capability = capabilityFindings(readFileSync(join(dir, entry), 'utf8'))
    } catch { /* capability heuristics never fail preflight */ }

    const hard = [...blockers, ...corridorBlockers, ...storageBlockers]
    const layerFindings = buildLayerFindings({
      blockers: hard,
      warnings: capability.filter((c) => c.actionLevel !== 'informational'),
      breaking,
      corridor,
      storage,
      capability,
    })
    items.push({
      profile: p,
      decision: hard.length > 0 ? 'blocked' : (breaking.length > 0 || capability.length > 0 ? 'warning' : 'ok'),
      blockers: hard,
      breaking,
      capability,
      corridor,
      storage,
      layerFindings,
    })
  }
  const decision = items.some((i) => i.decision === 'blocked')
    ? 'blocked'
    : items.some((i) => i.decision === 'warning')
      ? 'warning'
      : items.some((i) => i.decision === 'ok')
        ? 'ok'
        : 'unknown'
  const note = decision === 'blocked'
    ? 'the update executor will refuse this update unless force: true is passed'
    : decision === 'warning'
      ? 'the update proceeds; warnings are advisory'
      : decision === 'ok'
        ? 'no preflight findings'
        : `${name} is not installed in the evaluated profile${profile !== null ? '' : 's'}`
  return {
    name,
    dshTarget,
    dshCurrent,
    decision,
    items,
    note,
    corridor: items[0]?.corridor ?? (dshTarget !== null ? corridorFindings(dshCurrent, dshTarget) : null),
  }
}

function sha1(text) {
  return createHash('sha1').update(text).digest('hex')
}

function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Locate the installed package manifest for one profile dependency. pnpm
 * symlinks direct dependencies into `<profile>/node_modules/<name>`, with the
 * shared flat fallback under `profiles/node_modules` as a second anchor.
 */
function locateInstalledManifest(profile, name) {
  if (typeof name !== 'string' || name.includes('..') || name.startsWith('/') || name.startsWith('\\')) return null
  for (const base of [join(profileDir(profile), 'node_modules'), join(profilesRoot(), 'node_modules')]) {
    const path = join(base, name, 'package.json')
    if (existsSync(path)) return path
  }
  try {
    const require = createRequire(join(profileDir(profile), 'package.json'))
    return require.resolve(`${name}/package.json`)
  } catch {
    return null
  }
}

function stableClientDeclaration(pkg) {
  const client = pkg?.dsh?.client
  if (client === undefined) return 'none'
  const clientExport = pkg?.exports?.['./client']
  return JSON.stringify({ client, clientExport: clientExport ?? null })
}

/**
 * Snapshot the on-disk layout of one installed plugin: bundle patch content
 * and `dsh.client` declaration. The update history snapshot archives the
 * patch text as restore-verbatim evidence.
 */
function capturePluginLayout(profile, name) {
  const manifestPath = locateInstalledManifest(profile, name)
  if (manifestPath === null) {
    return { manifestPath: null, patchPath: null, patchFingerprint: null, clientFingerprint: null }
  }
  let pkg = null
  try {
    pkg = JSON.parse(readTextOrNull(manifestPath) ?? 'null')
  } catch { /* malformed package.json — fall through with pkg null */ }

  const patchRel = pkg?.dsh?.bundle?.patch
  const patchPath = typeof patchRel === 'string' ? resolve(dirname(manifestPath), patchRel) : null
  const patchText = patchPath === null ? null : readTextOrNull(patchPath)
  const patchFingerprint = patchPath === null ? null : sha1(`${patchPath}\n${patchText ?? ''}`)
  const clientFingerprint = sha1(stableClientDeclaration(pkg))
  return { manifestPath, patchPath, patchFingerprint, clientFingerprint, patchText }
}

/**
 * Snapshot what is installed right now, before a mutation rewrites it —
 * version, spec, pinned commit, bundle patch text — under the copilot's
 * history directory. Best-effort on both halves: the snapshot file may fail
 * to write (update still runs) and the layout capture may fail (snapshot
 * just carries no patch copy).
 */
function buildUpdateSnapshot({ profile, name, target, spec, repoKey, commit = null }) {
  const snapshot = {
    at: new Date().toISOString(),
    profile,
    name,
    target,
    before: {
      version: installedVersion(profile, name),
      spec,
      commit: commit ?? (repoKey !== null ? pinnedCommits(profile).get(repoKey) ?? null : null),
    },
    patch: null,
  }
  try {
    const layout = capturePluginLayout(profile, name)
    if (layout.patchPath !== null) {
      snapshot.patch = { path: layout.patchPath, fingerprint: layout.patchFingerprint, text: layout.patchText ?? null }
    }
  } catch { /* snapshot keeps going without the patch copy */ }
  recordUpdateSnapshot(snapshot)
  return snapshot
}

/**
 * Availability verdicts for every plugin member of one profile — the
 * whole-tree snapshot the post-flight diff needs, because pnpm rewrites
 * shared dependencies beyond the updated package.
 */
function captureProfileAvailability(profile) {
  try {
    const dir = profileDir(profile)
    const manifest = readJson(join(dir, 'package.json'))
    const deps = readDeps(profile)
    const mount = inferMountRelationships(profile, deps)
    return snapshotAvailability(profile, [...pluginMemberNames(profile, deps, mount)], {
      profileDir: dir,
      deps,
      bundles: bundleNamesOf(manifest),
    })
  } catch {
    return []
  }
}

function sealIntegrity(outcome, profile, name, before) {
  if (outcome?.ok !== true || outcome?.changed !== true) return outcome
  const risks = diffProfileRisks(before, captureProfileAvailability(profile), name)
  if (risks.length === 0) return outcome
  return { ...outcome, risks }
}

export const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const TARGET_RE = /^(@?[A-Za-z0-9][A-Za-z0-9._/-]*@[A-Za-z0-9][A-Za-z0-9._/-]*)$|^((?:github:)?@?[A-Za-z0-9][A-Za-z0-9._/-]*)(#.*)?$/

/** Hard timeout for one `dsh plugin add` attempt. */
export const UPDATE_TIMEOUT_MS = 5 * 60 * 1000
/** Total attempts for one plugin update (1 initial + 2 retries by default). */
export const UPDATE_MAX_ATTEMPTS = 3
/** Backoff base for the jittered retry delay (milliseconds). */
export const UPDATE_RETRY_BACKOFF_BASE_MS = 1000
/** Backoff cap — the jittered delay never exceeds this, however many attempts. */
export const UPDATE_RETRY_BACKOFF_CAP_MS = 8000

/**
 * Full-jitter capped exponential backoff (AWS Architecture Blog, "Exponential
 * Backoff and Jitter"): sleep = random(0, min(cap, base·2^(attempt−1))).
 * Randomization stops a batch of updates from re-hitting the registry or git
 * remote in lockstep the moment a shared hiccup clears.
 */
export function updateRetryDelayMs(attempt) {
  const ceiling = Math.min(UPDATE_RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1), UPDATE_RETRY_BACKOFF_CAP_MS)
  return Math.round(Math.random() * ceiling)
}

/** Worst-case total backoff: every retry gap at its full ceiling. */
function retryBackoffWorstCaseMs() {
  let sum = 0
  for (let attempt = 1; attempt < UPDATE_MAX_ATTEMPTS; attempt += 1) {
    sum += Math.min(UPDATE_RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1), UPDATE_RETRY_BACKOFF_CAP_MS)
  }
  return sum
}

/** Agent-tool timeout: worst-case attempts + backoff + one minute of margin. */
export const UPDATE_TOOL_TIMEOUT_MS = UPDATE_TIMEOUT_MS * UPDATE_MAX_ATTEMPTS
  + retryBackoffWorstCaseMs()
  + 60 * 1000

let running = false

/** Is an update currently executing? (For 409-style answers in routes/tools.) */
export function isUpdateRunning() {
  return running
}

/**
 * Live update status for the web panel's /update-status poll: whether an
 * update is executing, which package/profile/target it is on (when known),
 * and the latest emitted progress event. While idle everything is null; the
 * executors record into the live slot via live.js, so updates started from
 * ANY trigger path (web routes, agent tools) stay visible in the GUI.
 */
export function updateStatus() {
  if (!running) return { running: false, current: null, progress: null }
  return { running: true, ...readLiveUpdate() }
}

/**
 * Progress event bus: one update at a time, so a single live slot suffices.
 * The routes layer (SSE) registers the single sink with `subscribeProgress`;
 * the executors below only ever *emit* through `emitProgress` — they must not
 * register their own subscriber, or the route's sink would be clobbered and
 * live progress would never reach the browser (regression fixed here: the
 * executor used to subscribe a no-op that overwrote the busy slot).
 */
let progressSub = null

export function subscribeProgress(handler) {
  const cancelled = { value: false }
  progressSub = { handler, cancelled }
  return {
    emit(event) {
      if (progressSub !== null && progressSub.handler === handler) progressSub.handler(event)
    },
    cancel() {
      cancelled.value = true
      if (progressSub !== null && progressSub.handler === handler) progressSub = null
    },
  }
}

/** Forward one progress event to the live slot (any reader), then to the SSE sink, if any. */
export function emitProgress(event) {
  // Raw output lines are noise for the live reader: only progress / retry /
  // phase events refresh the status slot (agent-tool updates have no SSE
  // sink, yet their stage must stay visible in the web panel).
  if (event?.type !== 'line') setLiveProgress(event)
  if (progressSub !== null) progressSub.handler(event)
}


/** Locate the `dsh` launcher: node + absolute bin when launched by dsh itself. */
function dshArgv() {
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1.length > 0) {
    const abs = resolve(argv1)
    if (/(^|\/)dsh(\.js|\.mjs|\.cjs)?$/.test(abs) && existsSync(abs)) {
      return { file: process.execPath, args: [...process.execArgv, abs], viaShell: false }
    }
    const sibling = join(dirname(abs), 'dsh')
    if (existsSync(sibling)) {
      return { file: process.execPath, args: [...process.execArgv, sibling], viaShell: false }
    }
  }
  const winShim = process.platform === 'win32'
  return { file: 'dsh', args: [], viaShell: winShim }
}

function killChild(child) {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/**
 * Run one install attempt with a hard timeout. Returns the exit code and
 * the captured output tails; never throws for spawn failures. `onLine`
 * receives every emitted output line (stdout + stderr) for live progress.
 * `mapLine` optionally rewrites each line before it is both captured and
 * emitted — the pnpm NDJSON reporter path uses it to turn error events
 * back into readable text and drop the event noise, so the captured tail
 * stays human-diagnosable (returning null drops the line entirely).
 */
function runPluginAdd(file, args, viaShell, onLine = null, mapLine = null) {
  return new Promise((resolvePromise) => {
    const sinks = { stdout: '', stderr: '' }
    const caps = { stdout: 64 * 1024, stderr: 32 * 1024 }
    let timedOut = false
    let settled = false
    const child = spawn(file, args, {
      cwd: dirname(file) === '.' ? undefined : dirname(file),
      env: { ...process.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: viaShell,
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      timedOut = true
      killChild(child)
    }, UPDATE_TIMEOUT_MS)
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, timedOut, stdout: sinks.stdout, stderr: sinks.stderr })
    }
    const onData = (stream) => (chunk) => {
      const text = chunk.toString('utf8')
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        // The raw line goes to the progress parser; only the captured
        // output gets the mapped (reconstructed / dropped) form.
        onLine?.(trimmed)
        const mapped = mapLine === null ? trimmed : mapLine(trimmed)
        if (mapped === null || mapped === '') continue
        sinks[stream] = (sinks[stream] + mapped + '\n').slice(-caps[stream])
      }
    }
    child.stdout?.on('data', onData('stdout'))
    child.stderr?.on('data', onData('stderr'))
    child.on('error', (error) => {
      sinks.stderr += `\nspawn error: ${error.message}`
      finish(1)
    })
    child.on('close', (code) => finish(code ?? 1))
  })
}

/** Did the profile state move from the pre-update snapshot? */
function stateChanged(before, after) {
  return after.version !== before.version || after.spec !== before.spec || after.commit !== before.commit
}

/**
 * Deterministic-failure signatures in update output: when one matches, a retry
 * cannot succeed (the package/version does not exist, credentials are missing
 * or refused, git refuses the operation), so callers fail fast instead of
 * burning the remaining attempts on a guaranteed loss. Deliberately
 * conservative — only high-confidence signatures belong here; everything
 * ambiguous (DNS errors, connection resets, 5xx, timeouts) stays retryable.
 */
const FATAL_UPDATE_SIGNATURES = [
  ['version_not_found', /\bETARGET\b|\bE404\b|ERR_PNPM_NO_MATCHING_VERSION|ERR_PNPM_FETCH_404|404 Not Found/],
  ['auth_required', /\bE40[13]\b|401 Unauthorized|403 Forbidden|could not read Username|Authentication failed|Permission denied \(publickey/],
  ['git_refuses', /detected dubious ownership|not currently on a branch/],
]

/**
 * Return the label of the first fatal signature in an attempt's output, or
 * null when the failure looks (or might be) transient. Timeouts and successes
 * are never classified fatal. When a signature matches, the shared
 * link-time / mount-time / run-time / storage layer rides along so the UI
 * and agent tools can name the failure class.
 */
export function findFatalUpdateError(result) {
  if (!result || result.timedOut || result.code === 0) return null
  const text = `${result.stdout}\n${result.stderr}`
  for (const [label, pattern] of FATAL_UPDATE_SIGNATURES) {
    if (pattern.test(text)) return label
  }
  return null
}

/** Attach the community three-layer classification to a failed update outcome. */
export function attachFailureLayer(outcome) {
  if (outcome === null || typeof outcome !== 'object' || outcome.ok === true) return outcome
  const text = `${outcome.output ?? ''}\n${outcome.error ?? ''}`
  const layer = classifyFailureSignature(text)
  if (layer.layer === 'unknown') return outcome
  return { ...outcome, failureLayer: layer }
}

function tailOutput(result) {
  return (result.stdout + (result.stderr ? `\n${result.stderr}` : '')).trim().split('\n').slice(-12).join('\n')
}

/**
 * Execute one plugin update.
 * @param {string} profile - profile name.
 * @param {string} name - package name as it appears in the profile dependencies.
 * @param {{ preflight?: (profile: string, name: string, spec: string) => Promise<object> }} [hooks] - optional
 * runtime hooks; `preflight` overrides the gate (test seam).
 * @param {{ force?: boolean, target?: string, profiles?: string[] }} [options] -
 * force overrides a preflight block; target pins an exact rollback target.
 * @returns {Promise<object>} result with changed/before/after/output.
 */
export async function updatePlugin(profile, name, hooks = {}, options = {}) {
  if (!PROFILE_RE.test(profile)) return { ok: false, code: 'invalid_profile', error: `invalid profile name: ${profile}` }
  if (typeof name !== 'string' || !TARGET_RE.test(name)) return { ok: false, code: 'unsafe_target', error: `unsafe plugin target rejected: ${String(name)}` }
  if (running) return { ok: false, code: 'update_running', error: 'another update is already running' }

  const spec = readDeps(profile)[name]
  if (spec === undefined) return { ok: false, code: 'not_installed', error: `${name} is not installed in profile "${profile}"` }
  if (name.startsWith('@deepseek-ai/')) {
    return { ok: false, code: 'official_package', error: 'official @deepseek-ai/* packages follow the harness install — update dsh itself' }
  }
  if (spec.startsWith('file:')) {
    return { ok: false, code: 'linked_install', error: 'file: installs have no upstream — update them from their own checkout' }
  }
  // Single-flight: the lock is taken HERE — after the cheap synchronous
  // validations but before any async work (the preflight gate can take
  // seconds) — and held across the whole operation. Taking it later would
  // let two concurrent callers race through the gate window and run two
  // `dsh plugin add` processes against the same profile.
  running = true
  try {
    return await runUpdateForProfile(profile, name, spec, hooks, options)
  } finally {
    running = false
  }
}

/** Per-profile executor; the caller owns the single-flight lock. */
async function runUpdateForProfile(profile, name, spec, hooks, options) {
  const kind = classifySpec(spec)
  const beforeAvail = captureProfileAvailability(profile)
  // The preflight gate runs BEFORE any mutation is spawned, on every
  // auto-updatable channel: hard evidence (the target dsh lacks a named
  // export this plugin statically imports) refuses the update — fail-loud
  // boot means one broken plugin bricks the whole profile. `force: true`
  // overrides after explicit user approval; the evidence stays on the
  // outcome either way.
  const preflightFn = typeof hooks.preflight === 'function' ? hooks.preflight : runPreflight
  const preflight = await preflightFn(profile, name, spec)
  if (preflight.blockers.length > 0 && options.force !== true) {
    const missingCount = preflight.blockers.reduce((n, finding) => n + (Array.isArray(finding.missing) ? finding.missing.length : 0), 0)
    const kinds = [...new Set(preflight.blockers.map((b) => b.type ?? b.layer ?? 'export'))]
    recordOp('warn', 'update:preflight', `${profile}/${name}: blocked — ${kinds.join(',')} (${missingCount} named import(s) missing from target dsh ${preflight.dshTarget})`)
    return {
      ok: false,
      code: 'preflight_blocked',
      changed: false,
      profile,
      name,
      target: null,
      attempts: 0,
      blockers: preflight.blockers,
      layerFindings: preflight.layerFindings ?? [],
      corridor: preflight.corridor ?? null,
      error: missingCount > 0
        ? `update blocked: the target dsh ${preflight.dshTarget} does not export ${missingCount} name(s) this plugin imports — review the evidence, then pass force: true to override`
        : `update blocked: preflight gate (${kinds.join(', ')}) refused dsh ${preflight.dshCurrent ?? '?'} → ${preflight.dshTarget} — review the evidence, then pass force: true to override`,
    }
  }
  const forced = preflight.blockers.length > 0 && options.force === true
  if (kind !== 'npm' && kind !== 'github') {
    return { ok: false, code: 'unsupported_channel', error: `${kind} install specs are not auto-updated by the copilot` }
  }

  let target
  let targetVersion = null
  let repoKey = null
  // An explicit target (the rollback path) is validated FIRST and replaces
  // the newest-version resolution entirely: it must address exactly this
  // package, and it must work with the registry unreachable — rolling back
  // to a known version is the recovery path when npm itself is down.
  const explicit = typeof options.target === 'string' && options.target !== ''
    ? validateRollbackTarget(name, spec, options.target)
    : null
  if (typeof options.target === 'string' && options.target !== '' && explicit === null) {
    return { ok: false, code: 'unsafe_target', error: `unsafe update target rejected: ${options.target}` }
  }
  if (kind === 'github') {
    // Fragment-aware commit key from the spec: several dependencies of the
    // same repo are pinned separately in the lockfile (`#path:/...` vs repo
    // root), so the key must carry the fragment or the before/after commit
    // comparison reads the wrong row and the update looks like a no-op.
    repoKey = explicit !== null ? explicit.repoKey : githubCommitKey(spec)
    if (explicit !== null) {
      target = explicit.target
    } else {
      // Keep structural fragments (#path:/...) — they address the package
      // inside the repo — but drop pin fragments (#<sha>/#<branch>) so the
      // update actually moves to the newest commit.
      target = spec.replace(/#(?!path:).*$/, '')
    }
  } else if (explicit !== null) {
    ;({ target, targetVersion, repoKey } = explicit)
  } else {
    // Ask pnpm for the exact newest version, never the `latest` dist-tag:
    // pnpm 11 defaults to minimum-release-age=1440 (1 day). A tag that points
    // at a version younger than that resolves down to an older mature release
    // — or, when the current version already satisfies the spec, silently
    // does nothing. An explicit exact version is an opt-in and pnpm applies
    // it (recording the package in minimumReleaseAgeExclude), so the update
    // actually happens.
    const meta = await npmNewest(name, true)
    if (meta.newest === null) {
      const why = meta.reached === false
        ? `${meta.reason} — cannot check (not "no update")`
        : (Array.isArray(meta.skippedEmpty) && meta.skippedEmpty.length > 0
          ? `every published version looks like an empty husk (skipped: ${meta.skippedEmpty.join(', ')})`
          : 'retry when the registry is reachable')
      return { ok: false, code: meta.newestEmpty === true || (Array.isArray(meta.skippedEmpty) && meta.skippedEmpty.length > 0 && meta.reached !== false) ? 'empty_target' : 'latest_unavailable', error: `could not resolve the newest published version of ${name} — ${why}` }
    }
    const emptyGate = emptyTargetGate({
      name,
      targetVersion: meta.newest,
      versionMeta: meta.newestMeta ?? null,
      distLatest: meta.distLatest,
      distLatestMeta: meta.distLatestMeta,
    })
    if (emptyGate.blocked === true || meta.newestEmpty === true) {
      return { ok: false, code: emptyGate.code ?? 'empty_target', error: emptyGate.message ?? `${name}@${meta.newest} looks like an empty publish — pin a real version` }
    }
    targetVersion = meta.newest
    target = `${name}@${targetVersion}`
  }
  if (!TARGET_RE.test(target)) return { ok: false, code: 'unsafe_target', error: `unsafe target rejected: ${target}` }

  const snapshot = buildUpdateSnapshot({ profile, name, target, spec, repoKey })
  const outcome = sealIntegrity(await runPnpmUpdate(profile, name, target, { targetVersion, repoKey, warnings: preflight.warnings }), profile, name, beforeAvail)
  const rolled = attachRollback(outcome, snapshot)
  return forced ? { ...rolled, forced: true, blockers: preflight.blockers } : rolled
}

/**
 * Execute one update for a package across its explicit eligible profiles — the
 * "global" one-click update. Each profile runs through the regular per-profile
 * executor (its own channel and spec), sequentially. Profiles whose install
 * channel cannot auto-update (file:, official @deepseek-ai/*, unsupported
 * specs) are reported as skipped, not failures.
 * A profile that is already current reports `current: true` and does not fail
 * the aggregate.
 * @param {string} name - package name as it appears in profile dependencies.
 * @param {{ preflight?: (profile: string, name: string, spec: string) => Promise<object> }} [hooks] - runtime hooks.
 * @param {{ force?: boolean, target?: string, profiles?: string[] }} [options].
 * @returns {Promise<object>} aggregate result with per-profile `items`.
 */
export async function updatePluginAll(name, hooks = {}, options = {}) {
  if (typeof name !== 'string' || !TARGET_RE.test(name)) {
    return { ok: false, code: 'unsafe_target', error: `unsafe plugin target rejected: ${String(name)}` }
  }
  if (running) return { ok: false, code: 'update_running', error: 'another update is already running' }
  const requestedProfiles = Array.isArray(options.profiles) ? new Set(options.profiles) : null
  const profiles = listProfiles().filter((profile) => {
    if (requestedProfiles !== null && !requestedProfiles.has(profile)) return false
    const deps = readDeps(profile)
    if (deps[name] === undefined) return false
    // Same membership rule the radar renders: a package the host does not
    // load as a plugin in this profile never gets an update pass here either.
    const mount = inferMountRelationships(profile, deps)
    if (!pluginMemberNames(profile, deps, mount).has(name)) return false
    const ownership = profileDependencyMetadata(profile, deps, mount).find((dep) => dep.name === name)
    return ownership?.classification === 'aggregate'
      || ownership?.classification === 'local'
      || ownership?.classification === 'independent'
  })
  if (profiles.length === 0) {
    return { ok: false, code: 'not_installed', error: `${name} is not installed in any profile` }
  }

  // The lock spans the WHOLE batch: releasing between profiles would let a
  // concurrent update interleave with the pass and fight over the same
  // profile's node_modules.
  running = true
  try {
    return await runUpdateBatch(name, profiles, hooks, options)
  } finally {
    running = false
  }
}

async function runUpdateBatch(name, profiles, hooks, options) {
  const items = []
  for (const profile of profiles) {
    const spec = readDeps(profile)[name]
    const kind = classifySpec(spec)
    if (kind === 'file') {
      items.push({ profile, ok: false, changed: false, skipped: 'file', code: 'linked_install', error: 'file: installs have no upstream — update them from their own checkout' })
      continue
    }
    if (name.startsWith('@deepseek-ai/')) {
      items.push({ profile, ok: false, changed: false, skipped: 'official', code: 'official_package', error: 'official @deepseek-ai/* packages follow the harness install — update dsh itself' })
      continue
    }
    if (kind !== 'npm' && kind !== 'github') {
      items.push({ profile, ok: false, changed: false, skipped: 'unsupported', code: 'unsupported_channel', error: `${kind} install specs are not auto-updated by the copilot` })
      continue
    }
    const result = await runUpdateForProfile(profile, name, spec, hooks, options)
    if (result.code === 'update_noop') result.current = true // already current → not a failure
    items.push(result)
  }

  const changed = items.some((i) => i.changed === true)
  const allOk = items.every((i) => i.ok === true || i.current === true || i.skipped !== undefined)
  const failures = items.filter((i) => i.skipped === undefined && i.ok !== true && i.current !== true)
  let code = null
  let error = null
  if (!allOk) {
    error = failures.map((f) => `[${f.profile}] ${f.error ?? f.code ?? 'failed'}`).join('\n')
  } else if (!changed) {
    code = 'update_noop'
    error = `${name} is already current in every profile it is installed in`
  }
  const blocked = items.filter((i) => i.code === 'preflight_blocked')
  const risks = items.flatMap((i) => (Array.isArray(i.risks) ? i.risks : []))
  const warnings = items.flatMap((i) => (Array.isArray(i.warnings) ? i.warnings : []))
  // Distinct rollback suggestions (a package may install differently per
  // profile); the first rides the `rollback` shorthand the UI renders.
  const rollbacks = [...new Map(items
    .filter((i) => i.rollback !== null && typeof i.rollback === 'object')
    .map((i) => [i.rollback.target ?? i.rollback.command, i.rollback]))
    .values()]
  const rollback = rollbacks[0]
  const outcome = {
    ok: code === null,
    ...(code !== null ? { code, error } : {}),
    name,
    profileCount: profiles.length,
    changed,
    requiresRestart: items.some((i) => i.requiresRestart === true),
    items,
    ...(failures.length > 0 ? { failures, failuresCount: failures.length } : {}),
    ...(risks.length > 0 ? { risks } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(blocked.length > 0 ? { blocked: blocked.map((i) => ({ profile: i.profile, name: i.name, blockers: i.blockers })) } : {}),
    ...(rollback !== undefined ? { rollback, ...(rollbacks.length > 1 ? { rollbacks } : {}) } : {}),
    output: items.filter((i) => i.output).map((i) => `[${i.profile}]\n${i.output}`).join('\n---\n'),
  }
  recordOp(allOk ? 'info' : 'error', 'update:all:done',
    `${name}: profiles=${profiles.length} changed=${changed} failed=${failures.length}`)
  return outcome
}

/**
 * Loader-entry scan of a profile cordis.patch.yml — delegated to
 * patch-audit.js's parser (indent-aware, guards against `name:` nested
 * inside config blocks), so the audit banner and the core gate read patches
 * through one parser. Exported under the update-side name the gate's tests
 * grew up with.
 */
export const patchNameEntries = parsePatchEntries

/** Normalize an injected target-name collection into a Set; null when the
 *  value carries no usable data (null/undefined/non-iterable/empty). */
function nameSetOf(value) {
  if (value === null || value === undefined || typeof value === 'string' || typeof value?.[Symbol.iterator] !== 'function') return null
  const set = new Set()
  for (const name of value) {
    if (typeof name === 'string' && name !== '') set.add(name)
  }
  return set.size > 0 ? set : null
}

/**
 * Heuristic guess at a rename: the target set contains a dash-extension of
 * the pinned name (`dsh-llm-deepseek` → `dsh-llm-deepseek-api-key`), or a
 * name identical after swapping the trailing `-suffix` segment. Only the
 * extension direction is honored — `name.startsWith(candidate)` would make
 * `@deepseek-ai/dsh` a "rename" of every `dsh-*` package (it is a dash-prefix
 * of them all) and turn the hint into noise. Returns the new-name candidate
 * or null; the result only ever softens the warning message, it never
 * decides whether one is emitted.
 */
function likelyRenamedTo(name, targetNames) {
  const base = (s) => s.replace(/-[^-]*$/, '')
  for (const candidate of targetNames) {
    if (candidate === name) continue
    if (candidate.startsWith(`${name}-`) || base(candidate) === base(name)) return candidate
  }
  return null
}

/**
 * Warning-level findings for profile patch entries pinning a `@deepseek-ai/*`
 * name the target dsh line does not ship. Only scoped names are checked: the
 * loader validates them against the target's own bundle manifest, while a
 * third-party name can never be judged against the target set (checking it
 * would false-alarm every legit entry — 宁漏拦不错拦). No target data (pack
 * failure, null injection) means silence, never a warning.
 */
async function patchNameWarnings({ targetVersion, targetNames }) {
  const pinned = []
  for (const profile of listProfiles()) {
    const file = join(profilesRoot(), profile, 'cordis.patch.yml')
    if (!existsSync(file)) continue
    let text = null
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue // unreadable patch file — the scan surfaces that separately
    }
    for (const row of patchNameEntries(text)) {
      if (typeof row.name === 'string' && row.name.startsWith('@deepseek-ai/')) pinned.push({ profile, id: row.id, name: row.name })
    }
  }
  if (pinned.length === 0) return []
  let names = nameSetOf(targetNames)
  if (names === null && targetNames === undefined) {
    try {
      names = nameSetOf(await targetDshPackageNames(targetVersion))
    } catch {
      names = null // pack failure — degrade to "no data", never a finding
    }
  }
  if (names === null) return []
  const warnings = []
  for (const row of pinned) {
    if (names.has(row.name)) continue
    const renamed = likelyRenamedTo(row.name, names)
    warnings.push({
      type: 'patch-rename',
      layer: 'mount-time',
      specifier: row.name,
      id: row.id,
      profile: row.profile,
      message: renamed !== null
        ? `patch entry "${row.id}" in ${row.profile}/cordis.patch.yml pins name "${row.name}" which is not in the target dsh ${targetVersion} package set — likely renamed to "${renamed}"; the loader silently skips the whole entry (config included). Update the name, or drop the name line so the entry matches by id.`
        : `patch entry "${row.id}" in ${row.profile}/cordis.patch.yml pins name "${row.name}" which is not in the target dsh ${targetVersion} package set — on a strict-name mismatch the loader silently skips the whole entry (config included). Review the patch file before restarting.`,
    })
  }
  return warnings
}

/**
 * Gate findings for one core move (current → targetVersion): the upgrade-card
 * corridor, the session-format storage boundary, and — the expensive half —
 * per-plugin missing-export evidence over every profile's plugin members, in
 * the same finding vocabulary the plugin gate emits. `targetNames` injects
 * the target's `@deepseek-ai/*` package-name set (tests / pre-fetched
 * callers); without it the set is packed from the registry on demand, and a
 * missing set just yields no patch-rename warnings. `warnings` carries the
 * advisory findings (patch entries pinning renamed-away names) — never
 * blockers, never force-gated. Exported for tests; the executor refuses the
 * move when any blocker is present unless forced.
 */
export async function coreGateFindings({ current, targetVersion, profileScans = [], loadTargetExports, targetNames } = {}) {
  const corridor = corridorFindings(current, targetVersion)
  const corridorBlockers = corridor.missingEdge === true
    ? [{
        type: 'corridor',
        layer: 'breaking-card',
        specifier: `dsh ${corridor.from} → ${corridor.to}`,
        missing: [],
        against: 'target',
        hostVersion: targetVersion,
        message: corridor.reason ?? 'missing curated upgrade-card edge',
        disablePatch: null,
        removeCommands: [],
      }]
    : []
  const storage = storageGate({ currentVersion: current, targetVersion })
  const storageBlockers = storage.compatible === false
    ? [{
        type: 'storage',
        layer: 'storage',
        specifier: 'session-format',
        missing: [],
        against: 'target',
        hostVersion: targetVersion,
        message: storage.reason,
        disablePatch: null,
        removeCommands: [],
      }]
    : []
  let pluginBlockers = []
  for (const plugin of pluginScanTargets(profileScans)) {
    try {
      pluginBlockers = pluginBlockers.concat(await gatherTargetBlockers({
        profile: plugin.profiles[0] ?? null,
        name: plugin.name,
        dir: plugin.dir,
        targetVersion,
        ...(loadTargetExports !== undefined ? { loadTargetExports } : {}),
      }))
    } catch (error) {
      recordOp('warn', 'update:core:gate', `${plugin.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const warnings = await patchNameWarnings({ targetVersion, targetNames })
  return { blockers: [...corridorBlockers, ...storageBlockers, ...pluginBlockers], corridor, storage, warnings }
}

/**
 * Loader skip lines in a dump-config run: non-empty output lines matching
 * `mismatch` / `not found` (case-insensitive), deduplicated in first-seen
 * order. The patch loader's strict-name skip is stderr-only and silent
 * everywhere else — these lines are the one honest signal that a profile
 * patch entry will not mount (2026-09-28 llm-deepseek incident). Pure over
 * the captured streams so tests can feed the incident's exact stderr.
 */
export function dumpConfigWarnings({ stdout = '', stderr = '' } = {}) {
  const seen = new Set()
  const rows = []
  for (const bucket of [stdout, stderr]) {
    if (typeof bucket !== 'string' || bucket === '') continue
    for (const line of bucket.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '' || seen.has(trimmed) || !/\b(mismatch|not found)\b/i.test(trimmed)) continue
      seen.add(trimmed)
      rows.push(trimmed)
    }
  }
  return rows
}

/**
 * Post-flight loader probe for the core update: after `npm install -g` has
 * replaced the install, run `dsh --profile <p> --dump-config` for every
 * profile and collect the new loader's own skip lines. This moment is the
 * only honest simulation window: the launcher dshArgv() locates now points
 * at the freshly installed bin, so the spawned dsh IS the new version and
 * its dump-config output is exactly what the next launch's loader will do
 * with each profile's patch file. Best-effort by contract — a failed or
 * timed-out probe is recorded and skipped, never allowed to fail an update
 * that already succeeded.
 */
async function postFlightDumpConfigWarnings() {
  const warnings = []
  const { file, args, viaShell } = dshArgv()
  for (const profile of listProfiles()) {
    try {
      // keepStderr: the loader's skip signal lives on stderr only.
      const out = await execText(file, [...args, '--profile', profile, '--dump-config'], { timeoutMs: 30000, shell: viaShell, keepStderr: true })
      if (out === null) {
        recordOp('warn', 'update:core:postflight', `profile ${profile}: dump-config did not run (missing launcher or timeout)`)
        continue
      }
      for (const line of dumpConfigWarnings(out)) {
        warnings.push({ type: 'dump-config', message: `[${profile}] ${line}` })
      }
    } catch (error) {
      recordOp('warn', 'update:core:postflight', `profile ${profile}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return warnings
}

/**
 * Execute the DSH core update (confirm-and-execute policy, docs/adr/0001).
 * Target: the newest healthy published version (the radar's own line, never
 * a dist-tag string), or an explicit `target` version — the rollback path.
 *
 * Order of refusals, cheapest first: unresolvable target, same-version noop,
 * downgrade without force (a resolved target older than the install is
 * almost never intended), non-global or non-writable install (npx stays
 * report-only — there is no global install to replace), then the full gate
 * (corridor + storage + per-plugin evidence over every profile). Execution
 * runs `npm install -g @deepseek-ai/dsh@<version>` through the shared
 * runner — timeout, jittered retries, fatal signatures. The running process
 * is NEVER the updated one: a change always reports requiresRestart and
 * carries the rollback command (reinstall of the before-version). `io` is
 * the test seam (install/profileScans/npmBin).
 */
export async function updateCore(options = {}) {
  const { target = null, force = false } = options
  if (running) return { ok: false, code: 'update_running', error: 'another update is already running' }
  running = true
  try {
    return await runCoreUpdate({ target, force }, options.io ?? {})
  } finally {
    running = false
  }
}

async function runCoreUpdate({ target, force }, io) {
  const name = '@deepseek-ai/dsh'
  const install = io.install ?? await detectCoreInstall()

  // Fresh registry read: the radar's cached line may be minutes old, and the
  // version pinned here is the one npm will actually install.
  const meta = await npmNewest(name, true)
  let before = null
  if (typeof install.dshDir === 'string' && install.dshDir !== '') {
    const v = readJson(join(install.dshDir, 'package.json'))?.version
    if (typeof v === 'string' && v !== '') before = v
  }
  if (before === null) before = currentDshVersion()

  const resolved = resolveCoreTarget({
    core: { packages: [{ current: before, latest: meta.newest }] },
    target,
    current: before,
  })
  const base = { name, targetVersion: resolved.version ?? null, target: resolved.command ?? null, before, install, attempts: 0 }
  if (resolved.ok !== true) {
    return { ok: false, code: resolved.code, changed: false, ...base, after: before, error: resolved.reason }
  }
  if (resolved.relation === 'same') {
    return { ok: false, code: 'update_noop', changed: false, current: true, ...base, after: before, error: `${name} is already at ${resolved.version}` }
  }
  if (resolved.relation === 'downgrade' && force !== true) {
    return {
      ok: false,
      code: 'core_downgrade_blocked',
      changed: false,
      ...base,
      after: before,
      error: `target ${resolved.version} is OLDER than the installed ${before}. Pass force: true only when the downgrade is intended (undo: npm install -g ${name}@${before}).`,
    }
  }
  if (install.method !== 'global') {
    return {
      ok: false,
      code: 'core_install_unsupported',
      changed: false,
      ...base,
      after: before,
      manualCommand: resolved.command,
      error: install.method === 'npx'
        ? 'dsh runs from the npx cache — there is no global install to replace. Run the pinned command manually or install dsh globally first.'
        : `the running dsh install (${install.method}) could not be traced to the npm global prefix — run the pinned command manually.`,
    }
  }
  if (install.writable !== true) {
    return {
      ok: false,
      code: 'core_prefix_not_writable',
      changed: false,
      ...base,
      after: before,
      manualCommand: resolved.command,
      error: `the npm global prefix (${install.prefix ?? 'unknown'}) is not writable by this process (sudo-managed node) — run the pinned command manually.`,
    }
  }

  setLiveUpdate({ name, profile: null, target: resolved.command })
  try {
    let profileScans = io.profileScans
    if (profileScans === undefined) {
      profileScans = (await Promise.all(listProfiles().map((p) => scanProfile(p, false).catch(() => null)))).filter((s) => s !== null)
    }
    const gate = await coreGateFindings({
      current: before,
      targetVersion: resolved.version,
      profileScans,
      ...(io.loadTargetExports !== undefined ? { loadTargetExports: io.loadTargetExports } : {}),
      ...(io.targetNames !== undefined ? { targetNames: io.targetNames } : {}),
    })
    if (gate.blockers.length > 0 && force !== true) {
      recordOp('warn', 'update:core:gate', `blocked dsh ${before} → ${resolved.version}: ${gate.blockers.length} finding(s)`)
      return {
        ok: false,
        code: 'preflight_blocked',
        changed: false,
        ...base,
        after: before,
        blockers: gate.blockers,
        corridor: gate.corridor,
        storage: gate.storage,
        ...(gate.warnings.length > 0 ? { warnings: gate.warnings } : {}),
        error: `core update blocked: the gate found ${gate.blockers.length} hard finding(s) against dsh ${resolved.version} — review the evidence, then pass force: true to override`,
      }
    }
    const forced = gate.blockers.length > 0 && force === true

    const npmBin = typeof io.npmBin === 'string' && io.npmBin !== '' ? io.npmBin : 'npm'
    const childArgs = ['install', '-g', `${name}@${resolved.version}`]
    const readVersion = () => {
      const v = readJson(join(install.dshDir, 'package.json'))?.version
      return typeof v === 'string' && v !== '' ? v : null
    }
    recordOp('info', 'update:core:start', `dsh ${before} → ${resolved.version}${forced ? ' forced' : ''}`)

    let result = null
    let attempts = 0
    let lastFatal = null
    while (attempts < UPDATE_MAX_ATTEMPTS) {
      attempts += 1
      emitProgress({ type: 'phase', phase: 'start', attempt: attempts, total: UPDATE_MAX_ATTEMPTS })
      try {
        // npm has no non-TTY progress output (only the final "added N
        // packages" summary), so this path stays indeterminate until the
        // end; the shared line parser still catches any stray percentage.
        result = await runPluginAdd(npmBin, childArgs, process.platform === 'win32', (line) => {
          const parsed = parseProgressLine(line)
          if (parsed !== null) {
            emitProgress({ type: 'progress', ...parsed, at: Date.now(), attempt: attempts, total: UPDATE_MAX_ATTEMPTS })
          } else {
            emitProgress({ type: 'line', text: line, attempt: attempts, total: UPDATE_MAX_ATTEMPTS })
          }
        })
      } catch (error) {
        result = { code: 1, timedOut: false, stdout: '', stderr: `spawn error: ${error instanceof Error ? error.message : String(error)}` }
        break
      }
      // A failed attempt may still have replaced the install — never retry
      // over a half-applied update; let the changed/error reporting own it.
      const partial = readVersion() !== before
      const spawnFailure = result.code !== 0 && result.stderr.includes('spawn error:')
      lastFatal = findFatalUpdateError(result)
      const shouldRetry = (result.timedOut || result.code !== 0) && !partial && !spawnFailure && lastFatal === null && attempts < UPDATE_MAX_ATTEMPTS
      if (!shouldRetry) break
      const retryDelay = updateRetryDelayMs(attempts)
      recordOp('warn', 'update:core:retry', `dsh: attempt ${attempts}/${UPDATE_MAX_ATTEMPTS} failed (exit=${result.code}, timeout=${result.timedOut}) — retrying in ${retryDelay}ms`)
      emitProgress({ type: 'retry', attempt: attempts, total: UPDATE_MAX_ATTEMPTS })
      await sleep(retryDelay)
    }

    clearScanCache()
    const after = readVersion()
    const changed = after !== null && after !== before
    const tail = tailOutput(result)
    const attemptNote = attempts > 1 ? `\n(after ${attempts} attempts)` : ''

    let code = null
    let error = null
    if (result.timedOut) {
      code = 'update_timeout'
      error = tail === '' ? `core update timed out after ${attempts} attempt(s)` : `${tail}${attemptNote}`
    } else if (result.code !== 0) {
      code = 'update_failed'
      error = tail === '' ? `core update failed after ${attempts} attempt(s)` : `${tail}${attemptNote}`
      if (lastFatal !== null) error += `\n(no retry: output matches "${lastFatal}" — looks like a permanent failure)`
    } else if (!changed) {
      code = 'update_noop'
      error = `npm finished without errors, but the install still reports ${before ?? 'unknown'} (requested ${resolved.version}). Re-scan and retry; if it still reports no change, check the npm output below.`
    }

    const ok = code === null
    // Post-flight probe only on a real successful replacement (npm install -g
    // has finished, so a spawned dsh is already the new version — see
    // postFlightDumpConfigWarnings). Its output joins the gate's warnings in
    // the same advisory channel; a probe failure never touches the outcome.
    let warnings = gate.warnings
    if (ok === true && changed === true) {
      warnings = warnings.concat(await postFlightDumpConfigWarnings())
    }
    const outcome = {
      ok,
      ...(code !== null ? { code, error } : {}),
      ...(code === 'update_failed' || code === 'update_timeout'
        ? { failureLayer: classifyFailureSignature(`${result.stdout ?? ''}\n${result.stderr ?? ''}\n${error ?? ''}`) }
        : {}),
      changed,
      name,
      targetVersion: resolved.version,
      target: resolved.command,
      before,
      after,
      attempts,
      // The running process keeps the old version until dsh is restarted.
      requiresRestart: changed,
      ...(changed && before !== null ? { rollback: { target: before, command: `npm install -g ${name}@${before}` } } : {}),
      corridor: gate.corridor,
      storage: gate.storage,
      install,
      ...(forced ? { forced: true, blockers: gate.blockers } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      output: tail,
    }
    recordOp(ok ? 'info' : 'error', 'update:core:done',
      `dsh: exit=${result.code} attempts=${attempts} changed=${changed} ${before} → ${after ?? '?'}`)
    return outcome
  } finally {
    clearLiveUpdate()
  }
}

/**
 * Run one `dsh plugin add <target>` with retries, then report the outcome in
 * the shared shape. Used by the npm/github update path.
 *
 * The child runs with pnpm's NDJSON reporter (`--reporter=ndjson`): it is
 * the only non-TTY output that carries byte-level download progress, so
 * `NdjsonProgressTracker` turns its events into the determinate progress
 * the panel renders (bytes → linking), while `ndjsonLineToText` keeps the
 * captured output human-readable and the fatal-signature classification
 * intact (reconstructed `pnpm: <code> <message>` lines).
 */
async function runPnpmUpdate(profile, name, target, { targetVersion = null, repoKey = null, warnings = [] }) {
  const readState = () => ({
    version: installedVersion(profile, name),
    spec: readDeps(profile)[name] ?? null,
    commit: repoKey !== null ? pinnedCommits(profile).get(repoKey) ?? null : null,
  })
  const before = readState()

  recordOp('info', 'update:start', `${profile}/${name} → ${target}`)
  const { file, args, viaShell } = dshArgv()
  const childArgs = [...args, 'plugin', '--profile', profile, 'add', target, '--reporter=ndjson']

  setLiveUpdate({ name, profile, target })
  let result = null
  let attempts = 0
  let lastFatal = null
  while (attempts < UPDATE_MAX_ATTEMPTS) {
    attempts += 1
    emitProgress({ type: 'phase', phase: 'start', attempt: attempts, total: UPDATE_MAX_ATTEMPTS })
    // Fresh tracker per attempt: package sets and byte counters restart.
    const tracker = new NdjsonProgressTracker()
    try {
      result = await runPluginAdd(file, childArgs, viaShell, (line) => {
        const event = tracker.feed(line) ?? parseProgressLine(line)
        if (event !== null) {
          emitProgress({ type: 'progress', ...event, at: event.at ?? Date.now(), attempt: attempts, total: UPDATE_MAX_ATTEMPTS })
        } else {
          emitProgress({ type: 'line', text: line, attempt: attempts, total: UPDATE_MAX_ATTEMPTS })
        }
      }, ndjsonLineToText)
    } catch (error) {
      result = { code: 1, timedOut: false, stdout: '', stderr: `spawn error: ${error instanceof Error ? error.message : String(error)}` }
      break
    }

    // A failed attempt may still have changed disk state (pnpm exit code and
    // installed state occasionally disagree). Never retry over a half-applied
    // update; let the normal changed/error reporting own that outcome.
    const partial = stateChanged(before, readState())
    const spawnFailure = result.code !== 0 && result.stderr.includes('spawn error:')
    lastFatal = findFatalUpdateError(result)
    const shouldRetry = (result.timedOut || result.code !== 0) && !partial && !spawnFailure && lastFatal === null && attempts < UPDATE_MAX_ATTEMPTS
    if (!shouldRetry) break

    const retryDelay = updateRetryDelayMs(attempts)
    recordOp('warn', 'update:retry',
      `${profile}/${name}: attempt ${attempts}/${UPDATE_MAX_ATTEMPTS} failed (exit=${result.code}, timeout=${result.timedOut}) — retrying in ${retryDelay}ms`)
    emitProgress({ type: 'retry', attempt: attempts, total: UPDATE_MAX_ATTEMPTS })
    await sleep(retryDelay)
  }

  try {
    clearScanCache(profile)
    const after = readState()

    const changed = stateChanged(before, after)
    const tail = (result.stdout + (result.stderr ? `\n${result.stderr}` : '')).trim().split('\n').slice(-12).join('\n')
    const attemptNote = attempts > 1 ? `\n(after ${attempts} attempts)` : ''

    let code = null
    let error = null
    if (result.timedOut) {
      code = 'update_timeout'
      error = tail === '' ? `update timed out after ${attempts} attempt(s)` : `${tail}${attemptNote}`
    } else if (result.code !== 0) {
      code = 'update_failed'
      error = tail === '' ? `update failed after ${attempts} attempt(s)` : `${tail}${attemptNote}`
      if (lastFatal !== null) error += `\n(no retry: output matches "${lastFatal}" — looks like a permanent failure)`
    } else if (!changed) {
      code = 'update_noop'
      error = targetVersion !== null
        ? `pnpm finished without errors, but ${name} stayed at ${before.version ?? 'unknown'} (requested ${targetVersion}). Re-scan and retry; if it still reports no change, check the pnpm output below.`
        : 'pnpm finished without errors, but nothing changed. Re-scan and retry; if it still reports no change, check the pnpm output below.'
    }

    const ok = code === null

    const outcome = {
      ok,
      ...(code !== null ? { code, error } : {}),
      ...(code === 'update_failed' || code === 'update_timeout'
        ? { failureLayer: classifyFailureSignature(`${result.stdout ?? ''}\n${result.stderr ?? ''}\n${error ?? ''}`) }
        : {}),
      changed,
      profile,
      name,
      target,
      before,
      after,
      attempts,
      requiresRestart: changed,
      ...(Array.isArray(warnings) && warnings.length > 0 ? { warnings } : {}),
      output: tail,
    }
    recordOp(ok ? 'info' : 'error', 'update:done',
      `${profile}/${name}: exit=${result.code} attempts=${attempts} changed=${changed} ${after.version ?? after.commit?.slice(0, 8) ?? '?'}`)
    return outcome
  } finally {
    clearLiveUpdate()
  }
}
