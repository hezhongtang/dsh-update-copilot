// Walk a plugin's entry graph, read host exports, and assemble a report
// that reproduces the vision-toolkit / dsh-settings named-export crash.
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectPluginHostImports,
  cordisEntryId,
  readHostExports,
  reportPluginCompat,
} from '../lib/compat.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'compat')
const brokenDir = join(fixtures, 'broken-plugin')
const okDir = join(fixtures, 'ok-plugin')
const hostDir = join(fixtures, 'host-settings')

test('collectPluginHostImports follows the entry graph to config.js', () => {
  const imports = collectPluginHostImports(brokenDir)
  const settings = imports.filter((row) => row.specifier === '@deepseek-ai/dsh-settings')
  assert.equal(settings.length, 1)
  assert.equal(settings[0].file.replaceAll('\\', '/'), 'lib/config.js')
  assert.deepEqual(settings[0].names, ['settingsNamespace'])
  assert.equal(settings[0].plugin, '@dsh-external/dsh-vision-toolkit')
})

test('readHostExports: 0.1.2-alpha.2-shaped settings has no settingsNamespace', () => {
  const { names, version } = readHostExports(hostDir)
  assert.equal(version, '0.1.2-alpha.2')
  assert.equal(names.has('SettingsConflictError'), true)
  assert.equal(names.has('settingsNamespace'), false)
})

test('cordisEntryId reads the bundle patch insert id', () => {
  assert.equal(cordisEntryId(brokenDir), 'vision-toolkit')
  assert.equal(cordisEntryId(okDir), null)
})

test('reportPluginCompat: broken plugin vs current host matches the boot crash', () => {
  const hostExports = { '@deepseek-ai/dsh-settings': readHostExports(hostDir).names }
  const report = reportPluginCompat({
    name: '@dsh-external/dsh-vision-toolkit',
    dir: brokenDir,
    profiles: ['web'],
    hostExports,
    against: 'current',
    hostVersion: '0.1.2-alpha.2',
  })
  assert.equal(report.findings.length, 1)
  const finding = report.findings[0]
  assert.deepEqual(finding.missing, ['settingsNamespace'])
  assert.equal(finding.entryId, 'vision-toolkit')
  assert.equal(finding.disablePatch, '- id: vision-toolkit\n  disabled: true')
  assert.deepEqual(finding.removeCommands, [
    'dsh plugin --profile web remove @dsh-external/dsh-vision-toolkit',
  ])
})

test('reportPluginCompat: plugin whose names exist is clean', () => {
  const hostExports = { '@deepseek-ai/dsh-settings': readHostExports(hostDir).names }
  const report = reportPluginCompat({
    name: 'harmless-plugin',
    dir: okDir,
    profiles: ['web'],
    hostExports,
    against: 'current',
    hostVersion: '0.1.2-alpha.2',
  })
  assert.deepEqual(report.findings, [])
})

test('reportPluginCompat: official @deepseek-ai packages are not scanned', () => {
  const report = reportPluginCompat({
    name: '@deepseek-ai/dsh-client-locale',
    dir: brokenDir,
    profiles: ['web'],
    hostExports: {},
    against: 'current',
    hostVersion: '0.1.2-alpha.2',
  })
  assert.equal(report.skipped, 'official')
  assert.deepEqual(report.findings, [])
})
