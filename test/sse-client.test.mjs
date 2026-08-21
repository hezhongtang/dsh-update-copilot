// Regression tests for the update SSE/JSON client contract.
//
// The bug: the browser page runs the newest client.js from disk, while a dsh
// process that booted before the SSE route landed still serves plain JSON from
// /dsh-update-copilot/update. The SSE-era client demanded a `data:` stream,
// hit EOF on the one-shot JSON body, and surfaced a phantom
// "更新失败: stream ended before the result" even though the update succeeded.
//
// Fix + seam: consumeUpdateResponse (exported from the real shipped bundle as
// `__test`, so the descriptor keeps its public { name, inject, apply } shape)
// accepts non-2xx `{ error }` envelopes, an SSE stream, and a plain JSON
// outcome, and tolerates a final chunk delivered together with `done: true`.
// These tests drive the exact code the browser runs against hand-built
// response objects.
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

const enc = (s) => new TextEncoder().encode(s)
// SSE frame wire-format, mirrored from lib/routes.js sendSse() — keep these in
// sync when that helper's format changes (see also client/client.js).
const frame = (o) => `data: ${JSON.stringify(o)}\n\n`
const OUTCOME = { ok: true, changed: true, name: 'dshmarket', hotReloaded: true }

function jsonResponse(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const json = typeof body === 'string'
    ? async () => { throw new SyntaxError('not json') }
    : async () => body
  return {
    ok: status >= 200 && status < 400,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    text: async () => text,
    json,
  }
}

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

test('SSE stream with progress + done resolves with the outcome', async () => {
  const { consumeUpdateResponse } = loadBundle().__test
  const events = []
  const outcome = await consumeUpdateResponse(sseResponse([
    enc(':ok\n\n'),
    enc(frame({ type: 'progress', percent: 50, phase: 'pull' })),
    enc(frame({ type: 'done', outcome: OUTCOME })),
  ]), (e) => events.push(e))
  assert.deepEqual(outcome, OUTCOME)
  assert.equal(events.length, 1)
})

test('SSE stream fragmented byte-by-byte still resolves', async () => {
  const { consumeUpdateResponse } = loadBundle().__test
  const blob = enc(':ok\n\n' + frame({ type: 'done', outcome: OUTCOME }))
  const outcome = await consumeUpdateResponse(sseResponse(Array.from(blob, (b) => enc(String.fromCharCode(b)))), () => {})
  assert.deepEqual(outcome, OUTCOME)
})

test('plain JSON outcome resolves (regression: loaded server predates SSE)', async () => {
  const { consumeUpdateResponse } = loadBundle().__test
  const outcome = await consumeUpdateResponse(jsonResponse(OUTCOME), () => {})
  assert.deepEqual(outcome, OUTCOME)
})

test('plain JSON failure outcome resolves with its fields for truthful UI text', async () => {
  const { consumeUpdateResponse } = loadBundle().__test
  const failure = { ok: false, code: 'update_failed', error: 'boom', changed: true }
  const outcome = await consumeUpdateResponse(jsonResponse(failure), () => {})
  assert.deepEqual(outcome, failure)
})

test('SSE body served with a non-stream content-type still resolves (sniff-agnostic)', async () => {
  const { consumeUpdateResponse } = loadBundle().__test
  // Intermediary stripped/rewrote the content type of a genuine SSE stream.
  const blob = enc(':ok\n\n' + frame({ type: 'progress', percent: 30, phase: 'pull' }) + frame({ type: 'done', outcome: OUTCOME }))
  const res = {
    ok: true,
    status: 200,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/plain' : null) },
    text: async () => new TextDecoder().decode(blob),
  }
  const events = []
  const outcome = await consumeUpdateResponse(res, (e) => events.push(e))
  assert.deepEqual(outcome, OUTCOME)
  // 'waiting' (plain-body branch) + the progress frame both surface.
  assert.ok(events.some((e) => e.type === 'progress'), 'progress frame was surfaced')
})

test('non-2xx JSON envelopes throw the server error (403/400/500)', async () => {
  const { consumeUpdateResponse } = loadBundle().__test
  await assert.rejects(
    () => consumeUpdateResponse(jsonResponse({ error: 'untrusted origin' }, 403), () => {}),
    (err) => err instanceof Error && err.message === 'untrusted origin',
  )
  await assert.rejects(
    () => consumeUpdateResponse(jsonResponse({ error: 'confirm=true is required' }, 400), () => {}),
    (err) => err instanceof Error && err.message === 'confirm=true is required',
  )
  await assert.rejects(
    () => consumeUpdateResponse(jsonResponse({ error: 'internal oops' }, 500), () => {}),
    (err) => err instanceof Error && err.message === 'internal oops',
  )
})

