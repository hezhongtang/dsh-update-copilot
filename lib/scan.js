/**
 * Version scanner for dsh-update-copilot: DSH core, shipped bundle packages,
 * and every profile's installed plugins. Two channels — npm registry latest
 * for versioned deps, git upstream for github:-pinned and link: checkouts.
 * Read-only by design; updates are executed only after explicit confirmation.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  TtlCache,
  captureProbe,
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
import { attachCompatToPlugins, gatherCompatForScan } from './compat.js'
import { summarizeAvailability, verdictAvailability, worstAvailability } from './availability.js'

const SCAN_TTL_MS = 10 * 60 * 1000
const scanCache = new TtlCache(SCAN_TTL_MS)

const PROBE_FAIL_TTL_MS = 60 * 1000
const probeFailCache = new TtlCache(PROBE_FAIL_TTL_MS)

/**
 * Drop cached scan rows after an update so the next read re-checks the world
 * instead of reporting the pre-update state for up to 10 minutes. Pass a
 * profile name to clear just that profile; omit it to also drop npm-doc and
 * probe-failure caches.
 */
export function clearScanCache(profile = null) {
  if (profile === null) {
    scanCache.clear()
    npmDocCache.clear()
    probeFailCache.clear()
    return
  }
  scanCache.delete(`profile:${profile}`)
}

const OFFICIAL_PREFIX = '@deepseek-ai/'
const CORE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const GITHUB_SPEC = /^(?:github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#([^\s]*))?$/

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

/**
 * The `dsh.profile.bundles` set a profile manifest declares — the host's own
 * list of packages it actually loads. Returns null when the field is missing
 * or empty: every real profile declares at least the base bundles, so an
 * empty list means we misread the manifest rather than "nothing is loaded",
 * and the caller falls back to the historic every-dependency behavior.
 */
export function bundleNamesOf(manifest) {
  const list = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(list)) return null
  const names = list.filter((n) => typeof n === 'string' && n !== '')
  return names.length > 0 ? new Set(names) : null
}

/**
 * Dependencies that qualify as plugin rows for one profile.
 *
 * A plain dependency named in `bundles` is a plugin; so is any link:/file:
 * checkout, which stays visible whether or not it is activated yet (that is
 * how a plugin under development looks). Anything else in the manifest — a
 * CLI, a server runtime, a library someone added for convenience — is not a
 * dsh plugin and must not render as one: such a package sharing a GitHub
 * repo with a real plugin used to produce two update buttons for what looked
 * like one product. Pure over its inputs; exported for unit tests.
 * @param {Record<string, string>} deps - profile dependencies map.
 * @param {Set<string>|null} bundles - bundleNamesOf() result.
 * @returns {Array<[string, string]>} [name, spec] pairs, insertion order kept.
 */
export function pluginEntries(deps, bundles) {
  const entries = Object.entries(deps ?? {})
  if (!(bundles instanceof Set)) return entries
  return entries.filter(([name, spec]) => {
    const kind = classifySpec(spec)
    return kind === 'linked' || kind === 'file' || bundles.has(name)
  })
}

/** Installed version from the profile's node_modules, or null. */
export function installedVersion(profile, name) {
  const pkg = readJson(join(profileDir(profile), 'node_modules', name, 'package.json'))
  return typeof pkg?.version === 'string' ? pkg.version : null
}

/** Installed manifest for one profile dependency, or an empty object. */
function installedManifest(profile, name) {
  return readJson(join(profileDir(profile), 'node_modules', name, 'package.json')) ?? {}
}

