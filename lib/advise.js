/**
 * Breaking-change signal extraction for the preflight gate. The changelog
 * material between the installed and newest versions — GitHub release notes
 * and compare commits — is scanned for breaking-change markers (conventional
 * `!:` subjects, BREAKING CHANGE lines, remove/rename wording). Signals are
 * informational: they ride the gate's warnings and never block an update.
 *
 * Channels:
 *  - npm: registry doc for the repository URL → GitHub releases.
 *  - github: compare API (current...latest commit subjects) + releases.
 *  - linked/file: no material — no signal.
 * Read-only upstream queries, cached 10 minutes per profile/package/versions.
 */
import { fetchJson, repoOf } from './util.js'
import { readDeps, scanProfile } from './scan.js'
import { breakingFindings } from './preflight.js'

const SIGNAL_TTL_MS = 10 * 60 * 1000
const signalCache = new Map()

function mapReleases(releases) {
  return releases.map((r) => ({
    tag: r.tag_name,
    // GitHub lets a release title be an empty string — fall back to the tag
    // (?? alone would keep '' and match nothing useful).
    name: typeof r.name === 'string' && r.name.trim() !== '' ? r.name : r.tag_name,
    body: typeof r.body === 'string' ? r.body.slice(0, 2000) : '',
  }))
}

async function npmChannelMaterial(name) {
  let repository = null
  try {
    const doc = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
    repository = repoOf(doc?.repository)
  } catch {
    return { releases: [] } // registry unreachable — no signal
  }
  if (repository === null) return { releases: [] }
  try {
    const releases = await fetchJson(`https://api.github.com/repos/${repository}/releases?per_page=5`)
    if (Array.isArray(releases)) return { releases: mapReleases(releases) }
  } catch { /* rate-limited or absent — no signal */ }
  return { releases: [] }
}

async function githubChannelMaterial(repo, current, latest) {
  const material = { commits: [], releases: [] }
  if (repo === null || current === null || latest === null
    || !/^[0-9a-f]{40}$/.test(current) || !/^[0-9a-f]{40}$/.test(latest)) {
    return material
  }
  try {
    const cmp = await fetchJson(`https://api.github.com/repos/${repo}/compare/${current}...${latest}`)
    const commits = Array.isArray(cmp?.commits) ? cmp.commits : []
    material.commits = commits.slice(0, 30).map((c) => ({
      message: typeof c.commit?.message === 'string' ? c.commit.message.split('\n')[0].slice(0, 160) : '',
    }))
  } catch { /* compare unavailable — releases still contribute */ }
  try {
    const releases = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=5`)
    if (Array.isArray(releases)) material.releases = mapReleases(releases)
  } catch { /* degraded */ }
  return material
}

/**
 * Collect breaking-change signals for one package in one profile (the gate's
 * read-only input). Empty when there is no update, no material, or any
 * upstream failure — signals never fail the gate.
 */
export async function collectBreakingSignals(profile, name, force = false) {
  const spec = readDeps(profile)[name]
  if (spec === undefined) return []
  const scan = await scanProfile(profile, force)
  const row = scan.plugins.find((r) => r.name === name)
  if (row === undefined || row.updateAvailable !== true) return []

  const key = `${profile}/${name}/${String(row.current)}..${String(row.latest)}`
  if (!force && signalCache.has(key)) {
    const hit = signalCache.get(key)
    if (Date.now() - hit.at < SIGNAL_TTL_MS) return hit.value
  }

  let material = { releases: [] }
  try {
    if (row.kind === 'npm') material = await npmChannelMaterial(name)
    else if (row.kind === 'github') material = await githubChannelMaterial(row.repo, row.current, row.latest)
  } catch { /* breaking signals never fail the caller */ }
  const signals = breakingFindings({ releases: material.releases ?? [], commits: material.commits ?? [] })
  signalCache.set(key, { at: Date.now(), value: signals })
  return signals
}
