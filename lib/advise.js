/**
 * Update highlights for dsh-update-copilot: per-item changelog summary, semver
 * distance, and a risk classification the agent (or the user) reads before
 * deciding to update. All sources are read-only queries. Every artifact the
 * highlights name carries a clickable URL (npm version pages, GitHub commits,
 * releases, compare views) plus a top-level repoUrl for the item's repository.
 *
 * Channels:
 *  - npm: full registry doc (small for plugins) → versions between current and
 *    latest, publish times, repository URL.
 *  - github: compare API (current...latest commits) + recent releases.
 *  - linked: local git rev-list against origin/HEAD when the ref exists;
 *    commit/compare URLs are derived from the checkout's origin remote.
 */
import { execText } from './util.js'
import { fetchJson, npmPageOf, repoFromRemote, repoOf, repoUrlOf } from './util.js'
import { listProfiles, readDeps, scanProfile } from './scan.js'

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

function mapReleases(releases) {
  return releases.map((r) => ({
    tag: r.tag_name,
    // GitHub lets a release title be an empty string — fall back to the tag
    // (?? alone would keep '' and render a blank link label).
    name: typeof r.name === 'string' && r.name.trim() !== '' ? r.name : r.tag_name,
    publishedAt: r.published_at,
    body: typeof r.body === 'string' ? r.body.slice(0, 2000) : '',
    url: r.html_url,
  }))
}

async function npmChannelBrief(name, current, latest) {
  const brief = { versions: [], releases: [], repository: null, repoUrl: null, note: null }
  let doc = null
  try {
    doc = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
  } catch {
    brief.note = 'registry unreachable — no version metadata'
    return brief
  }
  const times = doc?.time ?? {}
  const repository = repoOf(doc?.repository)
  brief.repository = repository
  // Honors the monorepo `directory` — sub-packages link to their own code.
  brief.repoUrl = repoUrlOf(doc?.repository)

  // Versions strictly between current and latest by publish time, newest first.
  const between = Object.entries(times)
    .filter(([v, t]) => v !== 'created' && v !== 'modified'
      && typeof t === 'string' && v !== current && times[current] !== undefined && t > times[current] && t <= (times[latest] ?? '9999'))
    .sort((a, b) => (a[1] < b[1] ? 1 : -1))
    .slice(0, 12)
  brief.versions = between.map(([version, publishedAt]) => ({
    version, publishedAt, url: `https://www.npmjs.com/package/${name}/v/${version}`,
  }))
  if (times[current] === undefined) brief.note = 'current version not found in registry history (prerelease or unpublished)'

  // Release notes live on GitHub when the package points there.
  if (repository !== null) {
    try {
      const releases = await fetchJson(`https://api.github.com/repos/${repository}/releases?per_page=5`)
      if (Array.isArray(releases)) brief.releases = mapReleases(releases)
    } catch { /* rate-limited or absent — versions list still helps */ }
  }
  return brief
}

async function githubChannelBrief(repo, current, latest) {
  const brief = { commits: [], releases: [], compareUrl: null, repoUrl: null, note: null }
  if (repo === null) {
    brief.note = 'could not parse owner/repo from the install spec'
    return brief
  }
  brief.repoUrl = `https://github.com/${repo}`
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
    if (Array.isArray(releases)) brief.releases = mapReleases(releases)
  } catch { /* degraded */ }
  return brief
}

/**
 * Local-checkout brief. Commit and compare URLs are derived from the
 * checkout's origin remote (GitHub only — other hosts keep plain text so we
 * never link somewhere wrong); the compare view needs the two full SHAs the
 * scanner already captured, since origin/HEAD may not exist locally.
 */
