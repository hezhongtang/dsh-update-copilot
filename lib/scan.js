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
  semverCompare,
} from './util.js'

const SCAN_TTL_MS = 10 * 60 * 1000
const scanCache = new TtlCache(SCAN_TTL_MS)

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

/**
 * Newest published version from the full registry doc — deliberately NOT the
 * `latest` dist-tag: monorepo sub-packages (e.g. @deepseek-ai/dsh-base) often
 * leave that tag stale, which false-flags an install that is actually newer
 * than the tag. The already-fetched doc also yields the GitHub repository,
 * which the GUI links each row to. Concurrent callers share one doc fetch.
 */
async function npmNewest(name) {
  if (npmDocCache.has(name)) return npmDocCache.get(name)
  const promise = (async () => {
    try {
      const doc = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
      let newest = null
      for (const v of Object.keys(doc?.versions ?? {})) {
        if (semverCompare(v, v) !== 0) continue // skip unparsable
        if (newest === null || (semverCompare(v, newest) ?? -1) > 0) newest = v
      }
      return { newest, distLatest: doc?.['dist-tags']?.latest ?? null, repo: repoOf(doc?.repository) }
    } catch {
      return { newest: null, distLatest: null, repo: null }
    }
  })()
  npmDocCache.set(name, promise)
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
async function linkedGitState(dir) {
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
    const { newest, repo } = await npmNewest(name)
    return {
      name,
      kind: name === '@deepseek-ai/dsh' ? 'core' : 'bundle',
      repo,
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
      ? `npm install -g @deepseek-ai/dsh@${core.latest}`
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
          note: 'local checkout — update from its own repo (git pull)',
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
    const { newest, distLatest, repo } = await npmNewest(name)
    return {
      ...base,
      official: name.startsWith(OFFICIAL_PREFIX),
      repo,
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

/** Full scan: core + every profile. Used by the tool, routes, and GUI. */
export async function scanAll(force = false) {
  const [core, profiles] = await Promise.all([
    scanCore(force),
    Promise.all(listProfiles().map((name) => scanProfile(name, force))),
  ])
  const result = {
    generatedAt: new Date().toISOString(),
    core,
    profiles: profiles.filter((p) => p.plugins.length > 0),
    summary: {
      profiles: profiles.filter((p) => p.plugins.length > 0).length,
      plugins: profiles.reduce((sum, p) => sum + p.plugins.length, 0),
      behindPlugins: profiles.reduce((sum, p) => sum + p.behind, 0),
      behindCore: core.packages.filter((p) => p.updateAvailable).length,
    },
  }
  recordOp('info', 'scan', `profiles=${result.summary.profiles} plugins=${result.summary.plugins} behind=${result.summary.behindPlugins} coreBehind=${result.summary.behindCore}`)
  return result
}
