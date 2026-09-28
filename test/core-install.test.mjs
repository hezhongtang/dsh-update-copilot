// Unit tests for lib/core-install.js — the pure halves of the core update
// feature: install-shape classification (global npm vs npx vs other) and
// target resolution (newest healthy / explicit), including the downgrade and
// same-version semantics the executor and GUI rely on.
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyCoreInstall, resolveCoreTarget } from '../lib/core-install.js'

test('classify: global install when the running dir sits under the npm global modules root', () => {
  const classified = classifyCoreInstall({
    dshDir: '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
    globalModulesRoot: '/opt/homebrew/lib/node_modules',
    npxRoot: '/Users/x/.npm/_npx',
  })
  assert.equal(classified.method, 'global')
})

test('classify: npx cache runs are recognized and never treated as global', () => {
  const classified = classifyCoreInstall({
    dshDir: '/Users/x/.npm/_npx/a1b2c3/node_modules/@deepseek-ai/dsh',
    globalModulesRoot: '/usr/local/lib/node_modules',
    npxRoot: '/Users/x/.npm/_npx',
  })
  assert.equal(classified.method, 'npx')
})

test('classify: anything else (local clone, pnpm store) reads as other, unknown when untraceable', () => {
  assert.equal(classifyCoreInstall({
    dshDir: '/Users/x/dev/harness',
    globalModulesRoot: '/usr/local/lib/node_modules',
    npxRoot: '/Users/x/.npm/_npx',
  }).method, 'other')
  assert.equal(classifyCoreInstall({}).method, 'unknown')
  assert.equal(classifyCoreInstall({ dshDir: null, globalModulesRoot: '/x' }).method, 'unknown')
})

test('classify: a prefix-similar path is not confused for the global root', () => {
  // Must NOT match on a string prefix alone — /opt/homebrew/lib-other is not
  // inside /opt/homebrew/lib/node_modules.
  assert.equal(classifyCoreInstall({
    dshDir: '/opt/homebrew/lib-other/node_modules/@deepseek-ai/dsh',
    globalModulesRoot: '/opt/homebrew/lib/node_modules',
    npxRoot: '/Users/x/.npm/_npx',
  }).method, 'other')
})

const core = (current, latest) => ({ packages: [{ current, latest }] })

test('resolve: targets the newest healthy version and pins it in the command', () => {
  const resolved = resolveCoreTarget({ core: core('1.0.0', '2.0.0') })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.version, '2.0.0')
  assert.equal(resolved.relation, 'upgrade')
  assert.equal(resolved.command, 'npm install -g @deepseek-ai/dsh@2.0.0')
})

test('resolve: a resolved target older than the install reads as a downgrade', () => {
  // Newest healthy behind the installed rc line — e.g. a manually installed
  // prerelease. The executor refuses the downgrade without force.
  const resolved = resolveCoreTarget({ core: core('0.2.0-rc.1', '0.1.7-rc.2') })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.version, '0.1.7-rc.2')
  assert.equal(resolved.relation, 'downgrade')
})

test('resolve: equal versions read as same', () => {
  const resolved = resolveCoreTarget({ core: core('2.0.0', '2.0.0') })
  assert.equal(resolved.relation, 'same')
})

test('resolve: without a resolvable newest version it fails closed', () => {
  assert.equal(resolveCoreTarget({ core: core('1.0.0', null) }).code, 'target_unavailable')
})

test('resolve: an explicit target (rollback path) wins over the newest line and is validated', () => {
  const resolved = resolveCoreTarget({ core: core('2.0.0', '3.0.0'), target: '1.9.3' })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.version, '1.9.3')
  assert.equal(resolved.relation, 'downgrade')
  // Semver-ish characters only: anything that could reshape the npm spec
  // (spaces, @, /, shell metacharacters) is rejected before it executes.
  assert.equal(resolveCoreTarget({ core: core('2.0.0', '3.0.0'), target: '2.0.0@next' }).code, 'unsafe_target')
  assert.equal(resolveCoreTarget({ core: core('2.0.0', '3.0.0'), target: '2.0.0 ; echo' }).code, 'unsafe_target')
})
