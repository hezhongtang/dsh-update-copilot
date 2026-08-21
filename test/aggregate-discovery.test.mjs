import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-aggregate-'))
process.env.DSH_HOME = home
const { profileDependencyMetadata, visibleProfileDeps } = await import('../lib/scan.js')

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

function install(profile, name, manifest) {
  writeJson(join(home, 'profiles', profile, 'node_modules', name, 'package.json'), manifest)
}

function ownership(profile, deps) {
  return profileDependencyMetadata(profile, deps).map(({ name, classification, managedBy }) => ({ name, classification, ...(managedBy === undefined ? {} : { managedBy }) }))
}

test('discovers marked aggregate packages with deterministic managed ownership', (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const generic = {
    '@example/ui-suite': '^1.0.0',
    'suite-child': 'link:C:/local/suite-child',
    '@deepseek-ai/official-child': '^1.0.0',
  }
  install('generic', '@example/ui-suite', {
    dsh: { bundle: { aggregate: true } },
    dependencies: { 'suite-child': '^1.0.0', '@deepseek-ai/official-child': '^1.0.0' },
  })
  assert.deepEqual(ownership('generic', generic), [
    { name: '@example/ui-suite', classification: 'aggregate' },
    { name: 'suite-child', classification: 'aggregate-managed', managedBy: '@example/ui-suite' },
    { name: '@deepseek-ai/official-child', classification: 'official' },
  ])
  assert.deepEqual(visibleProfileDeps('generic', generic).map(([name]) => name), ['@example/ui-suite'])

  const legacy = { '@linxin666/dsh-web-ui-all': '^1.0.0', 'legacy-child': '^1.0.0', 'dsh-better-sidebar': '^1.0.0' }
  install('legacy', '@linxin666/dsh-web-ui-all', { dependencies: { 'legacy-child': '^1.0.0' } })
  assert.deepEqual(ownership('legacy', legacy), [
    { name: '@linxin666/dsh-web-ui-all', classification: 'aggregate' },
    { name: 'legacy-child', classification: 'aggregate-managed', managedBy: '@linxin666/dsh-web-ui-all' },
    { name: 'dsh-better-sidebar', classification: 'aggregate-managed', managedBy: '@linxin666/dsh-web-ui-all' },
  ])

  const ordinary = { 'dependency-rich-plugin': '^1.0.0', 'ordinary-child': '^1.0.0' }
  install('ordinary', 'dependency-rich-plugin', { dependencies: { 'ordinary-child': '^1.0.0' } })
  assert.deepEqual(ownership('ordinary', ordinary), [
    { name: 'dependency-rich-plugin', classification: 'independent' },
    { name: 'ordinary-child', classification: 'independent' },
  ])

  const multiple = { 'z-parent': '^1.0.0', 'a-parent': '^1.0.0', 'shared-child': '^1.0.0' }
  install('multiple', 'z-parent', { dsh: { bundle: { aggregate: true } }, dependencies: { 'shared-child': '^1.0.0' } })
  install('multiple', 'a-parent', { dsh: { bundle: { aggregate: true } }, dependencies: { 'shared-child': '^1.0.0' } })
  assert.deepEqual(ownership('multiple', multiple), [
    { name: 'z-parent', classification: 'aggregate' },
    { name: 'a-parent', classification: 'aggregate' },
    { name: 'shared-child', classification: 'aggregate-managed', managedBy: 'a-parent' },
  ])
  assert.deepEqual(visibleProfileDeps('multiple', multiple).map(([name]) => name), ['z-parent', 'a-parent'])
})
