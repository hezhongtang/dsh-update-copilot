// Executor-level semantics for the DSH core update (lib/update.js updateCore).
//
// The refusals must happen in order and BEFORE any spawn: unresolvable
// target, same-version noop, downgrade without force, non-global or
// non-writable install, then the gate (corridor / storage / per-plugin
// evidence). The io seam (install / profileScans / npmBin / loadTargetExports)
// keeps these tests off the network and off a real `npm install -g` — the one
// path that reaches the spawn uses a binary name that cannot exist, which
// fails deterministically as a spawn error (the same philosophy as
// preflight-gate.test.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-core-'))
process.env.DSH_HOME = home

// A fake global install: the package dir the executor reads before/after
// versions from, standing in for <prefix>/lib/node_modules/@deepseek-ai/dsh.
const dshDir = join(home, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(dshDir, { recursive: true })
const writeVersion = (v) => writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: v }))
writeVersion('1.0.0')

const globalInstall = { method: 'global', dshDir, prefix: join(home, 'lib'), globalModulesRoot: join(home, 'lib', 'node_modules'), writable: true }

// Registry mock: newest 2.0.0 (the healthy line the resolver picks).
const originalFetch = globalThis.fetch
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    versions: { '0.9.0': {}, '1.0.0': {}, '2.0.0': {} },
    'dist-tags': { latest: '0.9.0' },
  }),
})
test.after(() => {
  globalThis.fetch = originalFetch
  rmSync(home, { recursive: true, force: true })
})

const { updateCore, coreGateFindings } = await import('../lib/update.js')
const noExports = async () => ({})

test('same-version target is a noop, not an error and not a spawn', async () => {
  const outcome = await updateCore({ target: '1.0.0', io: { install: globalInstall, profileScans: [] } })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'update_noop')
  assert.equal(outcome.current, true)
  assert.equal(outcome.attempts, 0)
})

test('an explicit target older than the install is refused without force', async () => {
  const outcome = await updateCore({ target: '0.9.0', io: { install: globalInstall, profileScans: [] } })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'core_downgrade_blocked')
  assert.equal(outcome.targetVersion, '0.9.0')
  assert.equal(outcome.attempts, 0)
})

test('a forced downgrade reaches the spawn (which fails deterministically here)', async () => {
  const outcome = await updateCore({ target: '0.9.0', force: true, io: {
    install: globalInstall,
    profileScans: [],
    loadTargetExports: noExports,
    npmBin: 'duc-not-a-real-binary',
  } })
  assert.notEqual(outcome.code, 'core_downgrade_blocked')
  assert.equal(outcome.code, 'update_failed')
  assert.ok(outcome.attempts >= 1)
})

test('npx and untraceable installs stay report-only — no spawn, manual command returned', async () => {
  for (const install of [
    { method: 'npx', dshDir: '/x/.npm/_npx/abc/node_modules/@deepseek-ai/dsh', writable: true, prefix: '/usr/local' },
    { method: 'unknown', dshDir: null, writable: false, prefix: null },
  ]) {
    const outcome = await updateCore({ io: { install, profileScans: [] } })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'core_install_unsupported')
    assert.equal(outcome.attempts, 0)
    assert.equal(outcome.manualCommand, 'npm install -g @deepseek-ai/dsh@2.0.0')
  }
})

test('a non-writable global prefix refuses and hands back the manual command', async () => {
  const outcome = await updateCore({ io: {
    install: { ...globalInstall, writable: false },
    profileScans: [],
  } })
  assert.equal(outcome.code, 'core_prefix_not_writable')
  assert.equal(outcome.attempts, 0)
})

test('an upgrade without corridor coverage is blocked before any spawn, force keeps the evidence', async () => {
  // 1.0.0 → 2.0.0 is past every curated corridor edge (the shipped cards
  // cover the real 0.x line), so the gate must refuse deterministically.
  const blocked = await updateCore({ io: { install: globalInstall, profileScans: [] } })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'preflight_blocked')
  assert.equal(blocked.attempts, 0)
  assert.ok(Array.isArray(blocked.blockers) && blocked.blockers.length > 0)
  assert.equal(blocked.blockers[0].type, 'corridor')

  const forced = await updateCore({ force: true, io: {
    install: globalInstall,
    profileScans: [],
    loadTargetExports: noExports,
    npmBin: 'duc-not-a-real-binary',
  } })
  assert.equal(forced.code, 'update_failed') // spawn error, but it RAN
  assert.equal(forced.forced, true)
  assert.ok(forced.blockers.length > 0) // evidence survives the override
})

test('coreGateFindings emits the shared finding vocabulary (corridor + storage + plugin blockers)', async () => {
  const gate = await coreGateFindings({ current: '1.0.0', targetVersion: '2.0.0', profileScans: [], loadTargetExports: noExports })
  assert.ok(gate.blockers.length > 0)
  assert.ok(gate.blockers.every((b) => typeof b.layer === 'string' && typeof b.message === 'string'))
  assert.equal(gate.corridor.missingEdge, true)
})

test('unsafe explicit targets are rejected before anything else', async () => {
  const outcome = await updateCore({ target: '2.0.0@evil', io: { install: globalInstall, profileScans: [] } })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'unsafe_target')
  assert.equal(outcome.attempts, 0)
})
