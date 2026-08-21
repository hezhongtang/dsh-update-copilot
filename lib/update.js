/**
 * Update executor for dsh-update-copilot. npm/github specs run only through
 * the official `dsh plugin` CLI (which forwards to pnpm inside the profile
 * directory), one update at a time, with a strict target allowlist — never
 * raw shell strings. link: checkouts update through git pull in their own
 * directory (auto stash → pull → stash pop, conflicts reported for manual
 * handling). The DSH core stays report-only (its update command is surfaced,
 * not executed). file: installs are refused: they have no upstream.
 *
 * Package-centric: `updatePluginAll` runs the same per-profile executor in
 * every profile that has the package installed, because the update command
 * is identical for all profiles.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { classifySpec, clearScanCache, installedVersion, linkedGitState, listProfiles, npmNewest, pinnedCommits, profileDependencyMetadata, readDeps } from './scan.js'
import { recordOp, repoFromRemote } from './util.js'
import { capturePluginLayout } from './reload.js'

export const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const TARGET_RE = /^(@?[A-Za-z0-9][A-Za-z0-9._/-]*@[A-Za-z0-9][A-Za-z0-9._/-]*)$|^((?:github:)?@?[A-Za-z0-9][A-Za-z0-9._/-]*)(#.*)?$/

/** Hard timeout for one `dsh plugin add` attempt. */
export const UPDATE_TIMEOUT_MS = 5 * 60 * 1000
/** Total attempts for one plugin update (1 initial + 2 retries by default). */
export const UPDATE_MAX_ATTEMPTS = 3
/** Backoff between failed attempts (milliseconds); last value repeats. */
export const UPDATE_RETRY_DELAYS_MS = [1000, 3000]
/** Agent-tool timeout: worst-case attempts + backoff + one minute of margin. */
export const UPDATE_TOOL_TIMEOUT_MS = UPDATE_TIMEOUT_MS * UPDATE_MAX_ATTEMPTS
  + UPDATE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)
  + 60 * 1000

let running = false

/** Is an update currently executing? (For 409-style answers in routes/tools.) */
export function isUpdateRunning() {
  return running
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

/** Forward one progress event to the live slot, if any (no-op in the agent tool path). */
export function emitProgress(event) {
  if (progressSub !== null) progressSub.handler(event)
}

/** Parse pnpm-style progress out of a raw output line, if any. */
export function parseProgressLine(line) {
  // "Progress: resolved 12, reused 8, downloaded 4, added 2" or
  // " Downloading ... | 42%"
  const resolved = /Progress:\s*resolved\s+(\d+)\s*,/.exec(line)
  if (resolved !== null) {
    const done = /reused\s+(\d+)\s*,/.exec(line)
    const added = /added\s+(\d+)\s*,/.exec(line)
    const total = Number(resolved[1])
    const current = (done !== null ? Number(done[1]) : 0) + (added !== null ? Number(added[1]) : 0)
    if (total > 0) return { percent: Math.min(100, Math.round((current / total) * 100)), phase: 'resolving' }
  }
  const pct = /\|\s*(\d{1,3})%/.exec(line)
  if (pct !== null) {
    const n = Number(pct[1])
    if (n >= 0 && n <= 100) return { percent: n, phase: 'downloading' }
  }
  return null
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
 * Run one `dsh plugin add` attempt with a hard timeout. Returns the exit code
 * and the captured output tails; never throws for spawn failures. `onLine`
 * receives every emitted output line (stdout + stderr) for live progress.
 */
function runPluginAdd(file, args, viaShell, onLine = null) {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
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
      resolvePromise({ code, timedOut, stdout, stderr })
    }
    const onData = (chunk) => {
      if (onLine !== null) {
        const text = chunk.toString('utf8')
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim()
          if (trimmed.length > 0) onLine(trimmed)
        }
      }
    }
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-64 * 1024)
      onData(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-32 * 1024)
      onData(chunk)
    })
    child.on('error', (error) => {
      stderr += `\nspawn error: ${error.message}`
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
 * Run one `git` command inside a checkout with a hard timeout. Returns the
 * exit code and the captured output tails; never throws for spawn failures.
 * `onLine` receives every emitted output line (stdout + stderr) for live
 * progress. Deliberately no CI env and no shell — git runs directly.
 */
function runGit(dir, args, timeoutMs, onLine = null) {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const child = spawn('git', args, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      timedOut = true
      killChild(child)
    }, timeoutMs)
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, timedOut, stdout, stderr })
    }
    const onData = (chunk) => {
      if (onLine !== null) {
        const text = chunk.toString('utf8')
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim()
          if (trimmed.length > 0) onLine(trimmed)
        }
      }
    }
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-64 * 1024)
      onData(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-32 * 1024)
      onData(chunk)
    })
    child.on('error', (error) => {
      stderr += `\nspawn error: ${error.message}`
      finish(1)
    })
    child.on('close', (code) => finish(code ?? 1))
  })
}

