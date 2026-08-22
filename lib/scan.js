/**
 * Version scanner for dsh-update-copilot: DSH core, shipped bundle packages,
 * and every profile's installed plugins. Two channels — npm registry latest
 * for versioned deps, git upstream for github:-pinned and link: checkouts.
 * Read-only by design; updates are executed only after explicit confirmation.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TtlCache,
  execText,
  fetchJson,
  profileDir,
  profilesRoot,
  readJson,
  recordOp,
  repoFromRemote,
  repoOf,
  repoUrlOf,
  semverCompare,
} from './util.js'

const SCAN_TTL_MS = 10 * 60 * 1000
const scanCache = new TtlCache(SCAN_TTL_MS)

/**
 * Drop cached scan rows after an update so the next read re-checks the world
 * instead of reporting the pre-update state for up to 10 minutes. Pass a
 * profile name to clear just that profile; omit it to clear core + profiles.
 */
export function clearScanCache(profile = null) {
  if (profile === null) {
    scanCache.clear()
    return
  }
  scanCache.delete(`profile:${profile}`)
}

const OFFICIAL_PREFIX = '@deepseek-ai/'
const CORE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const GITHUB_SPEC = /^(?:github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#.*)?$/

/** Profile names under the profiles root that hold a package.json. */
export function listProfiles() {
  try {
    return readdirSync(profilesRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'node_modules')
      .map((d) => d.name)
      .filter((name) => existsSync(join(profileDir(name), 'package.json')))
  } catch {
    return []
  }
}

/** Dependencies map of one profile ({}). */
export function readDeps(profile) {
  const manifest = readJson(join(profileDir(profile), 'package.json'))
  return manifest?.dependencies ?? {}
}

/** Installed version from the profile's node_modules, or null. */
export function installedVersion(profile, name) {
  const pkg = readJson(join(profileDir(profile), 'node_modules', name, 'package.json'))
  return typeof pkg?.version === 'string' ? pkg.version : null
}

/** Pinned commit per lowercase `owner/repo` from the lockfile's codeload URLs. */
export function pinnedCommits(profile) {
  const commits = new Map()
  try {
    const lock = readFileSync(join(profileDir(profile), 'pnpm-lock.yaml'), 'utf8')
    for (const m of lock.matchAll(/codeload\.github\.com\/([^/\s]+\/[^/\s]+)\/tar\.gz\/([0-9a-f]{40})/g)) {
      commits.set(m[1].toLowerCase(), m[2])
    }
  } catch { /* no lockfile — nothing pinned */ }
  return commits
}

/** Channel classification for one dependency spec. */
export function classifySpec(spec) {
  if (typeof spec !== 'string') return 'other'
  if (spec.startsWith('link:')) return 'linked'
  if (spec.startsWith('file:')) return 'file'
  if (spec.startsWith('github:')) return 'github'
  if (spec.startsWith('git+') || spec.startsWith('git:')) return 'git'
  if (GITHUB_SPEC.test(spec) && spec.includes('/')) {
    // Bare `owner/repo` shorthand still resolves through GitHub tarballs.
    return 'github'
  }
  if (spec.startsWith('workspace:') || spec.startsWith('catalog:') || spec.startsWith('npm:')) return 'other'
  return 'npm'
}

const npmDocCache = new Map()
const NPM_DOC_TTL_MS = 5 * 60 * 1000

/**
 * Newest published version from the full registry doc — deliberately NOT the
 * `latest` dist-tag: monorepo sub-packages (e.g. @deepseek-ai/dsh-base) often
 * leave that tag stale, which false-flags an install that is actually newer
 * than the tag. The already-fetched doc also yields the GitHub repository,
 * which the GUI links each row to. Concurrent callers share one doc fetch.
 * Cached briefly so freshly published versions show up without a restart;
 * force=true is used by the updater so it acts on the version that exists
 * right now, not the version the last scan happened to see.
 */
export async function npmNewest(name, force = false) {
  const hit = npmDocCache.get(name)
  if (!force && hit !== undefined && Date.now() - hit.at < NPM_DOC_TTL_MS) return hit.value
  const promise = (async () => {
    try {
      const doc = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
      let newest = null
      for (const v of Object.keys(doc?.versions ?? {})) {
        if (semverCompare(v, v) !== 0) continue // skip unparsable
        if (newest === null || (semverCompare(v, newest) ?? -1) > 0) newest = v
      }
      return { newest, distLatest: doc?.['dist-tags']?.latest ?? null, repo: repoOf(doc?.repository), repoUrl: repoUrlOf(doc?.repository) }
    } catch {
      return { newest: null, distLatest: null, repo: null }
    }
  })()
  npmDocCache.set(name, { at: Date.now(), value: promise })
  return promise
}

/** Behind only when the newest published version strictly outranks the installed one. */
function isNewer(latest, current) {
  if (latest === null || current === null) return false
  const cmp = semverCompare(latest, current)
  if (cmp !== null) return cmp > 0
  return latest !== current
}

async function githubHead(repo) {
  try {
    const head = await fetchJson(`https://api.github.com/repos/${repo}/commits/HEAD`)
    return typeof head?.sha === 'string' ? head.sha : null
  } catch {
    return null
  }
}

/** Local vs origin HEAD for a link: checkout, plus its GitHub repo (read-only git queries). */
export async function linkedGitState(dir) {
  const [local, remote, originUrl] = await Promise.all([
    execText('git', ['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 10000 }),
    execText('git', ['ls-remote', 'origin', 'HEAD'], { cwd: dir, timeoutMs: 20000 }),
    execText('git', ['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs: 5000 }),
  ])
  return {
    local: local ?? null,
    upstream: remote ? remote.split(/\s/)[0] : null,
    repo: repoFromRemote(originUrl),
  }
}

/** Version of a package in the flat profiles-level fallback node_modules. */
function flatModuleVersion(name) {
  const pkg = readJson(join(profilesRoot(), 'node_modules', name, 'package.json'))
  return typeof pkg?.version === 'string' ? pkg.version : null
}

/**
 * DSH core + shipped bundle packages. The running install is located through
 * the flat fallback modules first, `dsh --version` as the fallback.
 */
export async function scanCore(force = false) {
  const cached = scanCache.get('core', force)
  if (cached !== undefined) return cached

  let current = flatModuleVersion('@deepseek-ai/dsh')
  let via = 'profiles/node_modules'
  if (current === null) {
    const text = await execText('dsh', ['--version'], { timeoutMs: 15000 })
    const m = text !== null ? /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text) : null
    current = m !== null ? m[1] : null
    via = 'dsh --version'
  }

  const names = ['@deepseek-ai/dsh', ...CORE_BUNDLES]
  const rows = await Promise.all(names.map(async (name) => {
    const installed = name === '@deepseek-ai/dsh'
      ? current
      : flatModuleVersion(name)
    const { newest, repo, repoUrl } = await npmNewest(name, force)
    return {
      name,
      kind: name === '@deepseek-ai/dsh' ? 'core' : 'bundle',
      repo,
      repoUrl,
      current: installed,
      latest: newest,
      updateAvailable: isNewer(newest, installed),
    }
  }))

  const core = rows[0]
  core.note = via
  const result = {
    packages: rows,
    updateCommand: core.updateAvailable
      ? 'npm install -g @deepseek-ai/dsh@latest'
      : null,
    // Policy: the radar never upgrades the harness itself — report only.
    policy: 'core-report-only',
  }
  scanCache.set('core', result)
  return result
}

/** One profile's plugin rows (official + community deps, all channels). */
export async function scanProfile(profile, force = false) {
  const cacheKey = `profile:${profile}`
  const cached = scanCache.get(cacheKey, force)
  if (cached !== undefined) return cached

  const deps = readDeps(profile)
  const lock = pinnedCommits(profile)

  const rows = await Promise.all(Object.entries(deps).map(async ([name, spec]) => {
    const kind = classifySpec(spec)
    const base = { name, spec, kind }

    if (kind === 'linked' || kind === 'file') {
      const dir = spec.replace(/^(link:|file:)/, '').replace(/^file:/, '')
      if (kind === 'linked' && existsSync(join(dir, '.git'))) {
        const { local, upstream, repo } = await linkedGitState(dir)
        return {
          ...base,
          dir,
          repo,
          current: local,
          latest: upstream,
          currentShort: local !== null ? local.slice(0, 7) : null,
          latestShort: upstream !== null ? upstream.slice(0, 7) : null,
          updateAvailable: local !== null && upstream !== null && local !== upstream,
          note: 'local checkout — copilot runs git pull here',
        }
      }
      return { ...base, dir, current: installedVersion(profile, name), latest: null, updateAvailable: false, note: 'local dev link (no git)' }
    }

    if (kind === 'github') {
      const m = GITHUB_SPEC.exec(spec)
      const repo = m !== null ? m[1] : null
      const current = (repo !== null ? lock.get(repo.toLowerCase()) : null) ?? installedVersion(profile, name)
      const latest = repo !== null ? await githubHead(repo) : null
      return {
        ...base,
        repo,
        current,
        latest,
        currentShort: typeof current === 'string' && current.length === 40 ? current.slice(0, 7) : current,
        latestShort: latest !== null ? latest.slice(0, 7) : null,
        updateAvailable: current !== null && latest !== null && current !== latest,
      }
    }

    if (kind === 'git') {
      return { ...base, current: installedVersion(profile, name), latest: null, updateAvailable: false, note: 'raw git spec — compare manually' }
    }

    if (kind === 'other') {
      return { ...base, current: installedVersion(profile, name), latest: null, updateAvailable: false, note: `unrecognized spec channel: ${spec}` }
    }

    // npm channel — covers community plugins and @deepseek-ai/* bundles alike.
    const current = installedVersion(profile, name)
    const { newest, distLatest, repo, repoUrl } = await npmNewest(name, force)
    return {
      ...base,
      official: name.startsWith(OFFICIAL_PREFIX),
      repo,
      repoUrl,
      current,
      latest: newest,
      distLatest,
      updateAvailable: isNewer(newest, current),
    }
  }))

  const result = {
    profile,
    plugins: rows.sort((a, b) => a.name.localeCompare(b.name)),
    behind: rows.filter((r) => r.updateAvailable).length,
  }
  scanCache.set(cacheKey, result)
  return result
}

/**
 * Merge every profile's plugin rows into one package-centric list. The same
 * package installed in several profiles becomes a single row carrying the
 * per-profile details — the update decision is "which package", never "which
 * profile", because the update command is identical for every profile.
 * Pure over the given scan results; exported for unit tests.
 * @param {Array<{profile: string, plugins: object[]}>} profiles - profile scans.
 * @returns {Array<object>} aggregated rows, sorted by package name.
 */
export function aggregateRows(profiles) {
  const byName = new Map()
  for (const p of profiles) {
    for (const row of p.plugins) {
      let agg = byName.get(row.name)
      if (agg === undefined) {
        // No undefined-valued keys: tool results are validated as lossless
        // JSON and an explicit `undefined` fails that check.
        agg = {
          name: row.name,
          official: row.official === true,
          repo: row.repo ?? null,
          repoUrl: row.repoUrl ?? null,
          profiles: [],
        }
        byName.set(row.name, agg)
      }
      if (row.official === true) agg.official = true
      if (agg.category === undefined && row.category !== undefined) agg.category = row.category
      if (agg.repo === null && row.repo !== undefined) agg.repo = row.repo
      if (agg.repoUrl === null && row.repoUrl !== undefined) agg.repoUrl = row.repoUrl
      agg.profiles.push({ profile: p.profile, ...row })
    }
  }
  const result = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  for (const agg of result) {
    let behind = 0
    let canAutoUpdate = false
    let canSwitch = false
    for (const r of agg.profiles) {
      r.canUpdate = r.updateAvailable === true
        && (r.kind === 'npm' || r.kind === 'github' || r.kind === 'linked')
      // Switchable = locally linked, regardless of behind state: switching
      // changes the install channel, it is not an update.
      r.canSwitch = r.kind === 'linked'
      if (r.updateAvailable === true) behind += 1
      if (r.canUpdate) canAutoUpdate = true
      if (r.canSwitch) canSwitch = true
    }
    agg.updateAvailable = behind > 0
    agg.behind = behind
    agg.installedCount = agg.profiles.length
    agg.canAutoUpdate = canAutoUpdate
    agg.canSwitch = canSwitch
  }
  return result
}

/** Full scan: core + every profile's plugins, merged package-centric. */
export async function scanAll(force = false) {
  const [core, profileScans] = await Promise.all([
    scanCore(force),
    Promise.all(listProfiles().map((name) => scanProfile(name, force))),
  ])
  const profiles = profileScans.filter((p) => p.plugins.length > 0)
  const market = { profiles }
  await attachCategories(market)
  const plugins = aggregateRows(profiles)
  const result = {
    generatedAt: new Date().toISOString(),
    core,
    profiles,
    plugins,
    // categories stays absent (never `undefined`) when no dsh-market registry
    // is available — lossless-JSON tool results reject explicit undefined.
    ...(market.categories !== undefined ? { categories: market.categories } : {}),
    summary: {
      profiles: profiles.length,
      plugins: profiles.reduce((sum, p) => sum + p.plugins.length, 0),
      behindPlugins: profiles.reduce((sum, p) => sum + p.behind, 0),
      behindNames: plugins.filter((p) => p.updateAvailable).length,
      behindCore: core.packages.filter((p) => p.updateAvailable).length,
    },
  }
  recordOp('info', 'scan', `profiles=${result.summary.profiles} plugins=${result.summary.plugins} behind=${result.summary.behindPlugins} coreBehind=${result.summary.behindCore}`)
  return result
}

// dsh-market's curated registry, when the plugin is installed. Its bundled
// snapshot maps every plugin to one category (ui, tools, theme, …); we borrow
// that mapping so the radar can label each row. Everything here is optional —
// a missing market or unreachable registry degrades to no labels, never a
// failed scan.
const MARKET_SNAPSHOT_REL = 'dshmarket/data/registry-snapshot.json'
const MARKET_REGISTRY_TTL_MS = 60 * 60 * 1000
const marketRegistryCache = new TtlCache(MARKET_REGISTRY_TTL_MS)

/**
 * Try to read the dsh-market registry (server-side, same host) and annotate
 * every plugin row with its category. The market matches plugins by npm
 * package name (preferred) or `owner/repo`. On any failure, rows are left
 * untouched and `result.categories` is omitted.
 */
async function attachCategories(result) {
  let registry = marketRegistryCache.get('registry')
  if (registry === undefined) {
    registry = loadMarketRegistry()
    if (registry === null) return // no market — leave rows unlabeled
    marketRegistryCache.set('registry', registry)
  }

  const categories = registry.categories ?? {}
  const byName = new Map()
  const byRepo = new Map()
  for (const p of registry.plugins ?? []) {
    const cat = p.category
    if (typeof cat !== 'string' || cat === '') continue
    if (typeof p.npm === 'string' && p.npm !== '') byName.set(p.npm.toLowerCase(), cat)
    if (typeof p.owner === 'string' && typeof p.name === 'string') {
      byRepo.set(`${p.owner}/${p.name}`.toLowerCase(), cat)
    }
  }

  for (const profile of result.profiles) {
    for (const row of profile.plugins) {
      const byNameCat = byName.get(String(row.name).toLowerCase())
      const byRepoCat = row.repo !== undefined && row.repo !== null
        ? byRepo.get(String(row.repo).toLowerCase())
        : undefined
      const cat = byNameCat ?? byRepoCat
      if (cat !== undefined) row.category = cat
    }
  }
  if (Object.keys(categories).length > 0) result.categories = categories
}

/**
 * Locate dshmarket's bundled registry snapshot by walking every profile's
 * node_modules (flat-shared fallback included). Returns null when the market
 * is not installed. The snapshot is static, so reads are cheap and safe.
 */
function loadMarketRegistry() {
  const candidates = []
  for (const name of listProfiles()) candidates.push(join(profileDir(name), 'node_modules', MARKET_SNAPSHOT_REL))
  candidates.push(join(profilesRoot(), 'node_modules', MARKET_SNAPSHOT_REL))
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch { /* keep looking */ }
  }
  return null
}
