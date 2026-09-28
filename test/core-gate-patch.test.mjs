// Gate-level semantics for the core-update rename early-warning and the
// post-flight dump-config probe (lib/update.js coreGateFindings /
// patchNameEntries / dumpConfigWarnings + lib/cards.js corridor).
//
// The 2026-09-28 incident: dsh-base 0.1.7 renamed dsh-llm-deepseek to
// dsh-llm-deepseek-api-key; a profile cordis.patch.yml entry pinning the old
// name was silently skipped by the loader (config included), with a single
// stderr line as the only signal. These tests pin the warning-level answers:
// the gate must WARN without blocking, stay silent without target data, the
// post-flight collector must catch the incident's exact stderr line, and the
// corridor must carry the now-reviewed 0.1.6 → 0.1.7 edge. targetNames is
// always injected (or the profile fixture kept empty) so no npm pack runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-gatepatch-'))
process.env.DSH_HOME = home

// The incident's profile: one patch entry pinning the OLD package name, one
// name-less entry (id-matched — must never warn), and a third-party-style
// unquoted name (outside the @deepseek-ai/ scope — never judged).
mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'web-profile', private: true }))
writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
  '- id: llm-deepseek',
  '  name: "@deepseek-ai/dsh-llm-deepseek"',
  '  config:',
  '    apiKey: env:DEEPSEEK_API_KEY',
  '    models:',
  '      - name: deepseek-chat',
  '- id: llm-web-search',
  '  config:',
  '    timeout: 30',
  '- id: copilot',
  '  name: dsh-update-copilot',
  '',
].join('\n'))

// A fake global install the executor reads before/after versions from.
const dshDir = join(home, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(dshDir, { recursive: true })
writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-alpha.1' }))
const globalInstall = { method: 'global', dshDir, prefix: join(home, 'lib'), globalModulesRoot: join(home, 'lib', 'node_modules'), writable: true }

// Registry mock: the incident line only — no npm pack, no real network.
const originalFetch = globalThis.fetch
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    versions: { '0.1.7-alpha.1': {}, '0.1.7-rc.2': {} },
    'dist-tags': { latest: '0.1.7-alpha.1', alpha: '0.1.7-rc.2' },
  }),
})

test.after(() => {
  globalThis.fetch = originalFetch
  rmSync(home, { recursive: true, force: true })
})

const { updateCore, coreGateFindings, dumpConfigWarnings, patchNameEntries } = await import('../lib/update.js')
const { corridorFindings } = await import('../lib/cards.js')
const noExports = async () => ({})

// The target set as the incident's 0.1.7 line ships it: the renamed package
// in, the old name out.
const NEW_NAMES = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-llm-deepseek-api-key',
  '@deepseek-ai/dsh-llm-deepseek-account',
]

test('patchNameEntries reads id-block names and keeps name-less entries', () => {
  const rows = patchNameEntries([
    '- id: llm-deepseek',
    '  name: "@deepseek-ai/dsh-llm-deepseek"',
    '  config:',
    '    apiKey: env:DEEPSEEK_API_KEY',
    '    models:',
    '      - name: deepseek-chat',
    '- id: llm-web-search',
    '',
  ].join('\n'))
  assert.deepEqual(rows, [
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek' },
    { id: 'llm-web-search', name: null },
  ])
})

test('patchNameEntries tolerates unquoted names and nested list items do not hijack', () => {
  const rows = patchNameEntries([
    '- id: a',
    "  name: 'dsh-update-copilot'",
    '- id: b',
    '  name: plain-name',
    '  config:',
    '    list:',
    '      - name: nested-item',
    '',
  ].join('\n'))
  assert.equal(rows[0].name, 'dsh-update-copilot')
  assert.equal(rows[1].name, 'plain-name')
  assert.equal(rows.length, 2) // the nested `- name:` list item is not an entry
})