/** Is a merge in progress (pull left a MERGE_HEAD behind)? */
function mergeInProgress(dir) {
  return existsSync(join(dir, '.git', 'MERGE_HEAD'))
}

/** HEAD commit of a checkout, or null. */
async function linkedHead(dir) {
  const { stdout } = await runGit(dir, ['rev-parse', 'HEAD'], 10000)
  return stdout.trim() !== '' ? stdout.trim() : null
}

/** Worktree cleanliness (untracked files excluded — stash keeps them in place). */
async function linkedDirty(dir) {
  const { stdout } = await runGit(dir, ['status', '--porcelain'], 10000)
  return stdout.trim() !== ''
}

/** Commits ahead of origin/HEAD, or null when the ref is missing. */
async function linkedAhead(dir) {
  const { stdout } = await runGit(dir, ['rev-list', '--count', 'origin/HEAD..HEAD'], 10000)
  return stdout.trim() !== '' ? Number(stdout.trim()) : null
}

/** Current branch name, or null on a detached HEAD. */
async function linkedBranch(dir) {
  const { stdout } = await runGit(dir, ['branch', '--show-current'], 10000)
  return stdout.trim() !== '' ? stdout.trim() : null
}

/** Upstream branch of the current branch (git rev-parse --abbrev-ref @{u}), or null. */
async function linkedUpstream(dir) {
  const { stdout } = await runGit(dir, ['rev-parse', '--abbrev-ref', '@{u}'], 10000)
  return stdout.trim() !== '' ? stdout.trim() : null
}

/** Full state snapshot of a link: checkout (scan-compatible + updater extras). */
async function linkedState(dir) {
  const [head, dirty, ahead, branch, upstream, scan] = await Promise.all([
    linkedHead(dir),
    linkedDirty(dir),
    linkedAhead(dir),
    linkedBranch(dir),
    linkedUpstream(dir),
    linkedGitState(dir),
  ])
  return { commit: head, dirty, ahead, branch, upstream: scan?.upstream ?? null, upstreamBranch: upstream }
}

/**
 * Run the linked-channel update for one `link:` plugin: auto stash → git pull
 * (with retries) → stash pop. Conflicts are never auto-resolved — a merge
 * conflict or a failed pop reports the exact state and hands the checkout
 * back to the user. Shares the single-flight `running` lock and the progress
 * bus with the pnpm channel; the result mirrors the pnpm outcome shape plus
 * a `stash` summary.
 */