/** Names from YAML insert records only; patches are data, never executed. */
export function insertedPackageNames(patch) {
  const names = new Set()
  let insertIndent = null
  let recordIndent = null
  for (const line of patch.split(/\r?\n/)) {
    const insert = /^(\s*)-\s+insert\s*:\s*(?:#.*)?$/.exec(line)
    if (insert !== null) {
      insertIndent = insert[1].length
      recordIndent = null
      continue
    }
    if (insertIndent === null) continue
    const indent = /^\s*/.exec(line)[0].length
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (indent <= insertIndent) {
      insertIndent = null
      recordIndent = null
      continue
    }
    const directRecord = /^(\s*)-\s+(.*)$/.exec(line)
    if (directRecord !== null) {
      if (recordIndent === null) recordIndent = directRecord[1].length
      if (recordIndent === directRecord[1].length) {
        const name = /^name\s*:\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9@][A-Za-z0-9@._/-]*))\s*(?:#.*)?$/.exec(directRecord[2])
        if (name !== null) names.add(name[1] ?? name[2] ?? name[3])
      }
      continue
    }
    if (recordIndent === null || indent <= recordIndent) {
      insertIndent = null
      recordIndent = null
      continue
    }
    const name = new RegExp(`^\\s{${recordIndent + 2}}name\\s*:\\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9@][A-Za-z0-9@._/-]*))\\s*(?:#.*)?$`).exec(line)
    if (name !== null) names.add(name[1] ?? name[2] ?? name[3])
  }
  return names
}

function contained(root, target) {
  const rel = relative(root, target)
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}

function containedPatch(packageDir, patchRel) {
  if (typeof patchRel !== 'string' || patchRel.length === 0) return null
  const patchPath = resolve(packageDir, patchRel)
  if (isAbsolute(patchRel) || !contained(packageDir, patchPath)) return null
  try {
    const realPackageDir = realpathSync(packageDir)
    const realPatchPath = realpathSync(patchPath)
    if (!contained(realPackageDir, realPatchPath)) return null
    return readFileSync(realPatchPath, 'utf8')
  } catch { return null }
}

/** Profile-scoped mount relationships inferred from active bundle patches. */
export function inferMountRelationships(profile, deps) {
  const profileManifest = readJson(join(profileDir(profile), 'package.json')) ?? {}
  const bundles = new Set(Array.isArray(profileManifest.dsh?.profile?.bundles)
    ? profileManifest.dsh.profile.bundles.filter((name) => typeof name === 'string')
    : [])
  const parents = []
  for (const name of Object.keys(deps)) {
    const kind = classifySpec(deps[name])
    if (!bundles.has(name) || name.startsWith(OFFICIAL_PREFIX) || kind === 'linked' || kind === 'file') continue
    const manifest = installedManifest(profile, name)
    const packageDir = join(profileDir(profile), 'node_modules', name)
    const patch = containedPatch(packageDir, manifest.dsh?.bundle?.patch)
    if (patch === null) continue
    const production = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ])
    const children = new Set([...insertedPackageNames(patch)].filter((child) => child !== name && production.has(child)))
    if (children.size >= 2) parents.push({ name, children })
  }
  parents.sort((a, b) => b.children.size - a.children.size || a.name.localeCompare(b.name))
  const relations = []
  for (const parent of parents) {
    for (const child of [...parent.children].sort()) {
      if (deps[child] !== undefined) relations.push({ profile, parent: parent.name, child, evidence: 'patch-insert+production-dependency' })
    }
  }
  const selected = new Map()
  for (const relation of relations) if (!selected.has(relation.child)) selected.set(relation.child, relation.parent)
  return {
    parents: new Set(parents.map((parent) => parent.name)),
    relations: relations.filter((relation) => selected.get(relation.child) === relation.parent),
    selected,
  }
}

/** Ownership metadata for every direct dependency in one profile. */
export function profileDependencyMetadata(profile, deps, mount = inferMountRelationships(profile, deps)) {
  const { parents, selected } = mount

  return Object.entries(deps).map(([name, spec]) => {
    const kind = classifySpec(spec)
    const relation = selected.has(name) ? { mountedBy: selected.get(name) } : {}
    if (name.startsWith(OFFICIAL_PREFIX)) return { name, spec, kind, classification: 'official', ...relation }
    if (kind === 'linked' || kind === 'file') return { name, spec, kind, classification: 'local', ...relation }
    if (parents.has(name)) return { name, spec, kind, classification: 'aggregate', ...relation }
    return { name, spec, kind, classification: 'independent', ...relation }
  })
}

