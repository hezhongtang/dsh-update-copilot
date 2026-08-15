/**
 * Update executor for dsh-update-copilot. Runs only through the official
 * `dsh plugin` CLI (which forwards to pnpm inside the profile directory),
 * one update at a time, with a strict target allowlist — never raw shell
 * strings. The DSH core stays report-only (its update command is surfaced,
 * not executed). linked/file: installs are refused: they update from their
 * own checkouts.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { classifySpec, clearScanCache, installedVersion, npmNewest, pinnedCommits, readDeps } from './scan.js'
import { recordOp } from './util.js'

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const TARGET_RE = /^(@?[A-Za-z0-9][A-Za-z0-9._/-]*@[A-Za-z0-9][A-Za-z0-9._/-]*)$|^(@?[A-Za-z0-9][A-Za-z0-9._/-]*)(#.*)?$/
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000

let running = false

/** Is an update currently executing? (For 409-style answers in routes/tools.) */
export function isUpdateRunning() {
  return running
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

/**
 * Execute one plugin update.
 * @param {string} profile - profile name.
 * @param {string} name - package name as it appears in the profile dependencies.
 * @returns {Promise<object>} result with changed/before/after/output.
 */
export async function updatePlugin(profile, name) {
  if (!PROFILE_RE.test(profile)) return { ok: false, code: 'invalid_profile', error: `invalid profile name: ${profile}` }
  if (typeof name !== 'string' || !TARGET_RE.test(name)) return { ok: false, code: 'unsafe_target', error: `unsafe plugin target rejected: ${String(name)}` }
  if (running) return { ok: false, code: 'update_running', error: 'another update is already running' }

  const spec = readDeps(profile)[name]
  if (spec === undefined) return { ok: false, code: 'not_installed', error: `${name} is not installed in profile "${profile}"` }
  if (spec.startsWith('link:') || spec.startsWith('file:')) {
    return { ok: false, code: 'linked_install', error: 'locally linked plugins update from their own checkout (git pull there)' }
  }
  if (name.startsWith('@deepseek-ai/')) {
    return { ok: false, code: 'official_package', error: 'official @deepseek-ai/* packages follow the harness install — update dsh itself' }
  }

  const kind = classifySpec(spec)
  if (kind !== 'npm' && kind !== 'github') {
    return { ok: false, code: 'unsupported_channel', error: `${kind} install specs are not auto-updated by the copilot` }
  }

  let target
  let targetVersion = null
  let repoKey = null
  if (kind === 'github') {
    // Reuse the scanner's GitHub parser so repoKey always matches the
    // lockfile's codeload keys (`owner/repo`), even when the spec carries the
    // `github:` prefix.
    const gh = /^(?:github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#.*)?$/.exec(spec)
    repoKey = gh !== null ? gh[1].toLowerCase() : null
    target = spec.replace(/#.*$/, '')
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
      return { ok: false, code: 'latest_unavailable', error: `could not resolve the newest published version of ${name} — retry when the registry is reachable` }
    }
    targetVersion = meta.newest
    target = `${name}@${targetVersion}`
  }
  if (!TARGET_RE.test(target)) return { ok: false, code: 'unsafe_target', error: `unsafe target rejected: ${target}` }

  const readState = () => ({
    version: installedVersion(profile, name),
    spec: readDeps(profile)[name] ?? null,
    commit: repoKey !== null ? pinnedCommits(profile).get(repoKey) ?? null : null,
  })
  const before = readState()

  running = true
  recordOp('info', 'update:start', `${profile}/${name} → ${target}`)
  const { file, args, viaShell } = dshArgv()
  const childArgs = [...args, 'plugin', '--profile', profile, 'add', target]

  let result
  try {
    result = await new Promise((resolvePromise) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      const child = spawn(file, childArgs, {
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
        resolvePromise({ code, timedOut, stdout, stderr })
      }
      child.stdout?.on('data', (chunk) => { stdout = (stdout + chunk).slice(-64 * 1024) })
      child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-32 * 1024) })
      child.on('error', (error) => {
        stderr += `\nspawn error: ${error.message}`
        finish(1)
      })
      child.on('close', (code) => finish(code ?? 1))
    })
  } catch (error) {
    result = { code: 1, timedOut: false, stdout: '', stderr: `spawn error: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    running = false
  }

  clearScanCache(profile)
  const after = readState()

  const changed = after.version !== before.version || after.spec !== before.spec || after.commit !== before.commit
  const tail = (result.stdout + (result.stderr ? `\n${result.stderr}` : '')).trim().split('\n').slice(-12).join('\n')

  let code = null
  let error = null
  if (result.timedOut) {
    code = 'update_timeout'
    error = tail
  } else if (result.code !== 0) {
    code = 'update_failed'
    error = tail
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
    changed,
    profile,
    name,
    target,
    before,
    after,
    requiresRestart: changed,
    output: tail,
  }
  recordOp(ok ? 'info' : 'error', 'update:done',
    `${profile}/${name}: exit=${result.code} changed=${changed} ${after.version ?? after.commit?.slice(0, 8) ?? '?'}`)
  return outcome
}
