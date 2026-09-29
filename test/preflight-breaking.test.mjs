// Breaking-change signals (lib/preflight.js breakingFindings): heuristic
// line-level markers over the changelog material the collector fetches —
// release bodies and commit subjects. Purely informational: a hit is never a
// gate blocker, and missing material degrades to no signal.
import test from 'node:test'
import assert from 'node:assert/strict'
import { breakingFindings } from '../lib/preflight.js'

test('conventional-bang subjects, BREAKING CHANGE bodies, and removal verbs hit', () => {
  const findings = breakingFindings({
    commits: [
      { message: 'feat(ui)!: rename code-mode to ptc' },
      { message: 'fix: correct an off-by-one' },
      { sha: 'abc', message: 'refactor: remove ApiProxy package' },
    ],
    releases: [
      { tag: 'v2', name: 'v2.0.0', body: '## Changes\n- BREAKING CHANGE: settings RPCs are gone\n- drop the legacy Host event carriers\nThe gallery renders faster now.' },
    ],
  })
  assert.equal(findings.length, 4)
  assert.ok(findings.every((f) => f.type === 'breaking'))
  // Evidence keeps the original line, trimmed; commit hits carry source.
  assert.equal(findings[0].source, 'commit')
  assert.equal(findings[0].line, 'feat(ui)!: rename code-mode to ptc')
  const releaseLines = findings.filter((f) => f.source === 'release').map((f) => f.line)
  assert.ok(releaseLines.some((line) => line.includes('BREAKING CHANGE')))
  assert.ok(releaseLines.some((line) => line.includes('drop the legacy')))
})

test('Chinese markers hit: 移除 / 删除 / 更名 / 重命名 / 废弃', () => {
  const findings = breakingFindings({
    commits: [
      { message: 'feat!: 移除 ApiProxy 包' },
      { message: 'fix: 更名 web 伪协议' },
      { message: 'docs: 废弃旧示例' },
      { message: 'chore: 清理注释' },
    ],
  })
  assert.equal(findings.length, 3)
})

test('clean material produces no signal', () => {
  assert.deepEqual(breakingFindings({
    commits: [
      { message: 'fix: correct an off-by-one' },
      { message: 'docs: refresh the readme' },
    ],
    releases: [{ tag: 'v1', name: 'v1.0.1', body: 'Patch release: performance and stability.' }],
  }), [])
})

test('empty or missing material degrades to no signal; hits cap at ten', () => {
  assert.deepEqual(breakingFindings({}), [])
  assert.deepEqual(breakingFindings(null), [])
  const many = { commits: Array.from({ length: 20 }, (_, i) => ({ message: `fix${i}!: 移除 thing ${i}` })) }
  assert.equal(breakingFindings(many).length, 10)
})

// ---------------------------------------------------------------------------
// Collector integration (lib/advise.js collectBreakingSignals): a fake
// DSH_HOME with one outdated npm plugin and a mocked registry/GitHub — the
// release-note marker must reach the gate's warnings; an up-to-date package
// or an unreachable upstream degrades to no signal.
// ---------------------------------------------------------------------------
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-breaking-'))
process.env.DSH_HOME = home

mkdirSync(join(home, 'profiles', 'web', 'node_modules', 'my-plugin'), { recursive: true })
writeFileSync(join(home, 'profiles', 'web', 'node_modules', 'my-plugin', 'package.json'), JSON.stringify({
  name: 'my-plugin',
  version: '1.0.0',
  main: 'index.js',
}))
writeFileSync(join(home, 'profiles', 'web', 'node_modules', 'my-plugin', 'index.js'), 'export function apply() {}')
writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({
  name: 'web-profile',
  private: true,
  dependencies: { 'my-plugin': '^1.0.0' },
  dsh: { profile: { bundles: ['my-plugin'] } },
}))

const { collectBreakingSignals } = await import('../lib/advise.js')
const { clearScanCache } = await import('../lib/scan.js')

test.after(() => {
  clearScanCache()
  rmSync(home, { recursive: true, force: true })
})

function mockRegistry() {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('api.github.com')) {
      return {
        ok: true,
        json: async () => [{
          tag_name: 'v2.0.0', name: 'v2.0.0', published_at: '2026-09-01T00:00:00Z',
          html_url: 'https://github.com/owner/repo/releases/v2.0.0',
          body: '## Changes\n- BREAKING CHANGE: removed settingsNamespace',
        }],
      }
    }
    // Two versions so the row is behind and material gets fetched.
    return {
      ok: true,
      json: async () => ({
        versions: { '1.0.0': {}, '2.0.0': {} }, 'dist-tags': { latest: '2.0.0' },
        repository: { url: 'git+https://github.com/owner/repo.git' },
      }),
    }
  }
  return () => { globalThis.fetch = originalFetch }
}

test('the collector surfaces release-note breaking markers for an outdated package', async () => {
  const restore = mockRegistry()
  try {
    const signals = await collectBreakingSignals('web', 'my-plugin', true)
    assert.ok(Array.isArray(signals) && signals.length > 0, 'breaking hits present')
    assert.equal(signals[0].type, 'breaking')
    assert.equal(signals[0].source, 'release')
    assert.match(signals[0].line, /BREAKING CHANGE/)
  } finally {
    restore()
  }
})

test('an up-to-date package or an unreachable upstream yields no signal', async () => {
  const restore = mockRegistry()
  try {
    // The whole registry reports one version: nothing is outdated.
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ versions: { '1.0.0': {} }, 'dist-tags': { latest: '1.0.0' } }) })
    assert.deepEqual(await collectBreakingSignals('web', 'my-plugin', true), [])
  } finally {
    restore()
  }
})
