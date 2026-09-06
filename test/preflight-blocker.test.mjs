// The hard blocker gate (lib/compat.js gatherTargetBlockers): the target dsh
// host line lacks a named export the plugin statically imports — the class
// of breakage that bricks the whole profile at boot. Same conservative
// reading as the scan's target pass: a pack that failed, an unpacked host
// package, or an independently versioned package is SILENCE, never a block
// (宁漏拦不错拦). Force is the user's explicit way through.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gatherTargetBlockers } from '../lib/compat.js'

function pluginDir(t, manifest, source) {
  const dir = mkdtempSync(join(tmpdir(), 'duc-blocker-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'index.js'), source)
  // A realistic plugin declares its loader entry id in the bundle patch —
  // the disable snippet in the evidence derives from it.
  writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: my-plugin\n      name: my-plugin\n')
  return dir
}

const loader = (map) => async (specifiers) => Object.fromEntries(
  specifiers
    .filter((s) => map[s] !== undefined)
    .map((s) => [s, new Set(map[s])]),
)

test('a name the plugin imports but the target host lacks is a blocker with evidence', async (t) => {
  const dir = pluginDir(t,
    { name: 'my-plugin', main: 'index.js' },
    "import { settingsNamespace } from '@deepseek-ai/dsh-settings'\nexport function apply() {}")
  const blockers = await gatherTargetBlockers({
    profile: 'web',
    name: 'my-plugin',
    dir,
    targetVersion: '0.1.3-alpha.1',
    loadTargetExports: loader({ '@deepseek-ai/dsh-settings': ['unrelated'] }),
  })
  assert.equal(blockers.length, 1)
  assert.equal(blockers[0].specifier, '@deepseek-ai/dsh-settings')
  assert.deepEqual(blockers[0].missing, ['settingsNamespace'])
  assert.equal(blockers[0].against, 'target')
  assert.equal(blockers[0].hostVersion, '0.1.3-alpha.1')
  assert.equal(blockers[0].file, 'index.js')
  assert.match(blockers[0].disablePatch, /disabled: true/)
  assert.deepEqual(blockers[0].removeCommands, ['dsh plugin --profile web remove my-plugin'])
})

test('imports the target still exports are not blockers', async (t) => {
  const dir = pluginDir(t,
    { name: 'my-plugin', main: 'index.js' },
    "import { settingsNamespace } from '@deepseek-ai/dsh-settings'\nexport function apply() {}")
  const blockers = await gatherTargetBlockers({
    profile: 'web', name: 'my-plugin', dir, targetVersion: '0.1.3-alpha.1',
    loadTargetExports: loader({ '@deepseek-ai/dsh-settings': ['settingsNamespace', 'other'] }),
  })
  assert.deepEqual(blockers, [])
})

test('host packages absent from the target pack stay silent (no false block)', async (t) => {
  const dir = pluginDir(t,
    { name: 'my-plugin', main: 'index.js' },
    "import { something } from '@deepseek-ai/dsh-not-packed'\nimport { settingsNamespace } from '@deepseek-ai/dsh-settings'\nexport function apply() {}")
  const blockers = await gatherTargetBlockers({
    profile: 'web', name: 'my-plugin', dir, targetVersion: '0.1.3-alpha.1',
    // The unpacked specifier is a pack failure, not evidence; the packed one
    // still exports what the plugin imports — neither blocks.
    loadTargetExports: loader({ '@deepseek-ai/dsh-settings': ['settingsNamespace'] }),
  })
  assert.deepEqual(blockers, [])
})

test('an empty or failed target pack degrades to no blockers', async (t) => {
  const dir = pluginDir(t,
    { name: 'my-plugin', main: 'index.js' },
    "import { settingsNamespace } from '@deepseek-ai/dsh-settings'\nexport function apply() {}")
  assert.deepEqual(await gatherTargetBlockers({
    profile: 'web', name: 'my-plugin', dir, targetVersion: '0.1.3-alpha.1',
    loadTargetExports: async () => ({}),
  }), [])
  assert.deepEqual(await gatherTargetBlockers({
    profile: 'web', name: 'my-plugin', dir, targetVersion: '0.1.3-alpha.1',
    loadTargetExports: async () => { throw new Error('npm pack failed') },
  }), [])
  assert.deepEqual(await gatherTargetBlockers({
    profile: 'web', name: 'my-plugin', dir, targetVersion: null,
    loadTargetExports: loader({}),
  }), [])
})

test('official packages and import-free plugins never reach the gate', async (t) => {
  const dir = pluginDir(t,
    { name: '@deepseek-ai/dsh-base', main: 'index.js' },
    "import { settingsNamespace } from '@deepseek-ai/dsh-settings'\nexport function apply() {}")
  assert.deepEqual(await gatherTargetBlockers({
    profile: 'web', name: '@deepseek-ai/dsh-base', dir, targetVersion: '0.1.3-alpha.1',
    loadTargetExports: loader({}),
  }), [])
  const plain = pluginDir(t, { name: 'plain', main: 'index.js' }, 'export function apply() {}')
  assert.deepEqual(await gatherTargetBlockers({
    profile: 'web', name: 'plain', dir: plain, targetVersion: '0.1.3-alpha.1',
    loadTargetExports: loader({}),
  }), [])
})
