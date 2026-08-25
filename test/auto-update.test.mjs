// Regression tests for the sidebar-trigger auto-update option.
//
// The option (Settings → 更新助手 → 「点击按钮时自动更新」, localStorage
// `duc.autoUpdate`) makes one click on the sidebar trigger arm a bulk pass:
// when the popup's first scan arrives, every outdated auto-updatable package
// starts updating — the same path as the toolbar「一键更新全部」. These tests
// pin the target-selection helper the popup consumes (`autoTargetsOf`,
// exported from the real shipped bundle as `__test`), so an aggregate-row
// shape change cannot silently widen or empty the auto-run.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function loadBundle() {
  const reactStub = new Proxy({}, {
    get(target, key) {
      if (key === 'createElement') return () => ({})
      if (key === 'useState') return (initial) => [initial, () => {}]
      if (key === 'useEffect') return (effect) => { try { effect?.() } catch { /* ignore */ } return undefined }
      if (key === 'useCallback') return (fn) => fn
      if (key === 'useRef') return () => ({ current: null })
      if (key === 'useSyncExternalStore') return (_subscribe, getSnapshot) => getSnapshot()
      return undefined
    },
  })
  let exportsObj = null
  const windowStub = {
    __ModuleLoader__: {
      load({ factory }) {
        const requireStub = (spec) => {
          if (spec === 'react') return reactStub
          throw new Error(`test: unexpected require(${spec})`)
        }
        exportsObj = factory(requireStub)
      },
    },
  }
  const code = readFileSync(join(root, 'client', 'client.js'), 'utf8')
  // The bundle self-invokes window.__ModuleLoader__.load(...) on evaluation.
  new Function('window', code)(windowStub)
  assert.ok(exportsObj !== null, 'bundle did not export the plugin')
  return exportsObj
}

const row = (name, updateAvailable, canAutoUpdate) => ({ name, updateAvailable, canAutoUpdate })

test('auto-run selects behind packages that are auto-updatable', async () => {
  const { autoTargetsOf } = loadBundle().__test
  const plugins = [
    row('dshmarket', true, true),
    row('some-tool', false, false),
  ]
  assert.deepEqual(autoTargetsOf(plugins).map((p) => p.name), ['dshmarket'])
})

test('auto-run skips up-to-date rows even when marked auto-updatable', async () => {
  const { autoTargetsOf } = loadBundle().__test
  const plugins = [row('already-current', false, true)]
  assert.deepEqual(autoTargetsOf(plugins), [])
})

test('auto-run skips behind rows without an auto-updatable channel', async () => {
  const { autoTargetsOf } = loadBundle().__test
  // e.g. file:/git: specs — behind, but the updater refuses these channels.
  const plugins = [
    row('local-dir-plugin', true, false),
    row('raw-git-plugin', true, false),
    row('updatable-plugin', true, true),
  ]
  assert.deepEqual(autoTargetsOf(plugins).map((p) => p.name), ['updatable-plugin'])
})

test('auto-run tolerates malformed scan payloads', async () => {
  const { autoTargetsOf } = loadBundle().__test
  assert.deepEqual(autoTargetsOf(undefined), [])
  assert.deepEqual(autoTargetsOf(null), [])
  assert.deepEqual(autoTargetsOf('nope'), [])
  assert.deepEqual(autoTargetsOf([null, 42, row('ok', true, true)]).map((p) => p.name), ['ok'])
})
