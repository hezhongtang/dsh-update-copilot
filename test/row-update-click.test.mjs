// Regression: "更新失败: Converting circular structure to JSON --> starting at
// object with constructor 'HTMLButtonElement' | property '__reactFiber$…' ->
// object with constructor 'na' --- property 'stateNode' closes the circle".
//
// The row's primary Update button was wired as `onClick: runUpdate`. React
// calls a handler with the synthetic click event, which landed on runUpdate's
// first parameter — `force`, added with the preflight gate — and streamUpdate
// spread it straight into the POST body. JSON.stringify then walked
// event.currentTarget -> __reactFiber$… -> fiber.stateNode (the same button)
// and threw *before* fetch was called: no update ran, and the row rendered the
// crash text.
//
// Fix + seam: the handler is `() => runUpdate()`, and streamUpdate honours
// only a literal `true` as force — the same normalization lib/routes.js
// applies on the wire (body.force === true). These tests render the real
// PluginRow out of the shipped bundle (bundle-loader hands back walkable
// element descriptors), click its Update button with a React-shaped circular
// event, and assert on the body that reaches fetch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBundle } from './bundle-loader.mjs'

const enc = (s) => new TextEncoder().encode(s)
// SSE frame wire-format, mirrored from lib/routes.js sendSse().
const frame = (o) => `data: ${JSON.stringify(o)}\n\n`
const OUTCOME = { ok: true, changed: true, name: 'dshmarket', hotReloaded: true }

/** SSE response that delivers `chunks` then closes. */
function sseResponse(chunks) {
  let i = 0
  const reader = {
    read: async () => {
      if (i < chunks.length) return { done: false, value: chunks[i++] }
      return { done: true }
    },
  }
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null) },
    body: { getReader: () => reader },
  }
}

/**
 * A synthetic click event exactly as React delivers it: currentTarget is the
 * button, the button carries React's fiber key, and the fiber points back at
 * the button it renders. JSON.stringify cannot survive this object.
 */
function syntheticClickEvent() {
  const button = {}
  const fiber = { stateNode: button }
  button.__reactFiber$7ksqb2wghxk = fiber
  return {
    type: 'click',
    target: button,
    currentTarget: button,
    nativeEvent: { target: button },
    preventDefault() {},
    stopPropagation() {},
  }
}

/** Depth-first search over the element tree a component returned. */
function findElement(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return findElement(node.children, predicate)
}

/** Capture every fetch call; the server answer is a completed SSE outcome. */
function tapFetch() {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return sseResponse([enc(':ok\n\n'), enc(frame({ type: 'done', outcome: OUTCOME }))])
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const ROW = {
  name: 'dshmarket',
  official: false,
  updateAvailable: true,
  canAutoUpdate: true,
  updatableProfiles: ['web'],
  category: 'plugin',
  profiles: [{ profile: 'web', kind: 'npm', canSwitch: false }],
}

/** Render the shipped PluginRow through the bundle's test seam. */
function renderRow(__test) {
  const element = __test.pluginRowElement({
    t: (key) => key,
    row: ROW,
    categories: [],
    onUpdated: async () => {},
    mountedChildren: [],
  })
  return element.type(element.props)
}

test('row Update click posts a serializable body — the click event never becomes force', async () => {
  const { __test } = loadBundle()
  const button = findElement(renderRow(__test), (el) => el.props.className === 'duc-btn primary' && typeof el.props.onClick === 'function')
  assert.ok(button !== null && button !== undefined, 'the row renders its primary Update button')

  const fetchTap = tapFetch()
  try {
    await button.props.onClick(syntheticClickEvent())
  } finally {
    fetchTap.restore()
  }

  // The reported failure sent no request at all: JSON.stringify threw first.
  assert.equal(fetchTap.calls.length, 1, 'the click must reach the update endpoint')
  assert.equal(fetchTap.calls[0].url, '/dsh-update-copilot/update')
  // The reported crash: this throw is what turned a click into "更新失败".
  assert.doesNotThrow(() => JSON.stringify(fetchTap.calls[0].init.body), 'the request body must not carry the circular click event')
  assert.deepEqual(JSON.parse(fetchTap.calls[0].init.body), {
    name: 'dshmarket',
    confirm: true,
    profiles: ['web'],
  })
})

test('streamUpdate honours only a literal true as force', async () => {
  const { streamUpdate } = loadBundle().__test
  const fetchTap = tapFetch()
  try {
    await streamUpdate('dshmarket', () => {}, undefined, undefined, ['web'], undefined, syntheticClickEvent())
    assert.deepEqual(JSON.parse(fetchTap.calls.at(-1).init.body), {
      name: 'dshmarket',
      confirm: true,
      profiles: ['web'],
    }, 'a stray truthy argument must not force past the preflight gate')

    await streamUpdate('dshmarket', () => {}, undefined, undefined, ['web'], undefined, true)
    assert.deepEqual(JSON.parse(fetchTap.calls.at(-1).init.body), {
      name: 'dshmarket',
      confirm: true,
      profiles: ['web'],
      force: true,
    }, 'an explicit force: true still travels')
  } finally {
    fetchTap.restore()
  }
})
