// Scanner integration for availability: a fake DSH_HOME built from the
// availability fixtures, no real registry. Asserts per-row states, summary
// counts, aggregated worst-state, and the scan op-log line.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureWeb = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'availability', 'web')
const home = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-avail-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
cpSync(fixtureWeb, join(home, 'profiles', 'web'), { recursive: true })
// Two plain libraries become verified patch-mounted children of ok-plugin
// (aggregates need ≥2 children). They are not in `dsh.profile.bundles`, so
// the scanner still emits them as inert plugin rows.
const okDir = join(home, 'profiles', 'web', 'node_modules', 'ok-plugin')
mkdirSync(join(home, 'profiles', 'web', 'node_modules', 'plain-lib'), { recursive: true })
writeFileSync(join(home, 'profiles', 'web', 'node_modules', 'plain-lib', 'package.json'), JSON.stringify({
  name: 'plain-lib', version: '1.0.0', main: 'index.js',
}))
writeFileSync(join(okDir, 'cordis.patch.yml'), '- insert:\n    - name: inert-lib\n    - name: plain-lib\n')
writeFileSync(join(okDir, 'package.json'), JSON.stringify({
  name: 'ok-plugin',
  version: '1.0.0',
  main: 'lib/index.js',
  dependencies: { 'inert-lib': '^1.0.0', 'plain-lib': '^1.0.0' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}))
const webManifest = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
webManifest.dependencies['plain-lib'] = '^1.0.0'
writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify(webManifest, null, 2))

const { aggregateRows, clearScanCache, scanAll, scanProfile } = await import('../lib/scan.js')
const { recentOps } = await import('../lib/util.js')

test.after(() => {
  clearScanCache()
  rmSync(home, { recursive: true, force: true })
})

function mockRegistry() {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ versions: { '1.0.0': {} }, 'dist-tags': { latest: '1.0.0' } }),
  })
  return () => { globalThis.fetch = originalFetch }
}

test('scanProfile attaches a per-plugin availability verdict', async () => {
  const restore = mockRegistry()
  try {
    const result = await scanProfile('web', true)
    const byName = Object.fromEntries(result.plugins.map((row) => [row.name, row.availability?.state]))
    assert.equal(byName['ok-plugin'], 'ok')
    assert.equal(byName['missing-plugin'], 'missing')
    assert.equal(byName['broken-surface'], 'broken')
    assert.equal(byName['broken-entry'], 'broken')
    assert.equal(byName['broken-client'], 'broken')
    assert.equal(byName['esm-client'], 'ok')
    assert.equal(byName['disabled-plugin'], 'disabled')
    assert.equal(byName['inert-lib'], 'inert')
    assert.equal(byName['plain-lib'], 'inert')
    assert.equal(byName['unresolvable-entry'], 'ok')
  } finally {
    restore()
  }
})

test('scanAll summary.availability counts states and recordOp carries broken/missing', async () => {
  const restore = mockRegistry()
  try {
    const all = await scanAll(true)
    assert.ok(all.summary.availability)
    assert.equal(all.summary.availability.broken >= 3, true) // surface, entry, client
    assert.equal(all.summary.availability.missing, 1)
    assert.equal(all.summary.availability.disabled, 1)
    assert.equal(all.summary.availability.inert, 2)
    const line = [...recentOps()].reverse().find((e) => e.event === 'scan')
    assert.ok(line, 'scan op-log entry')
    assert.match(line.detail, /broken=\d+/)
    assert.match(line.detail, /missing=\d+/)
  } finally {
    restore()
  }
})

test('scanAll records unreachable sources when the registry is down', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  try {
    clearScanCache()
    const all = await scanAll(true)
    assert.equal(all.summary.availability.unreachable > 0, true)
    assert.ok(all.summary.availability.unreachableSources.includes('registry.npmjs.org'))
    const npmRow = all.plugins.find((p) => p.profiles.some((r) => r.kind === 'npm'))
    assert.ok(npmRow.reached === false || npmRow.profiles.some((r) => r.reached === false))
    const line = [...recentOps()].reverse().find((e) => e.event === 'scan')
    assert.match(line.detail, /unreachable=\d+/)
  } finally {
    globalThis.fetch = originalFetch
    clearScanCache()
  }
})

test('buildBrief mentions availability issues on the target package', async () => {
  const restore = mockRegistry()
  try {
    const { buildBrief } = await import('../lib/advise.js')
    const brief = await buildBrief('broken-entry', 'web', true)
    assert.equal(brief.availability?.state, 'broken')
    assert.match(brief.availabilityNote, /broken/)
    assert.match(brief.recommendation, /broken/)
  } finally {
    restore()
  }
})

test('aggregateRows exposes the worst availability across profiles', () => {
  const plugins = aggregateRows([
    {
      profile: 'web',
      plugins: [{
        name: 'shared', spec: '^1', kind: 'npm', current: '1.0.0', latest: '1.0.0',
        updateAvailable: false,
        availability: { state: 'ok', reasons: '可加载 / loadable', bundle: true },
      }],
    },
    {
      profile: 'headless',
      plugins: [{
        name: 'shared', spec: '^1', kind: 'npm', current: '1.0.0', latest: '1.0.0',
        updateAvailable: false,
        availability: { state: 'broken', reasons: '入口缺失 / entry missing', bundle: true },
      }],
    },
  ])
  assert.equal(plugins[0].availability.state, 'broken')
  assert.equal(plugins[0].profiles[0].availability.state, 'ok')
  assert.equal(plugins[0].profiles[1].availability.state, 'broken')
  function walk(value, path = '$') {
    assert.notEqual(value, undefined, `undefined at ${path}`)
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`)
    }
  }
  walk(plugins[0])
})
