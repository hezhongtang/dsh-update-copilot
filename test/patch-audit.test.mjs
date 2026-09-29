// Patch-name audit semantics (lib/patch-audit.js, its scanAll wiring, and the
// client banner). The guarded incident: dsh-base renamed
// @deepseek-ai/dsh-llm-deepseek to @deepseek-ai/dsh-llm-deepseek-api-key in
// 0.1.7-rc.2, legacy-migrated profile patches still pinned the old name, and
// dsh's loader silently skipped those entries — config and all. The audit
// must flag exactly those pins, and only those: a name found through ANY of
// the loader's resolution sources (deps, declared bundles, both node_modules
// layers, bundle-patch insert records) is not stale.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBundle } from './bundle-loader.mjs'

const home = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-patch-audit-'))
process.env.DSH_HOME = home

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

const { parsePatchEntries, stalePatchNames, auditProfilePatch } = await import('../lib/patch-audit.js')

// The real fragment from the 0.1.7-rc.2 incident, plus the shapes the parser
// must tolerate: entries without a name, and records nested under - insert:.
const incidentPatch = [
  '- id: llm-deepseek',
  '  name: "@deepseek-ai/dsh-llm-deepseek"',
  '  config:',
  '    baseURL: https://api.deepseek.com',
  '- id: no-pin',
  '- insert:',
  '    - id: dsh-update-copilot',
  "      name: 'dsh-update-copilot'",
].join('\n')

test('parsePatchEntries: incident fragment, nameless entries, insert-nested records, document order', () => {
  assert.deepEqual(parsePatchEntries(incidentPatch), [
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek' },
    { id: 'no-pin', name: null },
    { id: 'dsh-update-copilot', name: 'dsh-update-copilot' },
  ])
})

test('parsePatchEntries: a name nested under config never leaks into the entry', () => {
  const entries = parsePatchEntries([
    '- id: model-entry',
    '  config:',
    '    name: inner-model-name',
    '    baseURL: https://api.deepseek.com',
  ].join('\n'))
  assert.deepEqual(entries, [{ id: 'model-entry', name: null }])
})

test('parsePatchEntries: unquoted values and trailing comments; records under mapping keys are ignored', () => {
  assert.deepEqual(parsePatchEntries([
    '- id: a  # entry id',
    '  name: some-pkg # the pinned package',
  ].join('\n')), [{ id: 'a', name: 'some-pkg' }])
  // These are not loader-visible entries — flagging their names would be a
  // false alarm.
  assert.deepEqual(parsePatchEntries('plugins:\n  - id: nested\n    name: not-an-entry\n'), [])
  assert.deepEqual(parsePatchEntries(''), [])
})

