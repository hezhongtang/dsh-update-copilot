/**
 * Decision briefs for dsh-update-copilot: per-item changelog summary, semver
 * distance, and a risk classification the agent (or the user) reads before
 * deciding to update. All sources are read-only queries.
 *
 * Channels:
 *  - npm: full registry doc (small for plugins) → versions between current and
 *    latest, publish times, repository URL.
 *  - github: compare API (current...latest commits) + recent releases.
 *  - linked: local git rev-list against origin/HEAD when the ref exists.
 */
import { execText } from './util.js'
import { fetchJson } from './util.js'
import { readDeps, scanProfile } from './scan.js'

const BRIEF_TTL_MS = 10 * 60 * 1000
const briefCache = new Map()

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/

function parseSemver(version) {
  const m = typeof version === 'string' ? SEMVER.exec(version) : null
  if (m === null) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

/** Counts of major/minor/patch steps between two versions (null when unparsable). */
export function semverDistance(current, latest) {
  const a = parseSemver(current)
  const b = parseSemver(latest)
  if (a === null || b === null) return null
  return {
    major: Math.max(0, b.major - a.major),
    minor: b.major === a.major ? Math.max(0, b.minor - a.minor) : b.minor,
    patch: b.major === a.major && b.minor === a.minor ? Math.max(0, b.patch - a.patch) : b.patch,
  }
}

/** Risk label from semver distance and channel knowledge. */
export function classifyRisk(row) {
  if (row.kind === 'linked') return { level: 'medium', reason: 'local checkout moved against upstream — review the commits yourself' }
  if (row.kind === 'github') {
    return {
      level: 'unknown',
      reason: 'commit-pinned channel: no semver signal — read the commit list / release notes before updating',
    }
  }
  const d = semverDistance(row.current, row.latest)
  if (d === null) return { level: 'unknown', reason: 'non-semver version strings — manual review needed' }
  if (d.major > 0) return { level: 'high', reason: `major bump (${d.major}×): breaking changes are possible — check the migration notes` }
  if (d.minor > 0) return { level: 'medium', reason: `minor bump (${d.minor}×): new features, usually backward-compatible` }
  if (d.patch > 0) return { level: 'low', reason: `patch bump (${d.patch}×): fixes only, low risk` }
  return { level: 'none', reason: 'no semver step detected' }
}

/** GitHub `owner/repo` from a repository URL, or null. */
function repoOf(url) {
  if (typeof url !== 'string') return null
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)
  return m !== null ? m[1] : null
}

async function npmChannelBrief(name, current, latest) {
  const brief = { versions: [], releases: [], repository: null, note: null }
  let doc = null
  try {
    doc = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
  } catch {
    brief.note = 'registry unreachable — no version metadata'
    return brief
  }
  const times = doc?.time ?? {}
  const repository = repoOf(typeof doc?.repository === 'string' ? doc.repository : doc?.repository?.url)
  brief.repository = repository

  // Versions strictly between current and latest by publish time, newest first.
  const between = Object.entries(times)
    .filter(([v, t]) => v !== 'created' && v !== 'modified'
      && typeof t === 'string' && v !== current && times[current] !== undefined && t > times[current] && t <= (times[latest] ?? '9999'))
    .sort((a, b) => (a[1] < b[1] ? 1 : -1))
    .slice(0, 12)
  brief.versions = between.map(([version, publishedAt]) => ({ version, publishedAt }))
  if (times[current] === undefined) brief.note = 'current version not found in registry history (prerelease or unpublished)'

  // Release notes live on GitHub when the package points there.
  if (repository !== null) {
    try {
      const releases = await fetchJson(`https://api.github.com/repos/${repository}/releases?per_page=5`)
      if (Array.isArray(releases)) {
        brief.releases = releases.map((r) => ({
          tag: r.tag_name, name: r.name ?? r.tag_name,
          publishedAt: r.published_at,
          body: typeof r.body === 'string' ? r.body.slice(0, 1500) : '',
          url: r.html_url,
        }))
      }
    } catch { /* rate-limited or absent — versions list still helps */ }
  }
  return brief
}

