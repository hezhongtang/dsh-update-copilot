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

// Tool results are validated as lossless JSON by the harness; an explicit
// `undefined` anywhere in the payload fails that check and kills the tool
// call. Aggregation must never leave such values behind (regression).
function assertNoUndefined(value, path = '$') {
  assert.notEqual(value, undefined, `lossless-JSON violation at ${path}`)
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, `${path}.${k}`)
  }
}

test('aggregated rows stay lossless-JSON safe (no explicit undefined)', () => {
  const plugins = aggregateRows([
    { profile: 'web', plugins: [row({ name: 'no-labels' }), row({ name: 'labeled', category: 'ui', repo: 'owner/repo' })] },
    { profile: 'headless', plugins: [row({ name: 'no-labels', kind: 'github' })] },
  ])
  const noLabels = plugins.find((p) => p.name === 'no-labels')
  assert.equal('category' in noLabels, false) // absent, never an undefined value
  assertNoUndefined(noLabels)
  const labeled = plugins.find((p) => p.name === 'labeled')
  assert.equal(labeled.category, 'ui') // labels still merge when present
  assertNoUndefined(labeled)
})