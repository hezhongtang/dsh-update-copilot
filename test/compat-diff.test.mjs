// Diff named imports against a host export map, and the copy-pasteable
// disable / remove commands that go with a finding. No filesystem.
import test from 'node:test'
import assert from 'node:assert/strict'
import { diffHostImports, disablePatchSnippet, removeCommand } from '../lib/compat.js'

test('diffHostImports: missing settingsNamespace is a finding; present names are not', () => {
  const imports = [
    { plugin: 'vision-toolkit', file: 'lib/config.js', specifier: '@deepseek-ai/dsh-settings', names: ['settingsNamespace'] },
    { plugin: 'vision-toolkit', file: 'lib/web.js', specifier: '@deepseek-ai/dsh-settings', names: ['SettingsConflictError'] },
  ]
  const host = {
    '@deepseek-ai/dsh-settings': new Set(['SettingsConflictError', 'redactSecrets', 'default']),
  }
  const findings = diffHostImports(imports, host, { against: 'current', hostVersion: '0.1.2-alpha.2' })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].plugin, 'vision-toolkit')
  assert.equal(findings[0].file, 'lib/config.js')
  assert.equal(findings[0].specifier, '@deepseek-ai/dsh-settings')
  assert.deepEqual(findings[0].missing, ['settingsNamespace'])
  assert.equal(findings[0].against, 'current')
  assert.equal(findings[0].hostVersion, '0.1.2-alpha.2')
})

test('diffHostImports: unknown host specifier is reported as a missing module, not crashed', () => {
  const findings = diffHostImports(
    [{ plugin: 'p', file: 'lib/a.js', specifier: '@deepseek-ai/dsh-new-seam', names: ['foo'] }],
    {},
    { against: 'current', hostVersion: '0.1.2-alpha.2' },
  )
  assert.equal(findings.length, 1)
  assert.deepEqual(findings[0].missing, ['foo'])
  assert.equal(findings[0].hostMissing, true)
})

test('diffHostImports: target pass skips specifiers the pack did not load', () => {
  const findings = diffHostImports(
    [{ plugin: 'p', file: 'lib/a.js', specifier: '@deepseek-ai/cordis', names: ['Context'] }],
    {},
    { against: 'target', hostVersion: '0.1.2-alpha.2' },
  )
  assert.deepEqual(findings, [])
})

test('diffHostImports: skips non-host specifiers', () => {
  const findings = diffHostImports(
    [{ plugin: 'p', file: 'lib/a.js', specifier: 'saxes', names: ['SaxesParser'] }],
    {},
    { against: 'current', hostVersion: '0.1.2-alpha.2' },
  )
  assert.deepEqual(findings, [])
})

test('disablePatchSnippet: id-targeted cordis patch', () => {
  assert.equal(
    disablePatchSnippet('vision-toolkit'),
    '- id: vision-toolkit\n  disabled: true',
  )
})

test('removeCommand: official dsh plugin CLI', () => {
  assert.equal(
    removeCommand('web', '@dsh-external/dsh-vision-toolkit'),
    'dsh plugin --profile web remove @dsh-external/dsh-vision-toolkit',
  )
})
