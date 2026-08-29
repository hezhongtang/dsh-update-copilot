import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-aggregate-'))
process.env.DSH_HOME = home
const { insertedPackageNames, pluginMemberNames, profileDependencyMetadata } = await import('../lib/scan.js')

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

function install(profile, name, manifest) {
  writeJson(join(home, 'profiles', profile, 'node_modules', name, 'package.json'), manifest)
}

function ownership(profile, deps) {
  return profileDependencyMetadata(profile, deps).map(({ name, classification, mountedBy }) => ({ name, classification, ...(mountedBy === undefined ? {} : { mountedBy }) }))
}

test('discovers active multi-child aggregates and rejects ordinary, inactive, and one-child wrappers', (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const generic = {
    '@example/ui-suite': '^1.0.0',
    'suite-child-a': '^1.0.0',
    'suite-child-b': '^1.0.0',
    '@deepseek-ai/official-child': '^1.0.0',
  }
  writeJson(join(home, 'profiles', 'generic', 'package.json'), {
    dependencies: generic,
    dsh: { profile: { bundles: ['@example/ui-suite'] } },
  })
  install('generic', '@example/ui-suite', { dependencies: { 'suite-child-a': '^1.0.0', 'suite-child-b': '^1.0.0', '@deepseek-ai/official-child': '^1.0.0' }, dsh: { bundle: { patch: 'bundle.patch.yml' } } })
  writeFileSync(join(home, 'profiles', 'generic', 'node_modules', '@example', 'ui-suite', 'bundle.patch.yml'), '- insert:\n    - name: suite-child-a\n    - name: suite-child-b\n    - name: @deepseek-ai/official-child\n')
  assert.deepEqual(ownership('generic', generic), [
    { name: '@example/ui-suite', classification: 'aggregate' },
    { name: 'suite-child-a', classification: 'independent', mountedBy: '@example/ui-suite' },
    { name: 'suite-child-b', classification: 'independent', mountedBy: '@example/ui-suite' },
    { name: '@deepseek-ai/official-child', classification: 'official', mountedBy: '@example/ui-suite' },
  ])
  // Membership is what the host loads: bundle-declared deps plus verified
  // patch-mounted children — including the official child, which the radar
  // then files under its report-only official section rather than plugins.
  assert.deepEqual([...pluginMemberNames('generic', generic)].sort(), ['@deepseek-ai/official-child', '@example/ui-suite', 'suite-child-a', 'suite-child-b'])

  const ordinary = { 'dependency-rich-plugin': '^1.0.0', 'ordinary-child': '^1.0.0' }
  writeJson(join(home, 'profiles', 'ordinary', 'package.json'), { dependencies: ordinary, dsh: { profile: { bundles: ['dependency-rich-plugin'] } } })
  install('ordinary', 'dependency-rich-plugin', { dependencies: { 'ordinary-child': '^1.0.0' }, dsh: { bundle: { patch: 'bundle.patch.yml' } } })
  writeFileSync(join(home, 'profiles', 'ordinary', 'node_modules', 'dependency-rich-plugin', 'bundle.patch.yml'), '- insert:\n    - name: dependency-rich-plugin\n')
  assert.deepEqual(ownership('ordinary', ordinary), [
    { name: 'dependency-rich-plugin', classification: 'independent' },
    { name: 'ordinary-child', classification: 'independent' },
  ])

  const inactive = { 'inactive-suite': '^1.0.0', 'inactive-a': '^1.0.0', 'inactive-b': '^1.0.0' }
  writeJson(join(home, 'profiles', 'inactive', 'package.json'), { dependencies: inactive, dsh: { profile: { bundles: [] } } })
  install('inactive', 'inactive-suite', { dependencies: { 'inactive-a': '^1.0.0', 'inactive-b': '^1.0.0' }, dsh: { bundle: { patch: 'bundle.patch.yml' } } })
  writeFileSync(join(home, 'profiles', 'inactive', 'node_modules', 'inactive-suite', 'bundle.patch.yml'), '- insert:\n    - name: inactive-a\n    - name: inactive-b\n')
  assert.deepEqual(ownership('inactive', inactive).map((row) => row.classification), ['independent', 'independent', 'independent'])

  const wrapper = { wrapper: '^1.0.0', 'only-child': '^1.0.0' }
  writeJson(join(home, 'profiles', 'wrapper', 'package.json'), { dependencies: wrapper, dsh: { profile: { bundles: ['wrapper'] } } })
  install('wrapper', 'wrapper', { dependencies: { 'only-child': '^1.0.0' }, dsh: { bundle: { patch: 'bundle.patch.yml' } } })
  writeFileSync(join(home, 'profiles', 'wrapper', 'node_modules', 'wrapper', 'bundle.patch.yml'), '- insert:\n    - name: only-child\n')
  assert.deepEqual(ownership('wrapper', wrapper).map((row) => row.classification), ['independent', 'independent'])

  const precedence = {
    suite: '^1.0.0',
    'remote-child': '^1.0.0',
    'local-link-child': 'link:./fixtures/local-link-child',
    'local-file-child': 'file:./fixtures/local-file-child',
    '@deepseek-ai/official-child': '^1.0.0',
  }
  writeJson(join(home, 'profiles', 'precedence', 'package.json'), { dependencies: precedence, dsh: { profile: { bundles: ['suite'] } } })
  install('precedence', 'suite', {
    dependencies: {
      'remote-child': '^1.0.0',
      'local-link-child': '^1.0.0',
      'local-file-child': '^1.0.0',
      '@deepseek-ai/official-child': '^1.0.0',
    },
    dsh: { bundle: { patch: 'bundle.patch.yml' } },
  })
  writeFileSync(join(home, 'profiles', 'precedence', 'node_modules', 'suite', 'bundle.patch.yml'), '- insert:\n    - name: remote-child\n    - name: local-link-child\n    - name: local-file-child\n    - name: @deepseek-ai/official-child\n')
  assert.deepEqual(ownership('precedence', precedence), [
    { name: 'suite', classification: 'aggregate' },
    { name: 'remote-child', classification: 'independent', mountedBy: 'suite' },
    { name: 'local-link-child', classification: 'local', mountedBy: 'suite' },
    { name: 'local-file-child', classification: 'local', mountedBy: 'suite' },
    { name: '@deepseek-ai/official-child', classification: 'official', mountedBy: 'suite' },
  ])

  const multiple = { 'z-parent': '^1.0.0', 'a-parent': '^1.0.0', 'shared-child': '^1.0.0', 'z-only': '^1.0.0', 'a-only': '^1.0.0' }
  writeJson(join(home, 'profiles', 'multiple', 'package.json'), { dependencies: multiple, dsh: { profile: { bundles: ['z-parent', 'a-parent'] } } })
  install('multiple', 'z-parent', { dependencies: { 'shared-child': '^1.0.0', 'z-only': '^1.0.0', 'a-only': '^1.0.0' }, dsh: { bundle: { patch: 'bundle.patch.yml' } } })
  install('multiple', 'a-parent', { dependencies: { 'shared-child': '^1.0.0', 'a-only': '^1.0.0' }, dsh: { bundle: { patch: 'bundle.patch.yml' } } })
  writeFileSync(join(home, 'profiles', 'multiple', 'node_modules', 'z-parent', 'bundle.patch.yml'), '- insert:\n    - name: shared-child\n    - name: z-only\n    - name: a-only\n')
  writeFileSync(join(home, 'profiles', 'multiple', 'node_modules', 'a-parent', 'bundle.patch.yml'), '- insert:\n    - name: shared-child\n    - name: a-only\n')
  assert.deepEqual(ownership('multiple', multiple), [
    { name: 'z-parent', classification: 'aggregate' },
    { name: 'a-parent', classification: 'aggregate' },
    { name: 'shared-child', classification: 'independent', mountedBy: 'z-parent' },
    { name: 'z-only', classification: 'independent', mountedBy: 'z-parent' },
    { name: 'a-only', classification: 'independent', mountedBy: 'z-parent' },
  ])
  assert.deepEqual([...pluginMemberNames('multiple', multiple)].sort(), Object.keys(multiple).sort())

  const ties = { 'z-parent': '^1.0.0', 'a-parent': '^1.0.0', shared: '^1.0.0', 'z-child': '^1.0.0', 'a-child': '^1.0.0' }
  writeJson(join(home, 'profiles', 'ties', 'package.json'), { dependencies: ties, dsh: { profile: { bundles: ['z-parent', 'a-parent'] } } })
  install('ties', 'z-parent', { dependencies: { shared: '^1.0.0', 'z-child': '^1.0.0' }, dsh: { bundle: { patch: 'bundle.patch.yml' } } })
  install('ties', 'a-parent', { dependencies: { shared: '^1.0.0', 'a-child': '^1.0.0' }, dsh: { bundle: { patch: 'bundle.patch.yml' } } })
  writeFileSync(join(home, 'profiles', 'ties', 'node_modules', 'z-parent', 'bundle.patch.yml'), '- insert:\n    - name: shared\n    - name: z-child\n')
  writeFileSync(join(home, 'profiles', 'ties', 'node_modules', 'a-parent', 'bundle.patch.yml'), '- insert:\n    - name: shared\n    - name: a-child\n')
  assert.equal(ownership('ties', ties).find((row) => row.name === 'shared').mountedBy, 'a-parent')
})

