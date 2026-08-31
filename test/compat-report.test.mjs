// Assemble a current+target compat report, attach it onto plugin rows, and
// render the offline CLI text. Uses the vision-toolkit fixture against a fake
// dsh tree — no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  attachCompatToPlugins,
  buildCompatReport,
  compatSummary,
  formatCompatReport,
  hostExportsMap,
  readHostExports,
} from '../lib/compat.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'compat')
const broken = {
  name: '@dsh-external/dsh-vision-toolkit',
  dir: join(fixtures, 'broken-plugin'),
  profiles: ['web'],
}
const ok = {
  name: 'harmless-plugin',
  dir: join(fixtures, 'ok-plugin'),
  profiles: ['web', 'headless'],
}

function currentHost() {
  const { names, version } = readHostExports(join(fixtures, 'host-settings'))
  return { version, map: { '@deepseek-ai/dsh-settings': names } }
}

test('hostExportsMap: resolve callback fills only found packages', () => {
  const map = hostExportsMap(['@deepseek-ai/dsh-settings', '@deepseek-ai/missing'], (spec) => (
    spec === '@deepseek-ai/dsh-settings' ? join(fixtures, 'host-settings') : null
  ))
  assert.equal(map['@deepseek-ai/dsh-settings'].has('SettingsConflictError'), true)
  assert.equal(Object.hasOwn(map, '@deepseek-ai/missing'), false)
})

test('buildCompatReport: current host flags the vision-toolkit crash', async () => {
  const { map, version } = currentHost()
  const report = await buildCompatReport({
    plugins: [broken, ok],
    currentExports: map,
    currentVersion: version,
    targetExports: null,
    targetVersion: null,
  })
  assert.equal(report.current.findings.length, 1)
  assert.equal(report.current.findings[0].plugin, '@dsh-external/dsh-vision-toolkit')
  assert.equal(report.target, null)
  const summary = compatSummary(report)
  assert.deepEqual(summary, {
    current: 1,
    target: 0,
    plugins: ['@dsh-external/dsh-vision-toolkit'],
  })
})

test('buildCompatReport: target map that omits a specifier does not invent hostMissing', async () => {
  const { map, version } = currentHost()
  const report = await buildCompatReport({
    plugins: [broken],
    currentExports: map,
    currentVersion: version,
    targetExports: {},
    targetVersion: '0.1.2-alpha.2',
  })
  assert.equal(report.target.findings.length, 0)
  assert.equal(report.target.findings.some((f) => f.hostMissing === true), false)
})

test('buildCompatReport: target host with the name restored is clean; without it warns', async () => {
  const { map, version } = currentHost()
  const restored = new Set([...map['@deepseek-ai/dsh-settings'], 'settingsNamespace'])
  const clean = await buildCompatReport({
    plugins: [broken],
    currentExports: map,
    currentVersion: version,
    targetExports: { '@deepseek-ai/dsh-settings': restored },
    targetVersion: '0.1.3',
  })
  assert.equal(clean.target.findings.length, 0)
  const dirty = await buildCompatReport({
    plugins: [broken],
    currentExports: map,
    currentVersion: version,
    targetExports: map,
    targetVersion: '0.1.2-alpha.2',
  })
  assert.equal(dirty.target.findings.length, 1)
  assert.equal(dirty.target.findings[0].against, 'target')
})

test('attachCompatToPlugins writes findings onto matching aggregated rows', async () => {
  const { map, version } = currentHost()
  const report = await buildCompatReport({
    plugins: [broken, ok],
    currentExports: map,
    currentVersion: version,
    targetExports: null,
    targetVersion: null,
  })
  const plugins = [
    { name: '@dsh-external/dsh-vision-toolkit', profiles: [] },
    { name: 'harmless-plugin', profiles: [] },
  ]
  attachCompatToPlugins(plugins, report)
  assert.equal(plugins[0].compat.length, 1)
  assert.equal(plugins[1].compat, undefined)
})

test('compatSummary: empty report is null', () => {
  assert.equal(compatSummary({ current: { findings: [] }, target: null }), null)
  assert.equal(compatSummary(null), null)
})

test('formatCompatReport zh includes disable patch and remove command', async () => {
  const { map, version } = currentHost()
  const report = await buildCompatReport({
    plugins: [broken],
    currentExports: map,
    currentVersion: version,
    targetExports: null,
    targetVersion: null,
  })
  const text = formatCompatReport(report, 'zh')
  assert.match(text, /settingsNamespace/)
  assert.match(text, /@dsh-external\/dsh-vision-toolkit/)
  assert.match(text, /disabled: true/)
  assert.match(text, /dsh plugin --profile web remove @dsh-external\/dsh-vision-toolkit/)
  assert.match(text, /cordis.patch.yml/)
})
