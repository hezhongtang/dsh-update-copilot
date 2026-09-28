// Shared client-bundle loader for regression tests: evaluates the shipped
// client/client.js (a window.__ModuleLoader__.load(...) CJS bundle) against a
// react stub so the tests drive the exact code the browser runs. By default
// the host's `@deepseek-ai/dsh-client-ui-primitives` require is absent — the
// bundle catches that and falls back to text glyphs; pass { primitives } to
// exercise the primitives-present path against a specific host generation's
// export shape (see chevron-icon-compat.test.mjs).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

export function loadBundle({ primitives } = {}) {
  const reactStub = new Proxy({}, {
    get(target, key) {
      // Descriptors (not bare {}) so a test can walk the element tree the
      // bundle returns and drive real handlers (see row-update-click.test.mjs).
      if (key === 'createElement') return (type, props, ...children) => ({ type, props: props ?? {}, children })
      // Lazy initializers (useState(() => …)) evaluate once, like React.
      if (key === 'useState') return (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
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
          if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
            if (primitives !== undefined) return primitives
            throw new Error('test: primitives intentionally absent')
          }
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