async function updateLinkedPlugin(profile, name, spec, hooks) {
  const dir = spec.replace(/^link:/, '')
  if (typeof dir !== 'string' || dir === '') {
    return { ok: false, code: 'linked_no_git', error: `invalid link: spec for ${name}: ${spec}` }
  }
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, code: 'linked_no_git', error: `no git checkout at ${dir} — link: updates run git pull in the checkout directory` }
  }
  if (running) return { ok: false, code: 'update_running', error: 'another update is already running' }

  const reload = typeof hooks.reload === 'function' ? hooks.reload : null
  running = true
  try {
    const before = await linkedState(dir)
    // A checkout without an upstream branch (or on a detached HEAD) cannot
    // move with `git pull` — report it instead of pretending nothing changed.
    if (before.upstreamBranch === null) {
      return {
        ok: false, code: 'linked_no_upstream', changed: false,
        profile, name, target: spec, before, after: before,
        stash: { stashed: false, popped: false, conflict: false },
        attempts: 0, hotReloaded: false, requiresRestart: false,
        error: `the checkout at ${dir} has no upstream branch configured — run \`git push -u\` to set one, or update it manually`,
        output: '',
      }
    }
    let beforeLayout = null
    if (reload !== null) {
      try {
        beforeLayout = capturePluginLayout(profile, name)
      } catch (layoutError) {
        recordOp('warn', 'update:layout', `${profile}/${name}: ${layoutError instanceof Error ? layoutError.message : String(layoutError)}`)
        beforeLayout = { manifestPath: null, patchPath: null, patchFingerprint: null, clientFingerprint: null }
      }
    }

    recordOp('info', 'update:start', `${profile}/${name} (link: ${dir}) local=${before.commit !== null ? before.commit.slice(0, 8) : '?'} upstream=${before.upstream !== null ? before.upstream.slice(0, 8) : '?'} dirty=${before.dirty} ahead=${before.ahead}`)

    // 1. Stash local changes (tracked files only — untracked stay in place).
    const stash = { stashed: false, popped: false, conflict: false }
    if (before.dirty) {
      emitProgress({ type: 'phase', phase: 'stash', attempt: 1, total: 1 })
      const stashed = await runGit(dir, ['stash', 'push', '-m', 'dsh-update-copilot auto-stash'], 60000)
      if (stashed.code !== 0) {
        const tail = tailOutput(stashed)
        return {
          ok: false, code: 'linked_stash_failed', changed: false,
          profile, name, target: spec, before, after: before,
          stash, attempts: 1, hotReloaded: false, requiresRestart: false,
          error: tail === '' ? 'could not stash local changes' : tail,
          output: tail,
        }
      }
      stash.stashed = true
    }

    // 2. git pull, retried on failures — except merge conflicts, which need a
    //    human (git merge --abort or resolving manually).
    let pullResult = null
    let attempts = 0
    while (attempts < UPDATE_MAX_ATTEMPTS) {
      attempts += 1
      emitProgress({ type: 'phase', phase: 'pull', attempt: attempts, total: UPDATE_MAX_ATTEMPTS })
      pullResult = await runGit(dir, ['pull'], UPDATE_TIMEOUT_MS)
      if (pullResult.code === 0 || mergeInProgress(dir)) break
      if (attempts >= UPDATE_MAX_ATTEMPTS) break
      const retryDelay = UPDATE_RETRY_DELAYS_MS[Math.min(attempts - 1, UPDATE_RETRY_DELAYS_MS.length - 1)]
      recordOp('warn', 'update:retry', `${profile}/${name}: pull attempt ${attempts}/${UPDATE_MAX_ATTEMPTS} failed (exit=${pullResult.code}, timeout=${pullResult.timedOut}) — retrying in ${retryDelay}ms`)
      emitProgress({ type: 'retry', attempt: attempts, total: UPDATE_MAX_ATTEMPTS })
      await sleep(retryDelay)
    }

    // 3. Restore stashed local changes.
    if (stash.stashed) {
      emitProgress({ type: 'phase', phase: 'pop', attempt: 1, total: 1 })
      const popped = await runGit(dir, ['stash', 'pop'], 60000)
      stash.popped = popped.code === 0
      stash.conflict = popped.code !== 0
    }

    const after = await linkedState(dir)
    const changed = before.commit !== after.commit
    const tail = tailOutput(pullResult)
    const attemptNote = attempts > 1 ? `\n(after ${attempts} attempts)` : ''

    let code = null
    let error = null
    if (stash.conflict) {
      code = 'linked_stash_pop_conflict'
      error = `the pull succeeded, but restoring your stashed local changes conflicted. Resolve it manually in ${dir}: run \`git stash list\` and \`git stash pop\` to retry the restore.`
    } else if (mergeInProgress(dir)) {
      code = 'linked_merge_conflict'
      error = `git pull stopped on a merge conflict in ${dir}. Resolve it manually or run \`git merge --abort\` to undo, then retry.`
    } else if (pullResult.timedOut) {
      code = 'linked_timeout'
      error = tail === '' ? `git pull timed out after ${attempts} attempt(s)` : `${tail}${attemptNote}`
    } else if (pullResult.code !== 0) {
      code = 'linked_pull_failed'
      error = tail === '' ? `git pull failed after ${attempts} attempt(s)` : `${tail}${attemptNote}`
    } else if (!changed) {
      code = 'update_noop'
      error = `git pull finished, but ${name} stayed at ${String(before.commit).slice(0, 8) ?? 'unknown'}. Re-scan and retry; if it still reports no change, check the git output below.`
    }

    const ok = code === null
    let hotReloaded = false
    let reloadOutcome = null
    if (ok && changed && reload !== null) {
      try {
        reloadOutcome = await reload({ profile, name, before: beforeLayout })
        hotReloaded = reloadOutcome?.reloaded === true
      } catch (reloadError) {
        reloadOutcome = {
          reloaded: false,
          code: 'reload_exception',
          reason: reloadError instanceof Error ? reloadError.message : String(reloadError),
        }
      }
      recordOp(hotReloaded ? 'info' : 'warn', 'update:reload',
        `${profile}/${name}: ${hotReloaded ? 'reloaded' : (reloadOutcome?.code ?? 'skipped')}`)
    }

    const outcome = {
      ok,
      ...(code !== null ? { code, error } : {}),
      changed,
      profile,
      name,
      target: spec,
      before,
      after,
      stash,
      attempts,
      hotReloaded,
      requiresRestart: changed && !hotReloaded,
      ...(reloadOutcome !== null ? { reload: reloadOutcome } : {}),
      output: tail,
    }
    recordOp(ok ? 'info' : 'error', 'update:done',
      `${profile}/${name}: exit=${pullResult.code} attempts=${attempts} changed=${changed} stashed=${stash.stashed} popConflict=${stash.conflict} hotReloaded=${hotReloaded} ${after.commit?.slice(0, 8) ?? '?'}`)
    return outcome
  } finally {
    running = false
  }
}