test('insert parser stops at sibling mappings and ignores later metadata names', () => {
  assert.deepEqual([...insertedPackageNames(`
- insert:
    - id: first
      name: child-a
    - id: second
      name: child-b
  config:
    name: not-a-child
metadata:
  name: also-not-a-child
- insert:
    - name: child-c
`)], ['child-a', 'child-b', 'child-c'])
})

test('aggregate patch symlink escapes are rejected', (t) => {
  mkdirSync(home, { recursive: true })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profile = 'symlink'
  const packageDir = join(home, 'profiles', profile, 'node_modules', 'suite')
  const outside = join(home, 'outside.patch.yml')
  writeJson(join(home, 'profiles', profile, 'package.json'), {
    dependencies: { suite: '^1.0.0', childA: '^1.0.0', childB: '^1.0.0' },
    dsh: { profile: { bundles: ['suite'] } },
  })
  install(profile, 'suite', {
    dependencies: { childA: '^1.0.0', childB: '^1.0.0' },
    dsh: { bundle: { patch: 'bundle.patch.yml' } },
  })
  writeFileSync(outside, '- insert:\n    - name: childA\n    - name: childB\n')
  try {
    symlinkSync(outside, join(packageDir, 'bundle.patch.yml'))
  } catch {
    t.skip('symlinks unavailable on this platform')
    return
  }
  assert.deepEqual(profileDependencyMetadata(profile, { suite: '^1.0.0', childA: '^1.0.0', childB: '^1.0.0' }).map((row) => row.classification), [
    'independent', 'independent', 'independent',
  ])
})
