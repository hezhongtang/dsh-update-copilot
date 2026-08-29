import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mountCopilotRoutes, sameOrigin, statusForce } from '../lib/routes.js'

function updateHandler() {
  const routes = []
  mountCopilotRoutes({
    webServer: { register: (route) => { routes.push(route); return () => {} } },
  })
  return routes.find((route) => route.path === '/dsh-update-copilot/update').handler
}

async function request(body) {
  const response = new EventEmitter()
  response.headersSent = false
  response.writeHead = (status) => { response.status = status; response.headersSent = true }
  response.end = (text = '') => { response.body = text }
  const input = {
    method: 'POST',
    headers: { origin: 'http://localhost', host: 'localhost' },
    socket: { encrypted: false },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
  }
  await updateHandler()(input, response)
  return { status: response.status, body: JSON.parse(response.body) }
}

test('update route rejects malformed or ambiguous profile scopes before mutation', async () => {
  for (const body of [
    '{',
    JSON.stringify({ name: 'pkg', confirm: true, profiles: 'web' }),
    JSON.stringify({ name: 'pkg', confirm: true, profiles: ['bad profile'] }),
    JSON.stringify({ name: 'pkg', confirm: true, profiles: ['web', 'web'] }),
    JSON.stringify({ name: 'pkg', confirm: true, profile: 'web', profiles: ['desktop'] }),
  ]) {
    const result = await request(body)
    assert.equal(result.status, 400)
    assert.equal(typeof result.body.error, 'string')
  }
})

test('status force parsing requires the exact force=1 query value', () => {
  assert.equal(statusForce('/dsh-update-copilot/status?force=1'), true)
  assert.equal(statusForce('/dsh-update-copilot/status?force=10'), false)
  assert.equal(statusForce('/dsh-update-copilot/status?notforce=1'), false)
})

test('same-origin rejects cross-scheme requests using socket transport', () => {
  const base = { headers: { origin: 'https://localhost', host: 'localhost' } }
  assert.equal(sameOrigin({ ...base, socket: { encrypted: false } }), false)
  assert.equal(sameOrigin({ headers: { origin: 'http://localhost', host: 'localhost' }, socket: { encrypted: true } }), false)
  assert.equal(sameOrigin({ ...base, socket: { encrypted: true } }), true)
})

test('configured public origin supports TLS-terminating reverse proxies and fails closed', (t) => {
  const previous = process.env.DSH_UPDATE_COPILOT_PUBLIC_ORIGIN
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_UPDATE_COPILOT_PUBLIC_ORIGIN
    else process.env.DSH_UPDATE_COPILOT_PUBLIC_ORIGIN = previous
  })
  const request = { headers: { origin: 'https://public.example', host: 'internal.example' }, socket: { encrypted: false } }
  process.env.DSH_UPDATE_COPILOT_PUBLIC_ORIGIN = 'https://public.example/panel'
  assert.equal(sameOrigin(request), true)
  assert.equal(sameOrigin({ ...request, headers: { ...request.headers, origin: 'https://other.example' } }), false)
  process.env.DSH_UPDATE_COPILOT_PUBLIC_ORIGIN = 'not a URL'
  assert.equal(sameOrigin(request), false)
})