async function githubChannelBrief(repo, current, latest) {
  const brief = { commits: [], releases: [], compareUrl: null, note: null }
  if (repo === null) {
    brief.note = 'could not parse owner/repo from the install spec'
    return brief
  }
  if (current !== null && latest !== null && /^[0-9a-f]{40}$/.test(current) && /^[0-9a-f]{40}$/.test(latest)) {
    try {
      const cmp = await fetchJson(`https://api.github.com/repos/${repo}/compare/${current}...${latest}`)
      brief.compareUrl = cmp?.html_url ?? `https://github.com/${repo}/compare/${current.slice(0, 8)}...${latest.slice(0, 8)}`
      const commits = Array.isArray(cmp?.commits) ? cmp.commits : []
      brief.commits = commits.slice(0, 30).map((c) => ({
        sha: typeof c.sha === 'string' ? c.sha.slice(0, 8) : null,
        message: typeof c.commit?.message === 'string' ? c.commit.message.split('\n')[0].slice(0, 160) : '',
        url: c.html_url,
      }))
      brief.aheadBy = typeof cmp?.ahead_by === 'number' ? cmp.ahead_by : commits.length
    } catch {
      brief.note = 'GitHub compare unavailable (rate limit or network) — open the repo compare page manually'
      brief.compareUrl = `https://github.com/${repo}/compare/${current.slice(0, 8)}...${latest.slice(0, 8)}`
    }
  }
  try {
    const releases = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=5`)
    if (Array.isArray(releases)) {
      brief.releases = releases.map((r) => ({
        tag: r.tag_name, name: r.name ?? r.tag_name,
        publishedAt: r.published_at,
        body: typeof r.body === 'string' ? r.body.slice(0, 1500) : '',
        url: r.html_url,
      }))
    }
  } catch { /* degraded */ }
  return brief
}

async function linkedChannelBrief(dir) {
  const brief = { commits: [], note: null }
  const count = await execText('git', ['rev-list', '--count', 'HEAD..origin/HEAD'], { cwd: dir, timeoutMs: 10000 })
  if (count !== null) {
    brief.aheadBy = Number(count)
    const log = await execText('git', ['log', '--oneline', '-20', 'HEAD..origin/HEAD'], { cwd: dir, timeoutMs: 10000 })
    brief.commits = (log ?? '').split('\n').filter(Boolean).map((line) => ({ message: line.replace(/^[0-9a-f]+\s+/, '').slice(0, 160), sha: line.slice(0, 8) }))
  } else {
    brief.note = 'origin/HEAD not fetched locally — run `git fetch` in the checkout for commit details'
  }
  return brief
}

/**
 * Build one item's decision brief (cached by profile+name+versions).
 * @returns {object} brief with risk, semver, changelog material, recommendation.
 */
export async function buildBrief(profile, name, force = false) {
  const spec = readDeps(profile)[name]
  if (spec === undefined) {
    return { error: `${name} is not a dependency of profile "${profile}"` }
  }
  const scan = await scanProfile(profile, force)
  const row = scan.plugins.find((r) => r.name === name)
  if (row === undefined) return { error: `no scan row for ${name}` }

  const key = `${profile}/${name}/${String(row.current)}..${String(row.latest)}`
  if (!force && briefCache.has(key)) {
    const hit = briefCache.get(key)
    if (Date.now() - hit.at < BRIEF_TTL_MS) return hit.value
  }

  let material = { note: 'nothing to summarize — already current' }
  if (!row.updateAvailable) {
    // still return risk none with empty material
  } else if (row.kind === 'npm') {
    material = await npmChannelBrief(name, row.current, row.latest)
  } else if (row.kind === 'github') {
    material = await githubChannelBrief(row.repo, row.current, row.latest)
  } else if (row.kind === 'linked') {
    material = await linkedChannelBrief(row.dir)
  }

  const risk = classifyRisk(row)
  const semver = semverDistance(row.current, row.latest)
  const brief = {
    profile,
    name,
    kind: row.kind,
    current: row.current,
    latest: row.latest,
    semver,
    risk,
    updateAvailable: row.updateAvailable,
    material,
    recommendation: recommendationText(row, risk),
  }
  briefCache.set(key, { at: Date.now(), value: brief })
  return brief
}

function recommendationText(row, risk) {
  if (!row.updateAvailable) return 'Already current — nothing to do.'
  if (risk.level === 'low') return 'Safe to update: patch-level fixes only.'
  if (risk.level === 'medium') return 'Update is usually safe; skim the release notes for behavior changes first.'
  if (risk.level === 'high') return 'Hold: major version jump. Read the migration notes, check dsh peer ranges, then decide.'
  if (row.kind === 'linked') return 'Review the listed commits in your checkout, then `git pull` there yourself.'
  return 'No semver signal: read the commits/release notes linked in the brief, then decide.'
}
