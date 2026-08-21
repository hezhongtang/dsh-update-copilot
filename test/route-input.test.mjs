import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mountCopilotRoutes } from '../lib/routes.js'

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
