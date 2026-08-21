/**
 * HTTP routes for dsh-update-copilot's web panel. GETs are read-only scans and
 * briefs; the only mutating route is POST /update, which is same-origin only,
 * funnels through the allowlisted executor in update.js, and answers as a
 * Server-Sent Events stream so the panel can render a live progress bar
 * (progress / retry / phase events, then a final `done` event carrying the
 * same outcome object the agent tool returns). Scans are package-centric —
 * plugins are merged across profiles — and /update without a `profile` body
 * field updates the package in every profile that has it installed, since the
 * update command is identical for all of them.
 */
import { createPluginReloader } from './reload.js'

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Send one SSE `data:` frame; JSON payload so the client parses uniformly. */
function sendSse(response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
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
  const reload = createPluginReloader(host)

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
        if (name === '') {
          sendJson(response, 400, { error: 'name is required (profile is optional)' })
          return
        }
        const { buildBrief } = await import('./advise.js')
        sendJson(response, 200, await buildBrief(name, profile === '' ? null : profile, force))
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
        const name = typeof body.name === 'string' ? body.name : ''
        const profile = typeof body.profile === 'string' ? body.profile : ''
        const confirm = body.confirm === true
        const source = body.source === 'remote' ? 'remote' : undefined
        if (name === '') {
          sendJson(response, 400, { error: 'name is required (profile is optional)' })
          return
        }
        if (!confirm) {
          sendJson(response, 400, { error: 'confirm=true is required — updates run only after an explicit decision' })
          return
        }
        const { updatePlugin, updatePluginAll, subscribeProgress } = await import('./update.js')

        // SSE handshake first, then subscribe — progress events only start
        // flowing after the subscription slot is taken (updates are serialized,
        // so a single slot is the whole bus).
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        response.write(':ok\n\n')
        const sub = subscribeProgress((event) => sendSse(response, event))
        response.on('close', () => sub.cancel())

        const outcome = profile === ''
          ? await updatePluginAll(name, { reload }, { source })
          : await updatePlugin(profile, name, { reload }, { source })
        sendSse(response, { type: 'done', outcome })
        response.end()
      } catch (error) {
        // Stream may already be open with progress events sent — then the
        // failure is reported as a final `done` frame instead of plain JSON.
        if (!response.headersSent) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        } else {
          try {
            sendSse(response, { type: 'done', outcome: { ok: false, error: error instanceof Error ? error.message : String(error) } })
            response.end()
          } catch { /* response already gone */ }
        }
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
