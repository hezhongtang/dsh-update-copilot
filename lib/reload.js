/**
 * Phase-1 runtime hot reload for dsh-update-copilot.
 *
 * After `dsh plugin add` has replaced a profile plugin on disk, this module
 * reloads that plugin inside the currently running DSH process when it is
 * safe to do so:
 *  - the update target is the profile this process booted;
 *  - the package still has a live loader entry with the same module name;
 *  - the package's bundle patch (`dsh.bundle.patch`) did not change, so the
 *    existing loader entry/config remain valid;
 *  - the package's client declaration did not change, so the client-module
 *    table keeps resolving the same client bundle.
 *
 * Anything else (bundle-layer changes, self-update, no running entry, missing
 * loader internals, failed import/reload) falls back to `requiresRestart`.
 *
 * The reload mechanics mirror `@deepseek-ai/cordis-plugin-hmr`'s partial
 * reload: clear Node's ESM/CJS caches for the package directory, re-import
 * the entry, dispose the old registry runtime, and start new fibers on the
 * same parent contexts/configs.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { profileDir, profilesRoot } from './util.js'

const SELF_NAME = 'dsh-update-copilot'

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
 * and `dsh.client` declaration. Both must stay unchanged for phase-1 hot
 * reload to be safe.
 */
export function capturePluginLayout(profile, name) {
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
  return { manifestPath, patchPath, patchFingerprint, clientFingerprint }
}

/** Profile directory of the running process, from the boot include entry. */
function runningProfileDir(ctx) {
  try {
    const include = ctx.loader?.resolve?.('include')
    const filename = include?.subtree?.filename
    if (typeof filename === 'string' && filename !== '') return dirname(filename)
  } catch { /* fall back to baseUrl */ }
  try {
    if (typeof ctx.baseUrl === 'string' && ctx.baseUrl !== '') return fileURLToPath(ctx.baseUrl)
  } catch { /* fall through */ }
  try {
    const baseUrl = ctx.loader?.context?.baseUrl
    if (typeof baseUrl === 'string' && baseUrl !== '') return fileURLToPath(baseUrl)
  } catch { /* no usable profile dir */ }
  return null
}

function sameDirectory(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = resolve(a)
  const right = resolve(b)
  if (left === right) return true
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}

/** Live, enabled loader entries that import the updated package name. */
function targetEntries(ctx, name) {
  const entries = []
  for (const entry of ctx.loader?.entries?.() ?? []) {
    if (entry.options.name !== name) continue
    if (entry.options.group || entry.disabled) continue
    if (entry.fiber?.runtime?.callback === undefined) continue
    entries.push(entry)
  }
  return entries
}

function isWithin(file, dirs) {
  const target = resolve(file)
  for (const dir of dirs) {
    const rel = relative(dir, target)
    if (rel === '') return true
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) continue
    return true
  }
  return false
}

/**
 * Directories whose cached modules belong to the updated package: the
 * manifest's containing directory plus its realpath (pnpm stores packages
 * behind symlinks; Node may cache either spelling).
 */
function packageCacheDirs(manifestPath) {
  if (typeof manifestPath !== 'string' || manifestPath === '') return []
  const dirs = new Set()
  const dir = resolve(dirname(manifestPath))
  dirs.add(dir)
  try {
    dirs.add(realpathSync(dir))
  } catch { /* symlink may be mid-replacement */ }
  return [...dirs]
}

function esmCacheUrls(cache) {
  try {
    return [...cache.keys()]
  } catch {
    try {
      return [...Map.prototype.keys.call(cache)]
    } catch {
      return []
    }
  }
}

function esmCacheDelete(cache, url) {
  try {
    Map.prototype.delete.call(cache, url)
    return true
  } catch {
    try {
      return cache.delete(url)
    } catch {
      return false
    }
  }
}

function esmCacheGet(cache, url) {
  try {
    return Map.prototype.get.call(cache, url)
  } catch {
    try {
      return cache.get(url)
    } catch {
      return undefined
    }
  }
}

function esmCacheSet(cache, url, value) {
  try {
    Map.prototype.set.call(cache, url, value)
  } catch {
    try {
      cache.set(url, value)
    } catch { /* best effort */ }
  }
}

function filePathOfModuleUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return null
    return fileURLToPath(parsed)
  } catch {
    return null
  }
}

/**
 * Back up and clear Node's ESM and CJS module caches for the updated package.
 * The backup lets us restore the previous in-memory world when re-import or
 * fiber reload fails.
 */
