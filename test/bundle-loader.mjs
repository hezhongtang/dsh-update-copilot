// Shared client-bundle loader for regression tests: evaluates the shipped
// client/client.js (a window.__ModuleLoader__.load(...) CJS bundle) against a
// react stub so the tests drive the exact code the browser runs. The host's
// `@deepseek-ai/dsh-client-ui-primitives` require is intentionally absent —
// the bundle catches that and falls back to text glyphs.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

export function loadBundle() {
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
