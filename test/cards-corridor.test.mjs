// P0 corridor + layer classification (lib/cards.js): missing curated
// upgrade-card edges stop the move; reviewed edges summarize notes; layers
// follow the community link-time / mount-time / run-time vocabulary.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLayerFindings,
  capabilityFindings,
  classifyFailureSignature,
  compareDshVersions,
  corridorFindings,
  normalizeDshVersion,
  sessionFormatOf,
} from '../lib/cards.js'
import { looksEmptyPackage, newestHealthyVersion, emptyTargetGate } from '../lib/empty-pkg.js'
import { storageGate } from '../lib/storage.js'

test('normalizeDshVersion strips dsh-v / v prefixes', () => {
  assert.equal(normalizeDshVersion('dsh-v0.1.5-rc.2'), '0.1.5-rc.2')
  assert.equal(normalizeDshVersion('v0.1.7-alpha.1'), '0.1.7-alpha.1')
  assert.equal(normalizeDshVersion('0.1.2'), '0.1.2')
  assert.equal(normalizeDshVersion('nope'), null)
})

test('compareDshVersions ranks prerelease below release and orders rc tags', () => {
  assert.ok(compareDshVersions('0.1.2-rc.1', '0.1.2-alpha.5') > 0)
  assert.ok(compareDshVersions('0.1.2', '0.1.2-rc.1') > 0)
  assert.equal(compareDshVersions('0.1.5-rc.2', '0.1.5-rc.2'), 0)
})

test('a reviewed corridor path is open and carries notes', () => {
  const c = corridorFindings('0.1.5-rc.1', '0.1.5-rc.2')
  assert.equal(c.missingEdge, false)
  assert.equal(c.edges.length, 1)
  assert.ok(c.cards.includes('DSH-0.1.5-R2'))
})

test('a multi-hop reviewed path folds every edge', () => {
  const c = corridorFindings('0.1.2-alpha.5', '0.1.5-rc.2')
  assert.equal(c.missingEdge, false)
  assert.ok(c.edges.length >= 3)
})

test('a hop with no curated cards is a missing edge (stop the upgrade)', () => {
  const c = corridorFindings('0.1.5-rc.2', '0.1.7-alpha.1')
  assert.equal(c.missingEdge, true)
  assert.match(c.reason, /missing|gap|unreviewed|no corridor|past/i)
})

test('a release host can ride the adjacent prerelease card hop', () => {
  // on-disk 0.1.2 (release) → target 0.1.3-alpha.1 overlaps the
  // 0.1.2-rc.1 → 0.1.3-alpha.1 reviewed edge.
  const c = corridorFindings('0.1.2', '0.1.3-alpha.1')
  assert.equal(c.missingEdge, false)
})

test('a version past the last reviewed node has no path', () => {
  const c = corridorFindings('0.1.0-rc.8', '0.1.7-alpha.1')
  assert.equal(c.missingEdge, true)
})

test('downgrades never take the corridor gate', () => {
  const c = corridorFindings('0.1.5-rc.2', '0.1.2-rc.1')
  assert.equal(c.missingEdge, false)
  assert.equal(c.direction, 'down')
})

test('session format jumps at 0.1.5 and 0.1.7 boundaries', () => {
  assert.equal(sessionFormatOf('0.1.2-rc.1').sessionFormat, 'v2')
  assert.equal(sessionFormatOf('0.1.5-rc.2').sessionFormat, 'v3')
  assert.equal(sessionFormatOf('0.1.7-alpha.1').sessionFormat, 'v4')
})

test('storage gate flags a forward session-format jump', () => {
  const gate = storageGate({ currentVersion: '0.1.5-rc.2', targetVersion: '0.1.7-alpha.1' })
  assert.equal(gate.compatible, false)
  assert.match(gate.reason, /v3|v4|forward/i)
})

test('storage gate allows same-format hops', () => {
  const gate = storageGate({ currentVersion: '0.1.5-rc.1', targetVersion: '0.1.5-rc.2' })
  assert.equal(gate.compatible, true)
})

test('capability findings light prepareCall and Session.events', () => {
  const hits = capabilityFindings('registration.adapter.prepareCall(x)\nconst n = Session.events.length\n')
  const ids = hits.map((h) => h.id)
  assert.ok(ids.includes('prepareCall'))
  assert.ok(ids.includes('Session.events'))
  assert.equal(hits.find((h) => h.id === 'prepareCall').layer, 'run-time')
})

test('failure signatures map onto the three layers', () => {
  assert.equal(classifyFailureSignature("does not provide an export named 'x'").layer, 'link-time')
  assert.equal(classifyFailureSignature('duplicate loader entry id: foo').layer, 'mount-time')
  assert.equal(classifyFailureSignature('x.prepareCall is not a function').layer, 'run-time')
  assert.equal(classifyFailureSignature('this build has no Session format codec for v3').layer, 'storage')
})

test('layerFindings include required corridor gap rows', () => {
  const corridor = corridorFindings('0.1.5-rc.2', '0.1.7-alpha.1')
  const rows = buildLayerFindings({ corridor })
  assert.ok(rows.some((r) => r.layer === 'breaking-card' && r.actionLevel === 'required'))
})

test('export blockers become required link-time layer rows', () => {
  const rows = buildLayerFindings({
    blockers: [{ specifier: '@deepseek-ai/dsh-settings', missing: ['settingsNamespace'], message: 'gone' }],
  })
  assert.equal(rows[0].layer, 'link-time')
  assert.equal(rows[0].actionLevel, 'required')
})

test('empty husk publishes are skipped when picking the newest version', () => {
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  const { version, skippedEmpty } = newestHealthyVersion({
    '0.0.1-rc.1': { name: 'x', dist: { unpackedSize: 10 } },
    '0.1.5-rc.2': { name: 'x', main: 'lib/index.js', dsh: { bundle: {} }, dist: { unpackedSize: 40000 } },
  }, compare)
  assert.equal(version, '0.1.5-rc.2')
  assert.deepEqual(skippedEmpty, ['0.0.1-rc.1'])
})

test('looksEmptyPackage treats missing entry + tiny tarball as a husk', () => {
  assert.equal(looksEmptyPackage({ dist: { unpackedSize: 12 } }), true)
  assert.equal(looksEmptyPackage({ main: 'lib/index.js', dist: { unpackedSize: 40000 } }), false)
  assert.equal(looksEmptyPackage({ dsh: { bundle: { patch: './p.yml' } } }), false)
  // Sparse rows are not husks — only obvious empties block.
  assert.equal(looksEmptyPackage({}), false)
  assert.equal(looksEmptyPackage({ dist: { unpackedSize: 40000 } }), false)
})

test('emptyTargetGate blocks a husk target and a frozen empty latest', () => {
  assert.equal(emptyTargetGate({
    name: 'p', targetVersion: '0.0.1-rc.1', versionMeta: { dist: { unpackedSize: 1 } },
  }).blocked, true)
  assert.equal(emptyTargetGate({
    name: 'p', targetVersion: null, distLatest: '0.0.1-rc.1', distLatestMeta: { dist: { unpackedSize: 1 } },
  }).blocked, true)
  assert.equal(emptyTargetGate({
    name: 'p', targetVersion: '1.0.0', versionMeta: { main: 'index.js', dist: { unpackedSize: 9000 } },
  }).blocked, false)
})