test('stalePatchNames: rename scenario hits, clean scenario stays silent', () => {
  const entries = parsePatchEntries(incidentPatch)
  const stale = stalePatchNames(entries, ['@deepseek-ai/dsh-llm-deepseek-api-key', 'dsh-update-copilot'])
  assert.deepEqual(stale, [{ id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek' }])
  // Everything resolvable (and the nameless entry) → no findings.
  assert.deepEqual(stalePatchNames(entries, new Set(['@deepseek-ai/dsh-llm-deepseek', 'dsh-update-copilot'])), [])
})

// ---------------------------------------------------------------------------
// auditProfilePatch against a real DSH_HOME fixture (the preflight-gate
// mkdtempSync pattern). The renamed plugin arrives ONLY through dsh-base's
// contained patch insert record — the strictest recognition path.
// ---------------------------------------------------------------------------

function installPackage(dir, name, manifest = {}) {
  mkdirSync(join(dir, ...name.split('/')), { recursive: true })
  writeFileSync(join(dir, ...name.split('/'), 'package.json'), JSON.stringify({ name, version: '0.1.7-rc.2', ...manifest }))
}

installPackage(join(home, 'profiles', 'web', 'node_modules'), '@deepseek-ai/dsh-base', {
  dsh: { bundle: { patch: './cordis.patch.yml' } },
})
writeFileSync(
  join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml'),
  '- insert:\n    - name: @deepseek-ai/dsh-llm-deepseek-api-key\n',
)
installPackage(join(home, 'profiles', 'web', 'node_modules'), 'community-plugin')
installPackage(join(home, 'profiles', 'disk', 'node_modules'), 'present-on-disk')
installPackage(join(home, 'profiles', 'node_modules'), 'flat-fallback-pkg')

const webDeps = { '@deepseek-ai/dsh-base': '0.1.7-rc.2', 'community-plugin': '^1.0.0' }
const webBundles = ['@deepseek-ai/dsh-base', 'community-plugin']

function writeWebPatch(nameLine) {
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '- id: llm-deepseek',
    `  ${nameLine}`,
    '  config:',
    '    baseURL: https://api.deepseek.com',
  ].join('\n'))
}

test('auditProfilePatch: a pin on the pre-rename package name becomes a finding', () => {
  writeWebPatch('name: "@deepseek-ai/dsh-llm-deepseek"')
  assert.deepEqual(auditProfilePatch('web', webDeps, webBundles), [
    { profile: 'web', id: 'llm-deepseek', pinnedName: '@deepseek-ai/dsh-llm-deepseek' },
  ])
})

test('auditProfilePatch: the post-rename name is recognized through the bundle patch insert alone', () => {
  writeWebPatch("name: '@deepseek-ai/dsh-llm-deepseek-api-key'")
  assert.deepEqual(auditProfilePatch('web', webDeps, webBundles), [])
})

test('auditProfilePatch: names visible only on disk (profile layer or flat fallback) are not stale', () => {
  writeFileSync(join(home, 'profiles', 'disk', 'cordis.patch.yml'), '- id: disky\n  name: present-on-disk\n')
  assert.deepEqual(auditProfilePatch('disk', {}, null), [])
  mkdirSync(join(home, 'profiles', 'flat'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'flat', 'cordis.patch.yml'), '- id: flatly\n  name: flat-fallback-pkg\n')
  assert.deepEqual(auditProfilePatch('flat', {}, new Set()), [])
})

test('auditProfilePatch: flat-layer bundle rows (the shipped dsh-base shape) resolve pinned names', () => {
  // The real 0.1.7-rc.2 layout: dsh-base lives in the flat profiles-root
  // layer, is declared only in dsh.profile.bundles (not in deps), and its
  // patch carries the llm plugins as plain `name:` rows — not `- insert:`
  // records. Regression test for the audit version that read only deps'
  // insert records and false-flagged every already-fixed profile (caught on
  // the live machine: web pinned the NEW name and still got a finding).
  installPackage(join(home, 'profiles', 'node_modules'), '@deepseek-ai/dsh-base', {
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  writeFileSync(
    join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml'),
    [
      '- id: llm-deepseek',
      "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
      '- id: llm-deepseek-account',
      "  name: '@deepseek-ai/dsh-llm-deepseek-account'",
    ].join('\n'),
  )
  mkdirSync(join(home, 'profiles', 'flatbundle'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'flatbundle', 'cordis.patch.yml'), [
    '- id: llm-deepseek',
    "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
    '- id: gone',
    "  name: '@deepseek-ai/dsh-llm-deepseek'",
  ].join('\n'))
  assert.deepEqual(auditProfilePatch('flatbundle', {}, ['@deepseek-ai/dsh-base']), [
    { profile: 'flatbundle', id: 'gone', pinnedName: '@deepseek-ai/dsh-llm-deepseek' },
  ])
})

test('auditProfilePatch: a bundle resolved only through the running host layer is honored', () => {
  // npm-global installs keep official bundles inside the host dsh package's
  // own node_modules, and the flat profiles-root materialization may lag an
  // upgrade or miss them entirely (observed on the live machine: the flat
  // layer's contents changed between two scans). The loader reads the patch
  // from the host's module table, so a name its rows declare must never read
  // as stale even when no profile/flat layer carries the bundle.
  const host = join(home, 'hostrun', 'node_modules', '@deepseek-ai', 'dsh')
  installPackage(host, '@deepseek-ai/dsh')
  // Nested INSIDE the dsh package's node_modules — the real npm-global shape
  // (<prefix>/…/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base).
  installPackage(join(host, 'node_modules'), '@deepseek-ai/dsh-web-app', {
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  writeFileSync(
    join(host, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'cordis.patch.yml'),
    "- id: x\n  name: '@deepseek-ai/dsh-only-host-pkg'\n",
  )
  mkdirSync(join(home, 'profiles', 'hostbundle'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'hostbundle', 'cordis.patch.yml'), [
    '- id: a',
    "  name: '@deepseek-ai/dsh-only-host-pkg'",
    '- id: b',
    "  name: '@deepseek-ai/dsh-vanished'",
  ].join('\n'))
  assert.deepEqual(auditProfilePatch('hostbundle', {}, ['@deepseek-ai/dsh-web-app'], { hostDshDir: host }), [
    { profile: 'hostbundle', id: 'b', pinnedName: '@deepseek-ai/dsh-vanished' },
  ])
})

test('auditProfilePatch: a profile without a patch file yields no findings', () => {
  assert.deepEqual(auditProfilePatch('ghost', webDeps, webBundles), [])
})

// ---------------------------------------------------------------------------
// Client rendering: the warn banner on both radar surfaces and the
// UpdateWarnings shape tolerance (message-bearing warnings render verbatim).
// Function components render by calling them (see test/core-ui.test.mjs).
// ---------------------------------------------------------------------------

const { patchAuditBannerElement, updateWarningsElement } = loadBundle().__test

const dict = {
  patchAuditTitle: 'T{n}',
  patchAuditLine: '{profile} · {id} → {name}',
  patchAuditFix: 'FIX',
  patchAuditVerify: 'VERIFY',
  updateWarnings: 'WARN',
}
const t = (key, params = {}) => {
  let s = dict[key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) s = s.replace(`{${k}}`, String(v))
  return s
}

function walk(node, visit) {
  if (node === null || node === undefined) return
  if (typeof node === 'string') {
    visit(node)
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function renderTexts(descriptor) {
  const texts = []
  walk(descriptor.type(descriptor.props), (node) => { if (typeof node === 'string') texts.push(node) })
  return texts.join(' | ')
}

test('patch audit banner renders one line per finding plus the per-profile verify command', () => {
  const texts = renderTexts(patchAuditBannerElement({
    t,
    findings: [
      { profile: 'web', id: 'llm-deepseek', pinnedName: '@deepseek-ai/dsh-llm-deepseek' },
      { profile: 'web', id: 'other', pinnedName: 'gone-pkg' },
      { profile: 'desktop', id: 'third', pinnedName: 'gone-pkg' },
    ],
  }))
  assert.ok(texts.includes('T3'))
  assert.ok(texts.includes('web · llm-deepseek → @deepseek-ai/dsh-llm-deepseek'))
  assert.ok(texts.includes('web · other → gone-pkg'))
  assert.ok(texts.includes('desktop · third → gone-pkg'))
  assert.ok(texts.includes('FIX'))
  assert.ok(texts.includes('VERIFY'))
  // One copy-ready verify command per affected profile, grep pattern intact.
  const webCmd = 'dsh --profile web --dump-config 2>&1 >/dev/null | grep "mismatch\\|not found"'
  const desktopCmd = 'dsh --profile desktop --dump-config 2>&1 >/dev/null | grep "mismatch\\|not found"'
  assert.ok(texts.includes(webCmd))
  assert.ok(texts.includes(desktopCmd))
})

test('patch audit banner stays silent without findings', () => {
  for (const findings of [[], undefined]) {
    const descriptor = patchAuditBannerElement({ t, findings })
    assert.equal(descriptor.type(descriptor.props), null)
  }
})

test('UpdateWarnings: message-bearing warnings render verbatim; an empty list renders nothing', () => {
  const message = renderTexts(updateWarningsElement({
    t,
    result: { warnings: [{ type: 'stale-patch', message: 'patch name mismatch: llm-deepseek' }] },
  }))
  assert.ok(message.includes('patch name mismatch: llm-deepseek'))

  const breaking = renderTexts(updateWarningsElement({
    t,
    result: { warnings: [{ type: 'breaking', line: 3, message: 'breaking line 3' }] },
  }))
  assert.ok(breaking.includes('breaking line 3'))

  const empty = updateWarningsElement({ t, result: { warnings: [] } })
  assert.equal(empty.type(empty.props), null)
})