test('non-2xx without a JSON body falls back to the HTTP status', async () => {
  const { consumeUpdateResponse } = loadBundle().__test
  const res = {
    ok: false,
    status: 401,
    headers: { get: () => null },
    text: async () => '',
    json: async () => { throw new SyntaxError('not json') },
  }
  await assert.rejects(
    () => consumeUpdateResponse(res, () => {}),
    (err) => err instanceof Error && err.message === 'HTTP 401',
  )
})

test('SSE stream closed without a done frame throws the exact symptom', async () => {
  const { consumeUpdateResponse } = loadBundle().__test
  const res = sseResponse([enc(':ok\n\n'), enc(frame({ type: 'progress', percent: 50, phase: 'pull' }))])
  await assert.rejects(
    () => consumeUpdateResponse(res, () => {}),
    (err) => err instanceof Error && err.message === 'stream ended before the result',
  )
})

test('done frame in the final value delivered with done:true still resolves', async () => {
  const { consumeUpdateResponse } = loadBundle().__test
  let used = false
  const reader = {
    read: async () => {
      if (used) throw new Error('read after done')
      used = true
      return { done: true, value: enc(':ok\n\n' + frame({ type: 'done', outcome: OUTCOME })) }
    },
  }
  const res = {
    ok: true,
    status: 200,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null) },
    body: { getReader: () => reader },
  }
  const outcome = await consumeUpdateResponse(res, () => {})
  assert.deepEqual(outcome, OUTCOME)
})

test('neither JSON nor SSE body throws a diagnosis with content-type and excerpt', async () => {
  const { consumeUpdateResponse } = loadBundle().__test
  const res = {
    ok: true,
    status: 200,
    headers: { get: () => 'text/html' },
    text: async () => '<html>error page</html>',
  }
  await assert.rejects(
    () => consumeUpdateResponse(res, () => {}),
    (err) => err instanceof Error
      && /did not answer with a stream or an outcome/.test(err.message)
      && /text\/html/.test(err.message)
      && /<html>error page/.test(err.message),
  )
})

test('array-like JSON is rejected, not returned as an outcome', async () => {
  const { consumeUpdateResponse } = loadBundle().__test
  const res = {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => '[]',
  }
  await assert.rejects(
    () => consumeUpdateResponse(res, () => {}),
    (err) => err instanceof Error && /did not answer with a stream or an outcome/.test(err.message),
  )
})

test('badge status hydration reads the no-store status endpoint into shared UI state', async (t) => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options })
    return {
      ok: true,
      status: 200,
      json: async () => ({ summary: { behindPlugins: 2 }, generatedAt: '2026-08-22T00:00:00.000Z' }),
    }
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const { loadBadgeStatus, getUiState } = loadBundle().__test
  await loadBadgeStatus()
  assert.deepEqual(calls, [{ path: '/dsh-update-copilot/status', options: { cache: 'no-store' } }])
  assert.deepEqual(getUiState().summary, { behindPlugins: 2 })
  assert.equal(getUiState().generatedAt, '2026-08-22T00:00:00.000Z')
})

test('compact plugin sections use the aggregate parent state for managed children', () => {
  const { partitionPluginGroups } = loadBundle().__test
  const currentParent = {
    name: 'ui-suite',
    updateAvailable: false,
    managedProfiles: [{ name: 'ui-child', updateAvailable: true }],
  }
  const behindParent = {
    name: 'other-suite',
    updateAvailable: true,
    managedProfiles: [{ name: 'other-child', updateAvailable: false }],
  }
  const groups = partitionPluginGroups([currentParent, behindParent])

  assert.deepEqual(groups.current.map((group) => group.parent.name), ['ui-suite'])
  assert.deepEqual(groups.behind.map((group) => group.parent.name), ['other-suite'])
  assert.deepEqual(groups.current[0].managed.map((child) => child.name), ['ui-child'])
  assert.deepEqual(groups.behind[0].managed.map((child) => child.name), ['other-child'])
  assert.equal(groups.behind.some((group) => group.managed.some((child) => child.name === 'ui-child')), false)
  assert.equal(groups.current.some((group) => group.managed.some((child) => child.name === 'other-child')), false)
})