/**
 * The plugin-row membership set for one profile: names in
 * `dsh.profile.bundles` (every dependency when the manifest declares no
 * list), plus link:/file: checkouts, plus verified patch-mounted children.
 * Shared by the scanner and the update executors so a package renders an
 * update button in exactly the profiles where the executor would run one.
 */
export function pluginMemberNames(profile, deps, mount = inferMountRelationships(profile, deps)) {
  const manifest = readJson(join(profileDir(profile), 'package.json'))
  const members = new Set(pluginEntries(deps, bundleNamesOf(manifest)).map(([name]) => name))
  for (const child of mount.selected.keys()) members.add(child)
  return members
}

/**
 * Pinned commit per lowercase `owner/repo` + optional `#fragment` from the
 * lockfile's codeload URLs. The fragment distinguishes several dependencies
 * of the same repo (e.g. `#path:/examples/dsh-memory-plugin` vs the repo
 * root): without it a later URL for the same repo clobbers the earlier one
 * and the reported current commit silently points at the wrong package.
 */
export function pinnedCommits(profile) {
  const commits = new Map()
  try {
    const lock = readFileSync(join(profileDir(profile), 'pnpm-lock.yaml'), 'utf8')
    for (const m of lock.matchAll(/codeload\.github\.com\/([^/\s]+\/[^/\s]+)\/tar\.gz\/([0-9a-f]{40})(#[^\s'"]+)?/g)) {
      commits.set(`${m[1].toLowerCase()}${m[3] ?? ''}`, m[2])
    }
  } catch { /* no lockfile — nothing pinned */ }
  return commits
}

/**
 * Lockfile commit key for a github: spec — `owner/repo` lowercased, plus the
 * `#fragment` verbatim (`#path:/...` and the like). Mirrors pinnedCommits().
 */
export function githubCommitKey(spec) {
  const m = GITHUB_SPEC.exec(spec)
  return m !== null ? `${m[1].toLowerCase()}${m[2] !== undefined ? `#${m[2]}` : ''}` : null
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
  if (!force) {
    const failed = probeFailCache.get(`npm:${name}`)
    if (failed !== undefined) return failed
  }
  const hit = npmDocCache.get(name)
  if (!force && hit !== undefined && Date.now() - hit.at < NPM_DOC_TTL_MS) return hit.value
  let promise
  promise = (async () => {
    const result = await captureProbe(async () => {
      const doc = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
      let newest = null
      for (const v of Object.keys(doc?.versions ?? {})) {
        if (semverCompare(v, v) !== 0) continue // skip unparsable
        if (newest === null || (semverCompare(v, newest) ?? -1) > 0) newest = v
      }
      return { newest, distLatest: doc?.['dist-tags']?.latest ?? null, repo: repoOf(doc?.repository), repoUrl: repoUrlOf(doc?.repository) }
    })
    if (!result.ok) {
      const failure = {
        newest: null,
        distLatest: null,
        repo: null,
        repoUrl: null,
        reached: false,
        reason: result.reason,
        elapsedMs: result.elapsedMs,
      }
      probeFailCache.set(`npm:${name}`, failure)
      const cached = npmDocCache.get(name)
      if (cached !== undefined && cached.value === promise) npmDocCache.delete(name)
      return failure
    }
    probeFailCache.delete(`npm:${name}`)
    return result.value
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

async function githubHead(repo, force = false) {
  const key = `github:${repo}`
  if (!force) {
    const failed = probeFailCache.get(key)
    if (failed !== undefined) return failed
  }
  const result = await captureProbe(async () => {
    const head = await fetchJson(`https://api.github.com/repos/${repo}/commits/HEAD`)
    if (typeof head?.sha !== 'string') throw new Error('GitHub HEAD sha missing')
    return head.sha
  })
  if (!result.ok) {
    const failure = { sha: null, reached: false, reason: result.reason, elapsedMs: result.elapsedMs }
    probeFailCache.set(key, failure)
    return failure
  }
  probeFailCache.delete(key)
  return { sha: result.value }
}

/** Local vs origin HEAD for a link: checkout, plus its GitHub repo (read-only git queries). */
export async function linkedGitState(dir, force = false) {
  const key = `git:${dir}`
  const cachedFail = !force ? probeFailCache.get(key) : undefined
  const [local, remote, originUrl] = await Promise.all([
    execText('git', ['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 10000 }),
    cachedFail !== undefined
      ? Promise.resolve(cachedFail)
      : captureProbe(async () => {
        const text = await execText('git', ['ls-remote', 'origin', 'HEAD'], { cwd: dir, timeoutMs: 20000 })
        if (text === null) throw new Error('git ls-remote origin HEAD failed')
        return text
      }),
    execText('git', ['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs: 5000 }),
  ])
  const repo = repoFromRemote(originUrl)
  if (cachedFail !== undefined) {
    return { local: local ?? null, upstream: null, repo, reached: false, reason: cachedFail.reason, elapsedMs: cachedFail.elapsedMs }
  }
  if (remote.ok === false) {
    const failure = { reached: false, reason: remote.reason, elapsedMs: remote.elapsedMs }
    probeFailCache.set(key, failure)
    return { local: local ?? null, upstream: null, repo, ...failure }
  }
  probeFailCache.delete(key)
  const remoteText = typeof remote === 'object' && remote !== null && 'value' in remote ? remote.value : remote
  return {
    local: local ?? null,
    upstream: remoteText ? String(remoteText).split(/\s/)[0] : null,
    repo,
  }
}

function unreachableFields(probe) {
  if (probe === null || typeof probe !== 'object' || probe.reached !== false) return {}
  return {
    reached: false,
    reason: probe.reason,
    elapsedMs: probe.elapsedMs,
    note: '无法检查 / cannot check',
  }
}

function unreachableSource(row) {
  if (row?.reached !== false) return null
  if (row.kind === 'npm') return 'registry.npmjs.org'
  if (row.kind === 'github' && typeof row.repo === 'string' && row.repo !== '') return `github.com/${row.repo}`
  if (row.kind === 'linked' && typeof row.repo === 'string' && row.repo !== '') return `git:${row.repo}`
  if (row.kind === 'linked') return 'git:origin'
  return 'upstream'
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
    const meta = await npmNewest(name, force)
    return {
      name,
      kind: name === '@deepseek-ai/dsh' ? 'core' : 'bundle',
      classification: 'official',
      repo: meta.repo ?? null,
      repoUrl: meta.repoUrl ?? null,
      current: installed,
      latest: meta.newest,
      updateAvailable: isNewer(meta.newest, installed),
      ...unreachableFields(meta),
    }
  }))

  const core = rows[0]
  if (core.reached !== false) core.note = via
  const result = {
    packages: rows,
    updateCommand: core.updateAvailable
      // Keep the displayed command aligned with the version selected above.
      // npm's dist-tag can intentionally lag the highest published version.
      ? `npm install -g @deepseek-ai/dsh@${core.latest}`
      : null,
    // Policy: the radar never upgrades the harness itself — report only.
    policy: 'core-report-only',
  }
  scanCache.set('core', result)
  return result
}

/**
 * One profile's plugin rows: the dependencies the host actually loads as
 * plugins — names in `dsh.profile.bundles`, visible dev checkouts, and
 * patch-mounted children of active bundles — across all channels. See
 * pluginEntries() for the exact membership rule and
 * inferMountRelationships() for how mounted children are verified.
 */
export async function scanProfile(profile, force = false) {
  const cacheKey = `profile:${profile}`
  const cached = scanCache.get(cacheKey, force)
  if (cached !== undefined) return cached

  const manifest = readJson(join(profileDir(profile), 'package.json'))
  const deps = manifest?.dependencies ?? {}
  const lock = pinnedCommits(profile)
  const bundles = bundleNamesOf(manifest)
  const activeProfileDir = profileDir(profile)

  // Official deps are always scanned too: report-only rows, never plugin rows.
  const mount = inferMountRelationships(profile, deps)
  const members = pluginMemberNames(profile, deps, mount)
  const rows = await Promise.all(profileDependencyMetadata(profile, deps, mount)
    .filter((dep) => members.has(dep.name) || dep.classification === 'official')
    .map(async ({ name, spec, kind, classification, mountedBy }) => {
    const availability = verdictAvailability({
      profileDir: activeProfileDir,
      name,
      spec,
      inBundles: bundles instanceof Set ? bundles.has(name) : false,
    })
    const base = { name, spec, kind, classification, availability, ...(mountedBy === undefined ? {} : { mountedBy }) }

    if (kind === 'linked' || kind === 'file') {
      const dir = spec.replace(/^(link:|file:)/, '').replace(/^file:/, '')
      if (kind === 'linked' && existsSync(join(dir, '.git'))) {
        const state = await linkedGitState(dir, force)
        const unreachable = unreachableFields(state)
        return {
          ...base,
          dir,
          repo: state.repo,
          current: state.local,
          latest: state.upstream,
          currentShort: state.local !== null ? state.local.slice(0, 7) : null,
          latestShort: state.upstream !== null ? state.upstream.slice(0, 7) : null,
          updateAvailable: state.local !== null && state.upstream !== null && state.local !== state.upstream,
          note: unreachable.note ?? 'local checkout — copilot runs git pull here',
          ...unreachable,
        }
      }
      return { ...base, dir, current: installedVersion(profile, name), latest: null, updateAvailable: false, note: 'local dev link (no git)' }
    }

    if (kind === 'github') {
      const m = GITHUB_SPEC.exec(spec)
      const repo = m !== null ? m[1] : null
      const commitKey = githubCommitKey(spec)
      const current = (commitKey !== null ? lock.get(commitKey) : null) ?? installedVersion(profile, name)
      const head = repo !== null ? await githubHead(repo, force) : { sha: null }
      const latest = head?.sha ?? null
      const unreachable = unreachableFields(head)
      return {
        ...base,
        repo,
        current,
        latest,
        currentShort: typeof current === 'string' && current.length === 40 ? current.slice(0, 7) : current,
        latestShort: latest !== null ? latest.slice(0, 7) : null,
        updateAvailable: current !== null && latest !== null && current !== latest,
        ...unreachable,
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
    const meta = await npmNewest(name, force)
    return {
      ...base,
      official: classification === 'official',
      repo: meta.repo ?? null,
      repoUrl: meta.repoUrl ?? null,
      current,
      latest: meta.newest,
      distLatest: meta.distLatest,
      updateAvailable: isNewer(meta.newest, current),
      ...unreachableFields(meta),
    }
  }))

  const plugins = rows.filter((row) => row.classification === 'aggregate' || row.classification === 'local' || row.classification === 'independent')
  const result = {
    profile,
    plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)),
    official: rows.filter((row) => row.classification === 'official').sort((a, b) => a.name.localeCompare(b.name)),
    relationships: mount.relations,
    behind: plugins.filter((row) => row.updateAvailable).length,
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
          mounts: [],
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
  for (const p of profiles) {
    for (const relationship of p.relationships ?? []) {
      const parent = byName.get(relationship.parent)
      if (parent !== undefined) parent.mounts.push({ profile: p.profile, ...relationship })
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
    agg.updatableProfiles = agg.profiles.filter((r) => r.canUpdate).map((r) => r.profile)
    agg.updateAvailable = behind > 0
    agg.behind = behind
    agg.installedCount = agg.profiles.length
    agg.canAutoUpdate = canAutoUpdate
    agg.canSwitch = canSwitch
    const states = agg.profiles.map((r) => r.availability?.state).filter((state) => typeof state === 'string')
    if (states.length > 0) {
      const state = worstAvailability(states)
      const worst = agg.profiles.find((r) => r.availability?.state === state)
      agg.availability = {
        state,
        reasons: typeof worst?.availability?.reasons === 'string' ? worst.availability.reasons : '',
      }
    }
    const unreachableRow = agg.profiles.find((r) => r.reached === false)
    if (unreachableRow !== undefined) {
      agg.reached = false
      agg.reason = unreachableRow.reason
      agg.elapsedMs = unreachableRow.elapsedMs
    }
  }
  return result
}

/** Full scan: core + every profile's plugins, merged package-centric. */
export async function scanAll(force = false) {
  const [core, profileScans] = await Promise.all([
    scanCore(force),
    Promise.all(listProfiles().map((name) => scanProfile(name, force))),
  ])
  const profiles = profileScans.filter((p) => p.plugins.length > 0 || p.relationships.length > 0)
  const market = { profiles }
  await attachCategories(market)
  const plugins = aggregateRows(profiles)
  const reportedProfiles = profileScans.filter((p) => p.plugins.length > 0 || p.official.length > 0 || p.relationships.length > 0)
  const pluginInstallations = profiles.reduce((sum, p) => sum + p.plugins.length, 0)
  const behindInstallations = profiles.reduce((sum, p) => sum + p.behind, 0)
  const uniquePlugins = plugins.length
  const behindPackages = plugins.filter((p) => p.updateAvailable).length
  let compat = { current: { findings: [], hostVersion: null }, target: null }
  try {
    compat = await gatherCompatForScan({ profileScans: reportedProfiles, core, force })
    attachCompatToPlugins(plugins, compat)
  } catch { /* named-export check never fails the version scan */ }
  const compatCount = (compat.current?.findings?.length ?? 0) + (compat.target?.findings?.length ?? 0)
  const pluginInstallRows = profiles.flatMap((p) => p.plugins)
  const availability = summarizeAvailability(pluginInstallRows)
  const unreachableSources = []
  let unreachable = 0
  for (const row of pluginInstallRows) {
    if (row.reached !== false) continue
    unreachable += 1
    const source = unreachableSource(row)
    if (source !== null && !unreachableSources.includes(source)) unreachableSources.push(source)
  }
  for (const row of core.packages ?? []) {
    if (row.reached !== false) continue
    const source = unreachableSource({ ...row, kind: 'npm' })
    if (source !== null && !unreachableSources.includes(source)) unreachableSources.push(source)
  }
  availability.unreachable = unreachable
  availability.unreachableSources = unreachableSources
  const result = {
    generatedAt: new Date().toISOString(),
    core,
    profiles: reportedProfiles,
    plugins,
    compat,
    // categories stays absent (never `undefined`) when no dsh-market registry
    // is available — lossless-JSON tool results reject explicit undefined.
    ...(market.categories !== undefined ? { categories: market.categories } : {}),
    summary: {
      profiles: reportedProfiles.length,
      pluginInstallations,
      uniquePlugins,
      behindInstallations,
      behindPackages,
      // Compatibility aliases for earlier tool and client consumers.
      plugins: pluginInstallations,
      behindPlugins: behindInstallations,
      behindNames: behindPackages,
      // The core packages ship in version lockstep and `npm install -g
      // @deepseek-ai/dsh` brings all of them up at once, so the harness counts
      // as one update item for the badge however many rows are behind.
      behindCore: core.packages.some((p) => p.updateAvailable) ? 1 : 0,
      compatFindings: compatCount,
      availability,
    },
  }
  recordOp('info', 'scan', `profiles=${result.summary.profiles} plugins=${result.summary.plugins} behind=${result.summary.behindPlugins} coreBehind=${result.summary.behindCore} compat=${compatCount} broken=${availability.broken} missing=${availability.missing} unreachable=${availability.unreachable}`)
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