function backupAndClearCaches(profile, loader, dirs) {
  const esmCache = loader?.internal?.loadCache
  const esm = new Map()
  if (esmCache !== undefined) {
    for (const url of esmCacheUrls(esmCache)) {
      const file = filePathOfModuleUrl(url)
      if (file === null || !isWithin(file, dirs)) continue
      esm.set(url, esmCacheGet(esmCache, url))
      esmCacheDelete(esmCache, url)
    }
  }

  let requireCache = null
  const cjs = new Map()
  try {
    requireCache = createRequire(join(profileDir(profile), 'noop.js')).cache
  } catch { /* createRequire unavailable — CJS-only cleanup */ }
  if (requireCache !== null && requireCache !== undefined) {
    for (const file of Object.keys(requireCache)) {
      if (!isWithin(file, dirs)) continue
      cjs.set(file, requireCache[file])
      delete requireCache[file]
    }
  }

  return {
    available: esmCache !== undefined,
    restore() {
      for (const [url, value] of esm) esmCacheSet(esmCache, url, value)
      for (const [file, value] of cjs) {
        if (requireCache !== null && requireCache !== undefined) requireCache[file] = value
      }
    },
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Re-register an old plugin callback after a failed swap (best effort). */
async function restoreRuntime(ctx, oldPlugin, oldFibers, getOuterStack) {
  const restored = []
  for (const oldFiber of oldFibers) {
    try {
      const parent = oldFiber.parent
      if (parent?.fiber?.uid === null) continue
      const fiber = parent.registry.plugin(oldPlugin, oldFiber._config, getOuterStack)
      fiber.entry = oldFiber.entry
      if (fiber.entry) fiber.entry.fiber = fiber
      restored.push(fiber)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-update-copilot] failed to restore old plugin runtime: ${errorMessage(error)}`)
    }
  }
  await Promise.allSettled(restored.map((fiber) => fiber.await()))
}

/**
 * Dispose the old runtime and start the freshly imported callback on the same
 * parent contexts. On any failure, the old callback is put back so the
 * process keeps running the previous version.
 */
async function reloadRuntime(ctx, oldPlugin, newPlugin, getOuterStack) {
  const runtime = ctx.registry.get(oldPlugin)
  if (!runtime) return false
  const oldFibers = [...runtime.fibers]
  if (oldFibers.length === 0) return false

  ctx.registry.delete(oldPlugin)
  const created = []
  try {
    for (const oldFiber of oldFibers) {
      const fiber = oldFiber.parent.registry.plugin(newPlugin, oldFiber._config, getOuterStack)
      fiber.entry = oldFiber.entry
      if (fiber.entry) fiber.entry.fiber = fiber
      created.push(fiber)
    }
  } catch (error) {
    try {
      ctx.registry.delete(newPlugin)
    } catch { /* new runtime may not have been created */ }
    await restoreRuntime(ctx, oldPlugin, oldFibers, getOuterStack)
    throw error
  }

  try {
    await Promise.all(created.map((fiber) => fiber.await()))
  } catch (error) {
    try {
      ctx.registry.delete(newPlugin)
    } catch { /* new runtime may already be gone */ }
    await restoreRuntime(ctx, oldPlugin, oldFibers, getOuterStack)
    throw error
  }
  return true
}

/**
 * Build the phase-1 hot reload callback for one running DSH process.
 * @param {object} ctx - the plugin context (carries loader/registry and, in
 * web profiles, clientModules).
 * @returns {(target: object) => Promise<object>} reload callback.
 */
export function createPluginReloader(ctx) {
  if (ctx?.loader?.entries === undefined || ctx?.registry?.get === undefined) return null
  return async function reloadUpdatedPlugin({ profile, name, before }) {
    if (name === SELF_NAME) {
      return { reloaded: false, code: 'self_update', reason: 'self-update reload is deferred — restart dsh to run the new copilot' }
    }

    const running = runningProfileDir(ctx)
    if (running === null || !sameDirectory(running, profileDir(profile))) {
      return { reloaded: false, code: 'profile_not_running', reason: `profile "${profile}" is not the profile booted by this dsh process` }
    }

    const after = capturePluginLayout(profile, name)
    if (before?.manifestPath === null || before?.patchFingerprint === undefined || after.manifestPath === null) {
      return { reloaded: false, code: 'layout_unavailable', reason: 'could not resolve the installed package before and after the update' }
    }
    if (before.patchFingerprint !== after.patchFingerprint) {
      return { reloaded: false, code: 'bundle_patch_changed', reason: 'the updated version changed its dsh.bundle patch — phase 1 falls back to restart' }
    }
    if (before.clientFingerprint !== after.clientFingerprint) {
      return { reloaded: false, code: 'client_decl_changed', reason: 'the updated version changed its dsh.client declaration — restart so clientModules rescans it' }
    }

    const entries = targetEntries(ctx, name)
    if (entries.length === 0) {
      return { reloaded: false, code: 'no_running_entry', reason: `no live loader entry for ${name} in the running process` }
    }
    const callbacks = new Set(entries.map((entry) => entry.fiber.runtime.callback))
    if (callbacks.size !== 1) {
      return { reloaded: false, code: 'ambiguous_runtime', reason: `${name} maps to more than one running plugin callback` }
    }
    const oldPlugin = callbacks.values().next().value

    const dirs = packageCacheDirs(after.manifestPath)
    if (dirs.length === 0) {
      return { reloaded: false, code: 'package_path_unavailable', reason: 'could not derive the updated package directory' }
    }

    const backup = backupAndClearCaches(profile, ctx.loader, dirs)
    if (!backup.available) {
      return { reloaded: false, code: 'module_cache_unavailable', reason: 'Node module caches are not exposed to this loader' }
    }

    const getOuterStack = typeof entries[0].getOuterStack === 'function'
      ? () => entries[0].getOuterStack()
      : () => [`    at dsh-update-copilot:hot-reload(${name})`]

    let newPlugin
    try {
      newPlugin = ctx.loader.unwrapExports(await ctx.loader.import(name, getOuterStack))
    } catch (error) {
      backup.restore()
      return { reloaded: false, code: 'import_failed', reason: `could not import the updated package: ${errorMessage(error)}` }
    }

    try {
      const swapped = await reloadRuntime(ctx, oldPlugin, newPlugin, getOuterStack)
      if (swapped !== true) {
        backup.restore()
        return { reloaded: false, code: 'runtime_disappeared', reason: 'the running plugin runtime disappeared before the swap' }
      }
    } catch (error) {
      backup.restore()
      return { reloaded: false, code: 'reload_failed', reason: `fiber reload failed: ${errorMessage(error)}` }
    }

    // Browser half: re-hash the client bundle so an open web page reloads it.
    try {
      ctx.clientModules?.rebuilt?.(name)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-update-copilot] client bundle rehash failed: ${errorMessage(error)}`)
    }
    return { reloaded: true }
  }
}
