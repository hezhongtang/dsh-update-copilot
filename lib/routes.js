/**
 * HTTP routes for dsh-update-copilot's web panel. GETs are read-only scans and
 * briefs; the only mutating route is POST /update, which is same-origin only
 * and funnels through the allowlisted executor in update.js.
 */

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

function sameOrigin(request) {
  const origin = request.headers?.origin
  if (typeof origin !== 'string' || origin === 'null') return false
  try {
    return new URL(origin).host === request.headers?.host
  } catch {
    return false
  }
}

async function readJsonBody(request, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Register every copilot route on the webServer service.
 * @returns {() => void} disposer removing all routes.
 */
export function mountCopilotRoutes(host) {
  const disposers = []

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/dsh-update-copilot/status',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      try {
        const { scanAll } = await import('./scan.js')
        const force = (request.url ?? '').includes('force=1')
        sendJson(response, 200, await scanAll(force))
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/dsh-update-copilot/brief',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      try {
        const params = new URL(request.url ?? '/', 'http://localhost').searchParams
        const profile = params.get('profile') ?? ''
        const name = params.get('name') ?? ''
        const force = params.get('force') === '1'
        if (profile === '' || name === '') {
          sendJson(response, 400, { error: 'profile and name are required' })
          return
        }
        const { buildBrief } = await import('./advise.js')
        sendJson(response, 200, await buildBrief(profile, name, force))
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/dsh-update-copilot/update',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'untrusted origin' })
        return
      }
      try {
        const body = await readJsonBody(request)
        const profile = typeof body.profile === 'string' ? body.profile : ''
        const name = typeof body.name === 'string' ? body.name : ''
        const confirm = body.confirm === true
        if (!confirm) {
          sendJson(response, 400, { error: 'confirm=true is required — updates run only after an explicit decision' })
          return
        }
        const { updatePlugin } = await import('./update.js')
        sendJson(response, 200, await updatePlugin(profile, name))
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/dsh-update-copilot/logs',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      const { recentOps } = await import('./util.js')
      sendJson(response, 200, { ops: recentOps() })
    },
  }))

  return () => { for (const dispose of disposers) dispose() }
}
