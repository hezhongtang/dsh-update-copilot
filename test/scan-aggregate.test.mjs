// Unit tests for the package-centric scan aggregation (lib/scan.js).
//
// The one-click update model treats plugin updates as global: a package
// installed in several profiles appears once in the scan, and updating it
// runs the same command in every profile that has it. `aggregateRows` is the
// pure merge step — test it with fixture profile scans, no network involved.
import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateRows } from '../lib/scan.js'

function row(overrides) {
  return {
    name: 'pkg-a',
    spec: '^1.0.0',
    kind: 'npm',
    current: '1.0.0',
    latest: '1.2.0',
    currentShort: '1.0.0',
    latestShort: '1.2.0',
    updateAvailable: true,
    ...overrides,
  }
}

test('same package across profiles merges into one row', () => {
  const plugins = aggregateRows([
    { profile: 'web', plugins: [row({})] },
    { profile: 'headless', plugins: [row({ spec: '2.0.0', current: '2.0.0', latest: '2.1.0' })] },
  ])
  assert.equal(plugins.length, 1)
  const agg = plugins[0]
  assert.equal(agg.name, 'pkg-a')
  assert.equal(agg.installedCount, 2)
  assert.equal(agg.updateAvailable, true)
  assert.equal(agg.behind, 2)
  assert.equal(agg.canAutoUpdate, true)
  assert.deepEqual(agg.profiles.map((p) => p.profile), ['web', 'headless'])
})

test('up-to-date installs do not mark a package behind', () => {
  const plugins = aggregateRows([
    { profile: 'web', plugins: [row({ updateAvailable: false })] },
    { profile: 'headless', plugins: [row({ updateAvailable: true })] },
  ])
  assert.equal(plugins[0].behind, 1)
  assert.equal(plugins[0].updateAvailable, true)
})

test('no auto-updatable profile disables the update button row', () => {
  const plugins = aggregateRows([
    { profile: 'web', plugins: [row({ kind: 'file', updateAvailable: false })] },
    { profile: 'headless', plugins: [row({ kind: 'file', updateAvailable: false })] },
  ])
  assert.equal(plugins[0].canAutoUpdate, false)
  assert.equal(plugins[0].canSwitch, false)
})

test('linked profiles are switch-capable whether behind or not', () => {
  const plugins = aggregateRows([
    { profile: 'web', plugins: [row({ kind: 'linked', updateAvailable: true })] },
    { profile: 'headless', plugins: [row({ kind: 'linked', updateAvailable: false })] },
  ])
  assert.equal(plugins[0].canAutoUpdate, true)
  assert.equal(plugins[0].canSwitch, true)
  assert.equal(plugins[0].profiles.every((p) => p.canSwitch === true), true)
})

test('different packages stay separate and sort by name', () => {
  const plugins = aggregateRows([
    { profile: 'web', plugins: [row({ name: 'zeta' }), row({ name: 'alpha' })] },
    { profile: 'web', plugins: [row({ name: 'middle', spec: 'x' })] },
  ])
  assert.deepEqual(plugins.map((p) => p.name), ['alpha', 'middle', 'zeta'])
})

test('category and repo metadata are merged from the first available row', () => {
  const plugins = aggregateRows([
    { profile: 'web', plugins: [row({ name: 'ui-tool', category: 'ui', repo: 'owner/repo', repoUrl: 'https://github.com/owner/repo' })] },
    { profile: 'headless', plugins: [row({ name: 'ui-tool', kind: 'github' })] },
  ])
  const agg = plugins[0]
  assert.equal(agg.category, 'ui')
  assert.equal(agg.repo, 'owner/repo')
  assert.equal(agg.repoUrl, 'https://github.com/owner/repo')
  assert.equal(agg.official, false)
})

test('official flag is sticky across profiles', () => {
  const plugins = aggregateRows([
    { profile: 'web', plugins: [row({ name: '@deepseek-ai/x', official: true })] },
    { profile: 'headless', plugins: [row({ name: '@deepseek-ai/x', official: false })] },
  ])
  assert.equal(plugins[0].official, true)
})

test('aggregate rows retain managed children and target only independently updatable profiles', () => {
  const plugins = aggregateRows([
    {
      profile: 'web',
      plugins: [row({ name: '@example/ui-suite', classification: 'aggregate' })],
      managed: [row({ name: '@example/managed-ui', classification: 'aggregate-managed', managedBy: '@example/ui-suite' })],
    },
    {
      profile: 'desktop',
      plugins: [row({ name: '@example/ui-suite', classification: 'independent' })],
      managed: [],
    },
  ])
  const aggregate = plugins[0]
  assert.deepEqual(aggregate.updatableProfiles, ['web', 'desktop'])
  assert.deepEqual(aggregate.managedProfiles.map((child) => `${child.profile}/${child.name}`), ['web/@example/managed-ui'])
})

test('mixed independent and aggregate-managed package rows only target the independent profile', () => {
  const plugins = aggregateRows([
    { profile: 'web', plugins: [row({ name: 'shared-ui', classification: 'independent' })], managed: [] },
    {
      profile: 'desktop',
      plugins: [row({ name: '@example/ui-suite', classification: 'aggregate' })],
      managed: [row({ name: 'shared-ui', classification: 'aggregate-managed', managedBy: '@example/ui-suite' })],
    },
  ])
  assert.deepEqual(plugins.find((plugin) => plugin.name === 'shared-ui').updatableProfiles, ['web'])
  assert.equal(plugins.find((plugin) => plugin.name === '@example/ui-suite').managedProfiles[0].profile, 'desktop')
})
