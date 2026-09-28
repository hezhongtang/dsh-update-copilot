/**
 * DSH core install detection and dual-mode target resolution.
 *
 * The core executor (update.js `updateCore`) may only run `npm install -g`
 * when the running harness itself is a writable global npm install — an npx
 * launch has no global install to replace (executing there would create a
 * parallel install nobody runs), and an untraceable launch gives no honest
 * before/after version. Detection lives here, next to the pure target
 * resolution both the executor and the GUI chips consume:
 *
 *  - `pinned`  — the newest healthy published version (the radar's own line,
 *                never the `latest` dist-tag; sub-package tags lag systemically).
 *  - `tag`     — a dist-tag channel (latest / next / alpha). The tag resolves
 *                to its concrete version FIRST; the executed command always
 *                pins that version, and a resolved downgrade is reported so
 *                the caller can refuse it without force.
 */
import { accessSync, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execText, semverCompare } from './util.js'
import { locateDshPackageDir } from './compat.js'

/** The tag shape the route/executor accept (npm dist-tag name rules). */
export const DIST_TAG_RE = /^[a-z][a-z0-9-]*$/

/** A version the executor may pass to `npm install` — semver-ish only. */
export const CORE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/

let prefixPromise = null

/** `npm prefix -g`, memoized for the process lifetime — the prefix never moves. */
function npmGlobalPrefix() {
  if (prefixPromise === null) {
    prefixPromise = execText('npm', ['prefix', '-g'], { timeoutMs: 15000 })
      .then((text) => (text !== null && text.trim() !== '' ? text.trim() : null))
      .catch(() => null)
  }
  return prefixPromise
}

/**
 * Pure classification of a dsh package directory against install roots.
 * `globalModulesRoot` is `<npm prefix -g>/lib/node_modules`; `npxRoot` is
 * `~/.npm/_npx` (the zero-install cache `npx @deepseek-ai/dsh` runs from).
 */
export function classifyCoreInstall({ dshDir = null, globalModulesRoot = null, npxRoot = null } = {}) {
  if (typeof dshDir !== 'string' || dshDir === '') return { method: 'unknown', dshDir: null }
  const under = (root) => typeof root === 'string' && root !== ''
    && (dshDir === root || dshDir.startsWith(`${root}/`) || dshDir.startsWith(`${root}\\`))
  if (under(globalModulesRoot)) return { method: 'global', dshDir, globalModulesRoot }
  if (under(npxRoot)) return { method: 'npx', dshDir, npxRoot }
  return { method: 'other', dshDir }
}

/**
 * Where is the RUNNING dsh installed, and can the copilot replace it?
 * Resolves `npm prefix -g` once, classifies the running package directory
 * (never the flat profiles fallback — that copy is materialized per launch,
 * not the install `npm install -g` rewrites), and checks write access on it.
 */
export async function detectCoreInstall(argv1 = process.argv[1]) {
  const dshDir = locateDshPackageDir(argv1, { fallbackFlat: false })
  if (dshDir === null) {
    return { method: 'unknown', dshDir: null, prefix: null, writable: false }
  }
  const prefix = await npmGlobalPrefix()
  const classified = classifyCoreInstall({
    dshDir,
    globalModulesRoot: prefix !== null ? join(prefix, 'lib', 'node_modules') : null,
    npxRoot: join(homedir(), '.npm', '_npx'),
  })
  let writable = false
  try {
    // npm replaces this exact directory on `install -g`; write access on it
    // is the honest proxy for "the prefix is ours" (root-owned prefixes fail).
    accessSync(dshDir, fsConstants.W_OK)
    writable = true
  } catch { /* not writable — the executor reports and hands back the command */ }
  return { ...classified, prefix, writable }
}

/**
 * Resolve the core update target for one mode. Pure over the scan data so the
 * GUI chips and the executor agree by construction. `target` (an explicit
 * version — the rollback path) wins over both modes and is validated to
 * semver-ish characters before it can ever reach an `npm install` spec.
 *
 * @returns on failure `{ ok: false, code, reason }`; on success
 * `{ ok: true, mode, tag, version, current, relation, command }` where
 * `relation` is upgrade / downgrade / same against `current` and `command`
 * always pins the concrete version.
 */
export function resolveCoreTarget({ core = null, mode = 'pinned', tag = null, target = null, current = null } = {}) {
  const coreRow = core?.packages?.[0]
  const cur = typeof current === 'string' && current !== ''
    ? current
    : (typeof coreRow?.current === 'string' && coreRow.current !== '' ? coreRow.current : null)

  if (typeof target === 'string' && target !== '') {
    if (!CORE_VERSION_RE.test(target)) {
      return { ok: false, code: 'unsafe_target', reason: `unsafe target rejected: ${target}` }
    }
    return finishTarget({ mode: 'explicit', tag: null, version: target, current: cur })
  }

  if (mode === 'tag') {
    const name = typeof tag === 'string' && tag !== '' ? tag : 'latest'
    if (!DIST_TAG_RE.test(name)) {
      return { ok: false, code: 'unknown_tag', reason: `invalid dist-tag: ${name}` }
    }
    const version = core?.distTags?.[name]
    if (typeof version !== 'string' || version === '') {
      return { ok: false, code: 'unknown_tag', reason: `dist-tag "${name}" does not exist for @deepseek-ai/dsh` }
    }
    return finishTarget({ mode, tag: name, version, current: cur })
  }

  const newest = typeof coreRow?.latest === 'string' && coreRow.latest !== '' ? coreRow.latest : null
  if (newest === null) {
    return { ok: false, code: 'target_unavailable', reason: 'could not resolve the newest published dsh version' }
  }
  return finishTarget({ mode: 'pinned', tag: null, version: newest, current: cur })
}

function finishTarget({ mode, tag, version, current }) {
  const cmp = current !== null ? semverCompare(version, current) : null
  return {
    ok: true,
    mode,
    tag,
    version,
    current,
    relation: cmp === 0 ? 'same' : (cmp !== null && cmp < 0 ? 'downgrade' : 'upgrade'),
    // Never execute the tag itself: by the time npm resolves it, it may point
    // elsewhere than the version the user just approved.
    command: `npm install -g @deepseek-ai/dsh@${version}`,
  }
}