test('the gate warns about the pinned old name without blocking the move', async () => {
  const gate = await coreGateFindings({
    current: '0.1.7-alpha.1',
    targetVersion: '0.1.7-rc.2',
    profileScans: [],
    loadTargetExports: noExports,
    targetNames: NEW_NAMES,
  })
  assert.deepEqual(gate.blockers, []) // same format family, reviewed corridor hop
  const rename = gate.warnings.filter((w) => w.type === 'patch-rename')
  assert.equal(rename.length, 1)
  assert.equal(rename[0].layer, 'mount-time')
  assert.equal(rename[0].specifier, '@deepseek-ai/dsh-llm-deepseek')
  assert.equal(rename[0].profile, 'web')
  assert.equal(rename[0].id, 'llm-deepseek')
  // sibling heuristic: the new name rides the message
  assert.match(rename[0].message, /dsh-llm-deepseek-api-key/)
  assert.match(rename[0].message, /silently skips/)
})

test('without a sibling in the target set the warning stays generic', async () => {
  const gate = await coreGateFindings({
    current: '0.1.7-alpha.1',
    targetVersion: '0.1.7-rc.2',
    profileScans: [],
    loadTargetExports: noExports,
    targetNames: ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-settings'],
  })
  const rename = gate.warnings.filter((w) => w.type === 'patch-rename')
  assert.equal(rename.length, 1)
  assert.doesNotMatch(rename[0].message, /renamed to/)
  assert.match(rename[0].message, /not in the target dsh 0\.1\.7-rc\.2 package set/)
})

test('null targetNames (no data) yields no patch-rename warning', async () => {
  const gate = await coreGateFindings({
    current: '0.1.7-alpha.1',
    targetVersion: '0.1.7-rc.2',
    profileScans: [],
    loadTargetExports: noExports,
    targetNames: null,
  })
  assert.deepEqual(gate.warnings, [])
  assert.deepEqual(gate.blockers, [])
})

test('dumpConfigWarnings captures the incident stderr line, deduped, and ignores clean output', () => {
  const incident = 'patch: name mismatch for "llm-deepseek" (expected "@deepseek-ai/dsh-llm-deepseek-api-key", got "@deepseek-ai/dsh-llm-deepseek"), skipping'
  const rows = dumpConfigWarnings({ stdout: `# config dump\napiKey: ***\n`, stderr: `${incident}\n${incident}\nplugin x not found in bundle manifest\n` })
  assert.deepEqual(rows, [incident, 'plugin x not found in bundle manifest'])
  assert.deepEqual(dumpConfigWarnings({ stdout: 'fine\nand fine\n', stderr: '' }), [])
  assert.deepEqual(dumpConfigWarnings(), [])
})

test('the 0.1.6 → 0.1.7 corridor hop is now reviewed and open', () => {
  const c = corridorFindings('0.1.6', '0.1.7')
  assert.equal(c.missingEdge, false)
  assert.ok(c.cards.includes('DSH-0.1.7-R1'))
  assert.ok(c.notes.some((n) => /dsh-llm-deepseek/.test(n)))
})

test('a successful core update carries the gate warnings and survives the post-flight probe', async () => {
  // Fake npm: "installs" by rewriting the version manifest, exit 0. The
  // post-flight dump-config probe then depends on the host: with a real
  // `dsh` on PATH it runs against the fixture profile (and may legitimately
  // report its skip lines, tagged [web]); without one it is skipped
  // silently. Either way the finished update must stay ok — that is the
  // contract under test.
  const fakeNpm = join(home, 'fake-npm.sh')
  writeFileSync(fakeNpm, `#!/bin/sh\nprintf '%s' '{"name":"@deepseek-ai/dsh","version":"0.1.7-rc.2"}' > '${dshDir}/package.json'\n`, { mode: 0o755 })
  const outcome = await updateCore({ target: '0.1.7-rc.2', io: {
    install: globalInstall,
    profileScans: [],
    loadTargetExports: noExports,
    targetNames: NEW_NAMES,
    npmBin: fakeNpm,
  } })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.changed, true)
  assert.ok(outcome.warnings.some((w) => w.type === 'patch-rename'))
  for (const w of outcome.warnings.filter((x) => x.type === 'dump-config')) {
    assert.match(w.message, /^\[web\] /) // tagged per profile, nothing else
  }
})