function tailOutput(result) {
  return (result.stdout + (result.stderr ? `\n${result.stderr}` : '')).trim().split('\n').slice(-12).join('\n')
}

/**
 * Switch a link: dependency to a remote spec: the published npm version when
 * the package exists on the registry, else `github:owner/repo#<origin HEAD>`
 * from the checkout's own remote. The local link breaks — after this, the
 * dependency follows the normal npm/github update channel. Destructive, so
 * callers (UI/agent) must require explicit confirmation before reaching here.
 */
async function switchLinkedPluginToRemote(profile, name, spec, hooks) {
  const dir = spec.replace(/^link:/, '')
  if (typeof dir !== 'string' || dir === '') {
    return { ok: false, code: 'linked_no_git', error: `invalid link: spec for ${name}: ${spec}` }
  }
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, code: 'linked_no_git', error: `no git checkout at ${dir} — cannot switch to a remote source` }
  }
  if (running) return { ok: false, code: 'update_running', error: 'another update is already running' }

  running = true
  try {
    const before = { spec }
    recordOp('info', 'update:start', `${profile}/${name} switch link → remote (${dir})`)

    // npm registry first — an exact version is the most stable remote spec.
    const meta = await npmNewest(name, true)
    let target = null
    let channel = null
    if (meta.newest !== null) {
      target = `${name}@${meta.newest}`
      channel = 'npm'
    } else {
      // Fall back to the checkout's own GitHub remote + its origin HEAD sha.
      const originUrl = await runGit(dir, ['remote', 'get-url', 'origin'], 10000)
      const repo = repoFromRemote(originUrl.stdout)
      const state = await linkedGitState(dir)
      if (repo !== null && state.upstream !== null) {
        target = `github:${repo}#${state.upstream}`
        channel = 'github'
      }
    }
    if (target === null) {
      return {
        ok: false, code: 'linked_switch_unavailable', changed: false,
        profile, name, target: spec, before, after: before,
        attempts: 0, hotReloaded: false, requiresRestart: false,
        error: `no npm release for ${name} and no usable GitHub remote at ${dir} — cannot switch to a remote source`,
        output: '',
      }
    }
    if (!TARGET_RE.test(target)) return { ok: false, code: 'unsafe_target', error: `unsafe target rejected: ${target}` }

    // dsh plugin add replaces the existing link: spec in place (verified).
    const outcome = await runPnpmUpdate(profile, name, target, { reload: typeof hooks.reload === 'function' ? hooks.reload : null, targetVersion: channel === 'npm' ? target.split('@').pop() : null })

    // Report the switch explicitly: the spec rewrite is the real change.
    const afterSpec = readDeps(profile)[name] ?? null
    const switched = afterSpec !== null && afterSpec !== spec
    return {
      ...outcome,
      ...(switched ? { switched: { from: spec, to: afterSpec, channel } } : {}),
      ...(!switched && outcome.ok ? {
        ok: false,
        code: 'linked_switch_spec_unchanged',
        error: `the dependency spec was not rewritten (still ${spec}). Handle the switch manually.`,
      } : {}),
    }
  } finally {
    running = false
  }
}

