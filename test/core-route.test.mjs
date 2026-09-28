// Input validation for POST /update-core — the core update route must refuse
// malformed bodies (bad JSON, empty target, missing confirm) with a 400
// BEFORE anything executes, exactly like POST /update.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mountCopilotRoutes } from '../lib/routes.js'

function coreUpdateHandler() {
  const routes = []
  mountCopilotRoutes({
    webServer: { register: (route) => { routes.push(route); return () => {} } },
  })
  return routes.find((route) => route.path === '/dsh-update-copilot/update-core').handler
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
  await coreUpdateHandler()(input, response)
  return { status: response.status, body: JSON.parse(response.body) }
}

test('update-core rejects malformed bodies before any mutation', async () => {
  for (const body of [
    '{',
    JSON.stringify({ confirm: true, target: '' }),   // empty target
    JSON.stringify({ target: '2.0.0' }),             // confirm missing
  ]) {
    const result = await request(body)
    assert.equal(result.status, 400)
    assert.equal(typeof result.body.error, 'string')
  }
})

test('update-core refuses untrusted origins', async () => {
  const response = new EventEmitter()
  response.headersSent = false
  response.writeHead = (status) => { response.status = status }
  response.end = (text = '') => { response.body = text }
  const input = {
    method: 'POST',
    headers: { origin: 'http://evil.example', host: 'localhost' },
    socket: { encrypted: false },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}') },
  }
  await coreUpdateHandler()(input, response)
  assert.equal(response.status, 403)
})
