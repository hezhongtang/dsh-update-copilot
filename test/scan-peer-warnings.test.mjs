// Scan/brief integration for preflight peer-range warnings: a fake DSH_HOME
// with a plugin whose declared peer range excludes the target dsh host, no
// real registry. The #5609 shape — `^0.1.2` reads fine while the upgrade
// target 0.1.3-alpha.1 is outside it — must surface on the package-centric
// scan row and in the brief, and stay silent when everything matches.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-peer-'))
process.env.DSH_HOME = home

// The on-disk dsh host the scanner reads first (flat fallback node_modules).
const dshDir = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(dshDir, { recursive: true })
writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2' }))

// A profile with one third-party plugin declaring a peer range that admits
// the running 0.1.2 but not the 0.1.3-alpha.1 target.
mkdirSync(join(home, 'profiles', 'web', 'node_modules', 'my-plugin'), { recursive: true })
writeFileSync(join(home, 'profiles', 'web', 'node_modules', 'my-plugin', 'package.json'), JSON.stringify({
  name: 'my-plugin',
  version: '1.0.0',
  main: 'index.js',
  peerDependencies: { '@deepseek-ai/dsh': '^0.1.2' },
}))
writeFileSync(join(home, 'profiles', 'web', 'node_modules', 'my-plugin', 'index.js'), 'export function apply() {}')
writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({
  name: 'web-profile',
  private: true,
  dependencies: { 'my-plugin': '^1.0.0' },
  dsh: { profile: { bundles: ['my-plugin'] } },
}))

const { clearScanCache, scanAll } = await import('../lib/scan.js')
const { buildBrief } = await import('../lib/advise.js')

test.after(() => {
  clearScanCache()
  rmSync(home, { recursive: true, force: true })
})

/** Registry doc serving the core (two versions) and the plugin (one). */
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
    const body = target.includes('my-plugin')
      ? {
          // Two versions so the brief has an update to summarize (breaking
          // signals only ride material for outdated rows).
          versions: { '1.0.0': {}, '2.0.0': {} }, 'dist-tags': { latest: '2.0.0' },
          repository: { url: 'git+https://github.com/owner/repo.git' },
        }
      : { versions: { '0.1.2': {}, '0.1.3-alpha.1': {} }, 'dist-tags': { latest: '0.1.3-alpha.1' } }
    return { ok: true, json: async () => body }
  }
  return () => { globalThis.fetch = originalFetch }
}

test('scan attaches a target-role peer warning to the package row', async () => {
  const restore = mockRegistry()
  try {
    const result = await scanAll(true)
    const row = result.plugins.find((p) => p.name === 'my-plugin')
    assert.ok(row, 'plugin row present')
    assert.equal(row.peerWarnings?.length, 1)
    const warning = row.peerWarnings[0]
    assert.equal(warning.type, 'peer')
    assert.equal(warning.specifier, '@deepseek-ai/dsh')
    assert.equal(warning.against, 'target')
    assert.equal(warning.version, '0.1.3-alpha.1')
    assert.equal(warning.range, '^0.1.2')
    // Per-profile evaluation: each finding carries the installing profile.
    assert.equal(warning.profile, 'web')
  } finally {
    restore()
  }
})

test('a satisfied peer range produces no warning field at all', async () => {
  const restore = mockRegistry()
  // The whole registry reports one version: the running host satisfies ^0.1.2.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ versions: { '0.1.2': {} }, 'dist-tags': { latest: '0.1.2' } }) })
  try {
    const result = await scanAll(true)
    const row = result.plugins.find((p) => p.name === 'my-plugin')
    assert.equal(row.peerWarnings, undefined)
  } finally {
    restore()
  }
})

test('brief carries the same structured warning objects', async () => {
  const restore = mockRegistry()
  try {
    const brief = await buildBrief('my-plugin', 'web', true)
    assert.equal(brief.error, undefined)
    assert.equal(brief.warnings?.length, 1)
    assert.equal(brief.warnings[0].against, 'target')
    assert.equal(brief.warnings[0].specifier, '@deepseek-ai/dsh')
  } finally {
    restore()
  }
})

test('brief surfaces breaking-change hits from the fetched release notes', async () => {
  const restore = mockRegistry()
  try {
    const brief = await buildBrief('my-plugin', 'web', true)
    assert.equal(brief.error, undefined)
    assert.ok(Array.isArray(brief.breaking) && brief.breaking.length > 0, 'breaking hits present')
    assert.equal(brief.breaking[0].type, 'breaking')
    assert.equal(brief.breaking[0].source, 'release')
    assert.match(brief.breaking[0].line, /BREAKING CHANGE/)
  } finally {
    restore()
  }
})