/**
 * Execute one plugin update.
 * @param {string} profile - profile name.
 * @param {string} name - package name as it appears in the profile dependencies.
 * @param {{ reload?: (target: object) => Promise<object> }} [hooks] - optional
 * runtime hooks; `reload` hot-reloads the updated plugin in this process.
 * @param {{ source?: 'local' | 'remote' }} [options] - for link: checkouts,
 * `source: 'remote'` switches the dependency to a remote spec instead of
 * pulling in the checkout directory.
 * @returns {Promise<object>} result with changed/before/after/output.
 */
export async function updatePlugin(profile, name, hooks = {}, options = {}) {
  if (!PROFILE_RE.test(profile)) return { ok: false, code: 'invalid_profile', error: `invalid profile name: ${profile}` }
  if (typeof name !== 'string' || !TARGET_RE.test(name)) return { ok: false, code: 'unsafe_target', error: `unsafe plugin target rejected: ${String(name)}` }
  if (running) return { ok: false, code: 'update_running', error: 'another update is already running' }

  const reload = typeof hooks.reload === 'function' ? hooks.reload : null

  const spec = readDeps(profile)[name]
  if (spec === undefined) return { ok: false, code: 'not_installed', error: `${name} is not installed in profile "${profile}"` }
  const ownership = profileDependencyMetadata(profile, readDeps(profile)).find((dep) => dep.name === name)
  if (ownership?.classification === 'official') {
    return { ok: false, code: 'official_package', error: 'official @deepseek-ai/* packages follow the harness install — update dsh itself' }
  }
  if (ownership?.classification === 'aggregate-managed') {
    return { ok: false, code: 'aggregate_managed', error: `${name} is managed by ${ownership.managedBy} and cannot be updated independently` }
  }
  if (spec.startsWith('file:')) {
    return { ok: false, code: 'linked_install', error: 'file: installs have no upstream — update them from their own checkout' }
  }
  const kind = classifySpec(spec)
  // link: checkouts update through git pull in their own directory — before
  // the official-package check, since a local checkout is the developer's own
  // code regardless of the package name it is linked as. `source: 'remote'`
  // switches the dependency to a published spec instead.
  if (kind === 'linked') {
    if (options.source === 'remote') return switchLinkedPluginToRemote(profile, name, spec, hooks)
    return updateLinkedPlugin(profile, name, spec, hooks)
  }
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

  return runPnpmUpdate(profile, name, target, { reload, targetVersion, repoKey })
}

/**
 * Execute one update for a package across every profile that has it installed
 * — the "global" one-click update. Each profile runs through the regular
 * per-profile executor (its own channel, its own spec), sequentially; the
 * update command is identical for every profile, so the caller never picks
 * one. Profiles whose install channel cannot auto-update (file:, official
 * @deepseek-ai/*, unsupported specs) are reported as skipped, not failures.
 * A profile that is already current reports `current: true` and does not fail
 * the aggregate.
 * @param {string} name - package name as it appears in profile dependencies.
 * @param {{ reload?: (target: object) => Promise<object> }} [hooks] - runtime hooks.
 * @param {{ source?: 'local' | 'remote' }} [options] - for link: checkouts.
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
    const ownership = profileDependencyMetadata(profile, deps).find((dep) => dep.name === name)
    return ownership?.classification === 'aggregate'
      || ownership?.classification === 'local'
      || ownership?.classification === 'independent'
  })
  if (profiles.length === 0) {
    return { ok: false, code: 'not_installed', error: `${name} is not installed in any profile` }
  }

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
    if (kind !== 'npm' && kind !== 'github' && kind !== 'linked') {
      items.push({ profile, ok: false, changed: false, skipped: 'unsupported', code: 'unsupported_channel', error: `${kind} install specs are not auto-updated by the copilot` })
      continue
    }
    const result = await updatePlugin(profile, name, hooks, options)
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
  const outcome = {
    ok: code === null,
    ...(code !== null ? { code, error } : {}),
    name,
    profileCount: profiles.length,
    changed,
    hotReloaded: items.some((i) => i.hotReloaded === true),
    requiresRestart: items.some((i) => i.requiresRestart === true),
    items,
    ...(failures.length > 0 ? { failures, failuresCount: failures.length } : {}),
    output: items.filter((i) => i.output).map((i) => `[${i.profile}]\n${i.output}`).join('\n---\n'),
  }
  recordOp(allOk ? 'info' : 'error', 'update:all:done',
    `${name}: profiles=${profiles.length} changed=${changed} failed=${failures.length} hotReloaded=${outcome.hotReloaded}`)
  return outcome
}

/**
 * Run one `dsh plugin add <target>` with retries, then report the outcome in
 * the shared shape. Shared by the npm/github update path and the linked→remote
 * switch path.
 */
