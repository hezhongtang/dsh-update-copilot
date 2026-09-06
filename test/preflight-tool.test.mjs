// The preflight evaluation engine behind the update_copilot_preflight agent
// tool (lib/update.js evaluatePreflight): read-only, per-profile decision —
// blockers/warnings/breaking — that the tool relays as stable JSON. These
// tests pin the decision matrix and the shapes against a fake DSH_HOME and
// mocked upstreams; no real registry, no mutation.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-preflight-tool-'))
process.env.DSH_HOME = home

// On-disk dsh host 0.1.2; the mocked registry offers 0.1.3-alpha.1 — the
// core is behind, so the gate's target pass arms.
const dshDir = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(dshDir, { recursive: true })
writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2' }))

function install(profile, name, source, peer = {}) {
  mkdirSync(join(home, 'profiles', profile, 'node_modules', name), { recursive: true })
  writeFileSync(join(home, 'profiles', profile, 'node_modules', name, 'package.json'), JSON.stringify({
    name, version: '1.0.0', main: 'index.js', peerDependencies: peer,
  }))
  writeFileSync(join(home, 'profiles', profile, 'node_modules', name, 'index.js'), source)
  // Merge into the profile manifest — several installs share one profile.
  const manifestPath = join(home, 'profiles', profile, 'package.json')
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { name: `${profile}-profile`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }
  manifest.dependencies[name] = '^1.0.0'
  manifest.dsh.profile.bundles.push(name)
  writeFileSync(manifestPath, JSON.stringify(manifest))
}

// risky-plugin imports a name the target host lacks (blocker) and declares a
// peer range excluding the target (warning); clean-plugin declares no
// @deepseek-ai peers at all — under strict prerelease rules that is the only
// reliably quiet shape across dsh alpha lines.
install('web', 'risky-plugin',
  "import { settingsNamespace } from '@deepseek-ai/dsh-settings'\nexport function apply() {}",
  { '@deepseek-ai/dsh': '^0.1.2' })
install('web', 'clean-plugin', 'export function apply() {}')
install('headless', 'clean-plugin', 'export function apply() {}')

const { evaluatePreflight } = await import('../lib/update.js')
const { clearScanCache } = await import('../lib/scan.js')

test.after(() => {
  clearScanCache()
  rmSync(home, { recursive: true, force: true })
})

function mockRegistry() {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ versions: { '0.1.2': {}, '0.1.3-alpha.1': {} }, 'dist-tags': { latest: '0.1.3-alpha.1' } }),
  })
  return () => { globalThis.fetch = originalFetch }
}

// The target pack loader, injected: the target dsh line still exports
// 'unrelated' but not the settings names risky-plugin imports.
const loader = async (specifiers) => Object.fromEntries(
  specifiers.filter((s) => s === '@deepseek-ai/dsh-settings').map((s) => [s, new Set(['unrelated'])]),
)

test('a plugin whose target host exports are gone reads blocked, with evidence', async () => {
  const restore = mockRegistry()
  try {
    const result = await evaluatePreflight({ name: 'risky-plugin', profile: 'web', loadTargetExports: loader })
    assert.equal(result.decision, 'blocked')
    assert.equal(result.dshTarget, '0.1.3-alpha.1')
    assert.equal(result.items.length, 1)
    const item = result.items[0]
    assert.equal(item.decision, 'blocked')
    assert.ok(item.blockers.length > 0, 'blocker evidence present')
    assert.ok(item.warnings.length > 0, 'peer warning rides along')
    assert.match(result.note, /force/i)
  } finally {
    restore()
  }
})

test('a clean plugin across several profiles reads ok with per-profile items', async () => {
  const restore = mockRegistry()
  try {
    const result = await evaluatePreflight({ name: 'clean-plugin', loadTargetExports: loader })
    assert.equal(result.decision, 'ok')
    assert.deepEqual(result.items.map((i) => i.profile).sort(), ['headless', 'web'])
    assert.ok(result.items.every((i) => i.decision === 'ok' && i.blockers.length === 0 && i.warnings.length === 0))
  } finally {
    restore()
  }
})

test('a package installed nowhere reads unknown instead of throwing', async () => {
  const restore = mockRegistry()
  try {
    const result = await evaluatePreflight({ name: 'no-such-plugin', profile: 'web', loadTargetExports: loader })
    assert.equal(result.decision, 'unknown')
    assert.match(result.items[0].error, /not installed/)
  } finally {
    restore()
  }
})

test('an explicit target version overrides the scan-derived one', async () => {
  const restore = mockRegistry()
  try {
    const result = await evaluatePreflight({ name: 'clean-plugin', profile: 'web', target: '0.1.2', loadTargetExports: loader })
    assert.equal(result.dshTarget, '0.1.2')
    assert.equal(result.decision, 'ok')
  } finally {
    restore()
  }
})
