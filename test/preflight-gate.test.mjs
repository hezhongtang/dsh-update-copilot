// Executor-level gate semantics (lib/update.js updatePlugin / updatePluginAll).
//
// The refusal must happen BEFORE the update executor spawns anything, force
// must be the only way through (with the evidence kept on the outcome), and
// a blocked item inside a multi-profile batch must not abort the pass. The
// preflight is injected (hooks.preflight, mirroring the hooks.reload seam)
// so no npm-pack runs here; the non-blocked path runs the real mutation
// spawn, which in a test environment fails deterministically as a spawn
// error — enough to prove the item was ATTEMPTED.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-gate-'))
process.env.DSH_HOME = home

function install(profile) {
  mkdirSync(join(home, 'profiles', profile, 'node_modules', 'p'), { recursive: true })
  writeFileSync(join(home, 'profiles', profile, 'node_modules', 'p', 'package.json'), JSON.stringify({
    name: 'p', version: '1.0.0', main: 'index.js',
  }))
  writeFileSync(join(home, 'profiles', profile, 'node_modules', 'p', 'index.js'), 'export function apply() {}')
  writeFileSync(join(home, 'profiles', profile, 'package.json'), JSON.stringify({
    name: `${profile}-profile`, private: true,
    dependencies: { p: '^1.0.0' },
    dsh: { profile: { bundles: ['p'] } },
  }))
}
install('web')
install('headless')

// Registry mock: the non-blocked paths resolve the plugin's newest version
// (1.0.0) before the mutation spawn fails deterministically in the sandbox.
const originalFetch = globalThis.fetch
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ versions: { '1.0.0': {} }, 'dist-tags': { latest: '1.0.0' } }),
})
test.after(() => {
  globalThis.fetch = originalFetch
  clearScanCache()
  rmSync(home, { recursive: true, force: true })
})

const { updatePluginAll, updatePlugin } = await import('../lib/update.js')
const { clearScanCache } = await import('../lib/scan.js')

const blockedPreflight = async () => ({
  warnings: [],
  blockers: [{
    plugin: 'p', type: 'compat', specifier: '@deepseek-ai/dsh-settings',
    missing: ['settingsNamespace'], against: 'target', hostVersion: '0.1.3-alpha.1',
  }],
  dshTarget: '0.1.3-alpha.1',
})

test('a blocked update returns preflight_blocked without attempting the mutation', async () => {
  const outcome = await updatePlugin('web', 'p', { preflight: blockedPreflight }, {})
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'preflight_blocked')
  assert.equal(outcome.changed, false)
  assert.equal(outcome.attempts, 0)
  assert.equal(outcome.blockers.length, 1)
  assert.match(outcome.error, /force/)
})

test('force: true proceeds past the gate and keeps the evidence on the outcome', async () => {
  const outcome = await updatePlugin('web', 'p', { preflight: blockedPreflight }, { force: true })
  // The mutation layer was reached (the dsh binary does not exist here, so
  // the spawn fails deterministically) — anything but a preflight refusal.
  assert.notEqual(outcome.code, 'preflight_blocked')
  assert.equal(outcome.forced, true)
  assert.equal(outcome.blockers.length, 1)
})

test('a clean preflight lets the update proceed to the mutation layer', async () => {
  const outcome = await updatePlugin('web', 'p', { preflight: async () => ({ warnings: [], blockers: [], dshTarget: null }) }, {})
  assert.notEqual(outcome.code, 'preflight_blocked')
  assert.equal(outcome.forced, undefined)
})

test('preflight warnings ride the successful update outcome unchanged', async () => {
  const warning = {
    type: 'peer', specifier: '@deepseek-ai/dsh', range: '^0.1.2', against: 'target', version: '0.1.3-alpha.1',
    message: 'peer warning',
  }
  const outcome = await updatePlugin('web', 'p', {
    preflight: async () => ({ warnings: [warning], blockers: [], dshTarget: '0.1.3-alpha.1' }),
  }, {})
  assert.notEqual(outcome.code, 'preflight_blocked')
  assert.deepEqual(outcome.warnings, [warning])
})

test('a blocked profile in a multi-profile batch is listed while the pass continues', async () => {
  const perProfile = async (profile) => (profile === 'web'
    ? blockedPreflight()
    : { warnings: [], blockers: [], dshTarget: '0.1.3-alpha.1' })
  const outcome = await updatePluginAll('p', { preflight: perProfile }, {})
  const web = outcome.items.find((i) => i.profile === 'web')
  const headless = outcome.items.find((i) => i.profile === 'headless')
  assert.equal(web.code, 'preflight_blocked')
  // The pass did NOT abort: headless was still attempted (spawn failure).
  assert.equal(headless.code, 'update_failed')
  assert.equal(headless.ok, false)
  assert.equal(outcome.blocked.length, 1)
  assert.equal(outcome.blocked[0].profile, 'web')
})
