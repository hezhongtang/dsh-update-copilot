import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-'))
process.env.DSH_HOME = home
const { clearScanCache, scanAll, scanProfile } = await import('../lib/scan.js')

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

function install(profile, name, manifest) {
  writeJson(join(home, 'profiles', profile, 'node_modules', name, 'package.json'), manifest)
}

test('scan hides official and aggregate-managed dependencies while retaining independent and linked plugins', async (t) => {
  t.after(() => {
    clearScanCache()
    rmSync(home, { recursive: true, force: true })
  })

  const profile = 'web'
  writeJson(join(home, 'profiles', profile, 'package.json'), {
    dependencies: {
      '@deepseek-ai/dsh-web-app': '^1.0.0',
      '@linxin666/dsh-web-ui-all': '^1.0.0',
      '@linxin666/managed-ui': '^1.0.0',
      '@linxin666/skin-whale-song': '^1.0.0',
      'dsh-better-sidebar': '^1.0.0',
      'dsh-tier-router': 'link:C:/local/dsh-tier-router',
      'local-file-plugin': 'file:C:/local/local-file-plugin',
      'third-party-plugin': '^1.0.0',
    },
  })
  install(profile, '@linxin666/dsh-web-ui-all', {
    version: '1.0.0',
    dependencies: {
      '@linxin666/managed-ui': '^1.0.0',
      'dsh-tier-router': '^1.0.0',
    },
  })
  for (const name of ['@deepseek-ai/dsh-web-app', '@linxin666/managed-ui', '@linxin666/skin-whale-song', 'dsh-better-sidebar', 'dsh-tier-router', 'local-file-plugin', 'third-party-plugin']) {
    install(profile, name, { version: '1.0.0' })
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => ({ versions: { '1.0.0': {}, '2.0.0': {} }, 'dist-tags': { latest: '2.0.0' } }),
  })
  t.after(() => { globalThis.fetch = originalFetch })

  const result = await scanProfile(profile, true)
  assert.deepEqual(result.plugins.map((row) => row.name), [
    '@linxin666/dsh-web-ui-all',
    '@linxin666/skin-whale-song',
    'dsh-tier-router',
    'local-file-plugin',
    'third-party-plugin',
  ])
  assert.deepEqual(
    result.plugins.map(({ name, classification }) => ({ name, classification })),
    [
      { name: '@linxin666/dsh-web-ui-all', classification: 'aggregate' },
      { name: '@linxin666/skin-whale-song', classification: 'independent' },
      { name: 'dsh-tier-router', classification: 'local' },
      { name: 'local-file-plugin', classification: 'local' },
      { name: 'third-party-plugin', classification: 'independent' },
    ],
  )
  assert.equal(result.plugins.find((row) => row.name === 'dsh-tier-router').kind, 'linked')
  assert.equal(result.plugins.find((row) => row.name === 'local-file-plugin').kind, 'file')
  assert.deepEqual(
    result.official.map(({ name, classification }) => ({ name, classification })),
    [{ name: '@deepseek-ai/dsh-web-app', classification: 'official' }],
  )
  assert.deepEqual(
    result.managed.map(({ name, classification, managedBy }) => ({ name, classification, managedBy })),
    [
      { name: '@linxin666/managed-ui', classification: 'aggregate-managed', managedBy: '@linxin666/dsh-web-ui-all' },
      { name: 'dsh-better-sidebar', classification: 'aggregate-managed', managedBy: '@linxin666/dsh-web-ui-all' },
    ],
  )
  assert.equal(result.behind, 3)
  const all = await scanAll(true)
  assert.equal(all.summary.plugins, 5)
  assert.equal(all.summary.behindPlugins, 3)
  assert.ok(all.core.packages.every((row) => row.classification === 'official'))
})
