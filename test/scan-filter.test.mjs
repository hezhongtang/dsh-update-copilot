import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-'))
process.env.DSH_HOME = home
const { clearScanCache, scanAll, scanProfile } = await import('../lib/scan.js')
const { updatePluginAll } = await import('../lib/update.js')

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

function install(profile, name, manifest) {
  writeJson(join(home, 'profiles', profile, 'node_modules', name, 'package.json'), manifest)
}

function fixtureSpec(kind, profile, name) {
  return `${kind}:${join(home, 'fixtures', profile, name).replace(/\\/g, '/')}`
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
      '@example/ui-suite': '^1.0.0',
      '@example/managed-ui': '^1.0.0',
      '@example/skin': '^1.0.0',
      'linked-plugin': fixtureSpec('link', profile, 'linked-plugin'),
      'local-file-plugin': fixtureSpec('file', profile, 'local-file-plugin'),
      'third-party-plugin': '^1.0.0',
    },
    dsh: { profile: { bundles: ['@example/ui-suite'] } },
  })
  install(profile, '@example/ui-suite', {
    version: '1.0.0',
    dsh: { bundle: { patch: 'bundle.patch.yml' } },
    dependencies: {
      '@example/managed-ui': '^1.0.0',
      'third-party-plugin': '^1.0.0',
    },
  })
  writeFileSync(join(home, 'profiles', profile, 'node_modules', '@example', 'ui-suite', 'bundle.patch.yml'), '- insert:\n    - name: @example/managed-ui\n    - name: third-party-plugin\n')
  for (const name of ['@deepseek-ai/dsh-web-app', '@example/managed-ui', '@example/skin', 'linked-plugin', 'local-file-plugin', 'third-party-plugin']) {
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
    '@example/managed-ui',
    '@example/skin',
    '@example/ui-suite',
    'linked-plugin',
    'local-file-plugin',
    'third-party-plugin',
  ])
  assert.deepEqual(
    result.plugins.map(({ name, classification }) => ({ name, classification })),
    [
      { name: '@example/managed-ui', classification: 'independent' },
      { name: '@example/skin', classification: 'independent' },
      { name: '@example/ui-suite', classification: 'aggregate' },
      { name: 'linked-plugin', classification: 'local' },
      { name: 'local-file-plugin', classification: 'local' },
      { name: 'third-party-plugin', classification: 'independent' },
    ],
  )
  assert.equal(result.plugins.find((row) => row.name === 'linked-plugin').kind, 'linked')
  assert.equal(result.plugins.find((row) => row.name === 'local-file-plugin').kind, 'file')
  assert.deepEqual(
    result.official.map(({ name, classification }) => ({ name, classification })),
    [{ name: '@deepseek-ai/dsh-web-app', classification: 'official' }],
  )
  assert.deepEqual(result.managed, [])
  assert.deepEqual(result.relationships, [
    { parent: '@example/ui-suite', child: '@example/managed-ui', evidence: 'patch-insert+production-dependency' },
    { parent: '@example/ui-suite', child: 'third-party-plugin', evidence: 'patch-insert+production-dependency' },
  ])
  assert.equal(result.behind, 4)
  const all = await scanAll(true)
  assert.equal(all.summary.plugins, 6)
  assert.equal(all.summary.behindPlugins, 4)
  assert.equal(all.summary.pluginInstallations, 6)
  assert.equal(all.summary.uniquePlugins, 6)
  assert.equal(all.summary.behindInstallations, 4)
  assert.equal(all.summary.behindPackages, 4)
  assert.equal(all.summary.behindNames, all.summary.behindPackages)
  assert.deepEqual(all.plugins.find((row) => row.name === '@example/ui-suite').mounts, [
    { profile: 'web', parent: '@example/ui-suite', child: '@example/managed-ui', evidence: 'patch-insert+production-dependency' },
    { profile: 'web', parent: '@example/ui-suite', child: 'third-party-plugin', evidence: 'patch-insert+production-dependency' },
  ])
  assert.ok(all.core.packages.every((row) => row.classification === 'official'))
})

test('core command pins the scanner-selected highest published version', async (t) => {
  t.after(() => clearScanCache())
  writeJson(join(home, 'profiles', 'node_modules', '@deepseek-ai/dsh', 'package.json'), { version: '1.0.0' })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ versions: { '1.0.0': {}, '1.4.0': {} }, 'dist-tags': { latest: '1.2.0' } }),
  })
  t.after(() => { globalThis.fetch = originalFetch })
  const result = await scanAll(true)
  assert.equal(result.core.packages[0].latest, '1.4.0')
  assert.equal(result.core.updateCommand, 'npm install -g @deepseek-ai/dsh@1.4.0')
})

test('package-wide updates honor explicit eligible profiles and never select aggregate-managed children', async (t) => {
  t.after(() => {
    clearScanCache()
    rmSync(home, { recursive: true, force: true })
  })
  writeJson(join(home, 'profiles', 'web', 'package.json'), { dependencies: { 'shared-ui': '^1.0.0' } })
  writeJson(join(home, 'profiles', 'desktop', 'package.json'), {
    dependencies: { '@example/ui-suite': '^1.0.0', 'shared-ui': fixtureSpec('link', 'desktop', 'shared-ui') },
    dsh: { profile: { bundles: ['@example/ui-suite'] } },
  })
  install('desktop', '@example/ui-suite', {
    version: '1.0.0',
    dsh: { bundle: { patch: 'bundle.patch.yml' } },
    dependencies: { 'shared-ui': '^1.0.0', 'other-child': '^1.0.0' },
  })
  writeFileSync(join(home, 'profiles', 'desktop', 'node_modules', '@example', 'ui-suite', 'bundle.patch.yml'), '- insert:\n    - name: shared-ui\n    - name: other-child\n')

  const childMetadata = (await scanProfile('desktop', true)).plugins.find((row) => row.name === 'shared-ui')
  assert.equal(childMetadata.classification, 'local')
  assert.equal(childMetadata.mountedBy, '@example/ui-suite')
  const childUpdate = await updatePluginAll('shared-ui', {}, { profiles: ['desktop'] })
  assert.equal(childUpdate.profileCount, 1)
  assert.notEqual(childUpdate.code, 'not_installed')
})