async function runPnpmUpdate(profile, name, target, { reload, targetVersion = null, repoKey = null }) {
  const readState = () => ({
    version: installedVersion(profile, name),
    spec: readDeps(profile)[name] ?? null,
    commit: repoKey !== null ? pinnedCommits(profile).get(repoKey) ?? null : null,
  })
  const before = readState()
  let beforeLayout = null
  if (reload !== null) {
    try {
      beforeLayout = capturePluginLayout(profile, name)
    } catch (layoutError) {
      recordOp('warn', 'update:layout', `${profile}/${name}: ${layoutError instanceof Error ? layoutError.message : String(layoutError)}`)
      beforeLayout = { manifestPath: null, patchPath: null, patchFingerprint: null, clientFingerprint: null }
    }
  }

  recordOp('info', 'update:start', `${profile}/${name} → ${target}`)
  const { file, args, viaShell } = dshArgv()
  const childArgs = [...args, 'plugin', '--profile', profile, 'add', target]

  running = true
  let result = null
  let attempts = 0
  while (attempts < UPDATE_MAX_ATTEMPTS) {
    attempts += 1
    emitProgress({ type: 'phase', phase: 'start', attempt: attempts, total: UPDATE_MAX_ATTEMPTS })
    try {
      result = await runPluginAdd(file, childArgs, viaShell, (line) => {
        const parsed = parseProgressLine(line)
        if (parsed !== null) {
          emitProgress({ type: 'progress', ...parsed, attempt: attempts, total: UPDATE_MAX_ATTEMPTS })
        } else {
          emitProgress({ type: 'line', text: line, attempt: attempts, total: UPDATE_MAX_ATTEMPTS })
        }
      })
    } catch (error) {
      result = { code: 1, timedOut: false, stdout: '', stderr: `spawn error: ${error instanceof Error ? error.message : String(error)}` }
      break
    }

    // A failed attempt may still have changed disk state (pnpm exit code and
    // installed state occasionally disagree). Never retry over a half-applied
    // update; let the normal changed/error reporting own that outcome.
    const partial = stateChanged(before, readState())
    const spawnFailure = result.code !== 0 && result.stderr.includes('spawn error:')
    const shouldRetry = (result.timedOut || result.code !== 0) && !partial && !spawnFailure && attempts < UPDATE_MAX_ATTEMPTS
    if (!shouldRetry) break

    const retryDelay = UPDATE_RETRY_DELAYS_MS[Math.min(attempts - 1, UPDATE_RETRY_DELAYS_MS.length - 1)]
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
    } else if (!changed) {
      code = 'update_noop'
      error = targetVersion !== null
        ? `pnpm finished without errors, but ${name} stayed at ${before.version ?? 'unknown'} (requested ${targetVersion}). Re-scan and retry; if it still reports no change, check the pnpm output below.`
        : 'pnpm finished without errors, but nothing changed. Re-scan and retry; if it still reports no change, check the pnpm output below.'
    }

    const ok = code === null
    let hotReloaded = false
    let reloadOutcome = null
    if (ok && changed && reload !== null) {
      try {
        reloadOutcome = await reload({ profile, name, before: beforeLayout })
        hotReloaded = reloadOutcome?.reloaded === true
      } catch (reloadError) {
        reloadOutcome = {
          reloaded: false,
          code: 'reload_exception',
          reason: reloadError instanceof Error ? reloadError.message : String(reloadError),
        }
      }
      recordOp(hotReloaded ? 'info' : 'warn', 'update:reload',
        `${profile}/${name}: ${hotReloaded ? 'reloaded' : (reloadOutcome?.code ?? 'skipped')}`)
    }

    const outcome = {
      ok,
      ...(code !== null ? { code, error } : {}),
      changed,
      profile,
      name,
      target,
      before,
      after,
      attempts,
      hotReloaded,
      requiresRestart: changed && !hotReloaded,
      ...(reloadOutcome !== null ? { reload: reloadOutcome } : {}),
      output: tail,
    }
    recordOp(ok ? 'info' : 'error', 'update:done',
      `${profile}/${name}: exit=${result.code} attempts=${attempts} changed=${changed} hotReloaded=${hotReloaded} ${after.version ?? after.commit?.slice(0, 8) ?? '?'}`)
    return outcome
  } finally {
    running = false
  }
}
