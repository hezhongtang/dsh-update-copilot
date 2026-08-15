/**
 * Update executor for dsh-update-copilot. Runs only through the official
 * `dsh plugin` CLI (which forwards to pnpm inside the profile directory),
 * one update at a time, with a strict target allowlist — never raw shell
 * strings. The DSH core stays report-only (its update command is surfaced,
 * not executed). linked/file: installs are refused: they update from their
 * own checkouts.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pinnedCommits, installedVersion, readDeps } from './scan.js'
import { profileDir } from './util.js'
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
  if (!PROFILE_RE.test(profile)) return { ok: false, error: `invalid profile name: ${profile}` }
  if (typeof name !== 'string' || !TARGET_RE.test(name)) return { ok: false, error: `unsafe plugin target rejected: ${String(name)}` }
  if (running) return { ok: false, error: 'another update is already running' }

  const spec = readDeps(profile)[name]
  if (spec === undefined) return { ok: false, error: `${name} is not installed in profile "${profile}"` }
  if (spec.startsWith('link:') || spec.startsWith('file:')) {
    return { ok: false, error: 'locally linked plugins update from their own checkout (git pull there)' }
  }
  if (name.startsWith('@deepseek-ai/')) {
    return { ok: false, error: 'official @deepseek-ai/* packages follow the harness install — update dsh itself' }
  }

  const isGithub = spec.startsWith('github:') || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(#|$)/.test(spec)
  const target = isGithub ? spec.replace(/#.*$/, '') : `${name}@latest`
  if (!TARGET_RE.test(target)) return { ok: false, error: `unsafe target rejected: ${target}` }

  const repoKey = isGithub ? target.toLowerCase() : null
  const before = {
    version: installedVersion(profile, name),
    commit: repoKey !== null ? pinnedCommits(profile).get(repoKey) ?? null : null,
  }

  running = true
  recordOp('info', 'update:start', `${profile}/${name} → ${target}`)
  const { file, args, viaShell } = dshArgv()
  const childArgs = [...args, 'plugin', '--profile', profile, 'add', target]

  const result = await new Promise((resolvePromise) => {
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

  const after = {
    version: installedVersion(profile, name),
    commit: repoKey !== null ? pinnedCommits(profile).get(repoKey) ?? null : null,
  }
  running = false

  const changed = after.version !== before.version || after.commit !== before.commit
  const tail = (result.stdout + (result.stderr ? `\n${result.stderr}` : '')).trim().split('\n').slice(-12).join('\n')
  const outcome = {
    ok: result.code === 0 && !result.timedOut,
    changed,
    profile,
    name,
    target,
    before,
    after,
    requiresRestart: changed,
    output: tail,
  }
  recordOp(result.code === 0 ? 'info' : 'error', 'update:done',
    `${profile}/${name}: exit=${result.code} changed=${changed} ${after.version ?? after.commit?.slice(0, 8) ?? '?'}`)
  return outcome
}
