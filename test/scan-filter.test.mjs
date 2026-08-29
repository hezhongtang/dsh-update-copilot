import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-'))
process.env.DSH_HOME = home
const { clearScanCache, scanAll, scanProfile } = await import('../lib/scan.js')
const { updatePlugin, updatePluginAll } = await import('../lib/update.js')

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

test('scan exposes mounts without changing direct dependency update classifications', async (t) => {
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
  // Membership is the union of bundle-declared deps, link:/file: checkouts,
  // and verified patch-mounted children. '@example/skin' is none of those —
  // a plain manifest dep the host never loads — so it must not render.
  assert.deepEqual(result.plugins.map((row) => row.name), [
    '@example/managed-ui',
    '@example/ui-suite',
    'linked-plugin',
    'local-file-plugin',
    'third-party-plugin',
  ])
  assert.deepEqual(
    result.plugins.map(({ name, classification }) => ({ name, classification })),
    [
      { name: '@example/managed-ui', classification: 'independent' },
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
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'managed'), false)
  assert.deepEqual(result.relationships, [
    { profile: 'web', parent: '@example/ui-suite', child: '@example/managed-ui', evidence: 'patch-insert+production-dependency' },
    { profile: 'web', parent: '@example/ui-suite', child: 'third-party-plugin', evidence: 'patch-insert+production-dependency' },
  ])
  assert.equal(result.behind, 3)
  const all = await scanAll(true)
  assert.equal(all.summary.plugins, 5)
  assert.equal(all.summary.behindPlugins, 3)
  assert.equal(all.summary.pluginInstallations, 5)
  assert.equal(all.summary.uniquePlugins, 5)
  assert.equal(all.summary.behindInstallations, 3)
  assert.equal(all.summary.behindPackages, 3)
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

test('package-wide updates retain a mounted child target in its selected profile', async (t) => {
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

test('direct official package updates are report-only on every install channel', async (t) => {
  t.after(() => {
    clearScanCache()
    rmSync(home, { recursive: true, force: true })
  })
  writeJson(join(home, 'profiles', 'web', 'package.json'), {
    dependencies: {
      '@deepseek-ai/official-addon': '^1.0.0',
      '@deepseek-ai/official-link': 'link:./fixtures/official-link',
    },
  })
  const originalFetch = globalThis.fetch
  let fetched = false
  globalThis.fetch = async () => { fetched = true; throw new Error('official package must not query the registry') }
  t.after(() => { globalThis.fetch = originalFetch })

  const outcome = await updatePlugin('web', '@deepseek-ai/official-addon')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'official_package')
  const linkedOutcome = await updatePlugin('web', '@deepseek-ai/official-link', {}, { source: 'remote' })
  assert.equal(linkedOutcome.ok, false)
  assert.equal(linkedOutcome.code, 'official_package')
  assert.equal(fetched, false)
})

test('package-wide updates skip profiles where the dep is not a plugin row', async (t) => {
  t.after(() => {
    clearScanCache()
    rmSync(home, { recursive: true, force: true })
  })
  // Same dep, two profiles: in `web` the manifest declares bundles and
  // shared-ui is a plain npm dep that is neither bundle-declared nor a
  // mounted child — the host never loads it there, so the update pass must
  // skip that profile. `desktop` declares no bundle list and keeps the
  // every-dependency fallback (shared-ui there is a dev checkout).
  writeJson(join(home, 'profiles', 'web', 'package.json'), {
    dependencies: { 'shared-ui': '^1.0.0' },
    dsh: { profile: { bundles: ['unrelated-bundle'] } },
  })
  writeJson(join(home, 'profiles', 'desktop', 'package.json'), {
    dependencies: { 'shared-ui': fixtureSpec('link', 'desktop', 'shared-ui') },
  })

  const outcome = await updatePluginAll('shared-ui', {}, {})
  assert.equal(outcome.profileCount, 1)
  assert.equal(outcome.items.length, 1)
})