async function linkedChannelBrief(dir, current, latest) {
  const brief = { commits: [], repoUrl: null, compareUrl: null, note: null }
  const originUrl = await execText('git', ['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs: 5000 })
  const repo = repoFromRemote(originUrl)
  if (repo !== null) brief.repoUrl = `https://github.com/${repo}`
  if (repo !== null && /^[0-9a-f]{40}$/.test(String(current ?? '')) && /^[0-9a-f]{40}$/.test(String(latest ?? ''))) {
    brief.compareUrl = `https://github.com/${repo}/compare/${current}...${latest}`
  }
  const count = await execText('git', ['rev-list', '--count', 'HEAD..origin/HEAD'], { cwd: dir, timeoutMs: 10000 })
  if (count !== null) {
    brief.aheadBy = Number(count)
    const log = await execText('git', ['log', '--oneline', '-20', 'HEAD..origin/HEAD'], { cwd: dir, timeoutMs: 10000 })
    brief.commits = (log ?? '').split('\n').filter(Boolean).map((line) => ({
      message: line.replace(/^[0-9a-f]+\s+/, '').slice(0, 160),
      sha: line.slice(0, 8),
      url: repo !== null ? `https://github.com/${repo}/commit/${line.slice(0, 8)}` : undefined,
    }))
  } else if (brief.compareUrl !== null) {
    brief.note = 'origin/HEAD not fetched locally — commit list needs git fetch; the compare view on GitHub is always available'
  } else {
    brief.note = 'origin/HEAD not fetched locally — run `git fetch` in the checkout for commit details'
  }
  return brief
}

/**
 * Build one item's update highlights (cached by profile+name+versions) for a
 * single profile.
 * @returns {object} brief with risk, semver, changelog material, recommendation.
 */
async function buildProfileBrief(profile, name, force = false) {
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
    material = await linkedChannelBrief(row.dir, row.current, row.latest)
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
    // The scan row already knows the repository (registry doc / spec / remote)
    // so even a degraded or already-current brief keeps its repo link.
    repoUrl: material.repoUrl ?? row.repoUrl ?? (row.repo ? `https://github.com/${row.repo}` : null),
    // npm-channel items always carry their package-page link as the fallback
    // for plugins with no resolvable GitHub repository.
    npmUrl: row.kind === 'npm' ? npmPageOf(row.name) : null,
    material,
    recommendation: recommendationText(row, risk),
  }
  briefCache.set(key, { at: Date.now(), value: brief })
  return brief
}

/**
 * Build update highlights for one package. With `profile`, the result is one
 * profile's brief; without it — the default — every profile that has the
 * package installed contributes a per-profile brief, since the update command
 * is identical for all of them. The profile-less shape is the one the
 * package-centric radar uses.
 * @returns {object} brief — single-profile shape, or aggregated `{ items }`.
 */
export async function buildBrief(name, profile = null, force = false) {
  if (typeof name !== 'string' || name === '') return { error: 'name is required' }
  if (profile !== null && profile !== '') return buildProfileBrief(profile, name, force)

  const profiles = listProfiles().filter((p) => readDeps(p)[name] !== undefined)
  if (profiles.length === 0) return { error: `${name} is not installed in any profile` }

  const items = (await Promise.all(profiles.map((p) => buildProfileBrief(p, name, force))))
    .filter((b) => b.error === undefined)
  if (items.length === 0) return { error: `${name} is not installed in any profile` }
  return {
    name,
    profileCount: items.length,
    updateAvailable: items.some((b) => b.updateAvailable === true),
    items,
  }
}

function recommendationText(row, risk) {
  if (!row.updateAvailable) return 'Already current — nothing to do.'
  if (risk.level === 'low') return 'Safe to update: patch-level fixes only.'
  if (risk.level === 'medium') return 'Update is usually safe; skim the release notes for behavior changes first.'
  if (risk.level === 'high') return 'Hold: major version jump. Read the migration notes, check dsh peer ranges, then decide.'
  if (row.kind === 'linked') return 'Review the listed commits in your checkout, then `git pull` there yourself.'
  return 'No semver signal: read the commits/release notes linked in the brief, then decide.'
}
