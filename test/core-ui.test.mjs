// GUI-side dual-mode semantics (client bundle): coreTargetChoices builds the
// mode chips from the scan payload — pinned newest first, then one chip per
// dist-tag with its server-computed relation. The downgrade relation is the
// load-bearing bit: it drives the red confirm and the force flag.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBundle } from './bundle-loader.mjs'

const { coreTargetChoices } = loadBundle().__test

test('choices: pinned newest first, then tag chips with relations', () => {
  const core = {
    packages: [{ current: '0.1.7-rc.2', latest: '0.2.0-rc.1', updateAvailable: true }],
    tags: [
      { tag: 'latest', version: '0.1.7-rc.2', relation: 'same' },
      { tag: 'next', version: '0.2.0-rc.1', relation: 'upgrade' },
      { tag: 'alpha', version: '0.2.0-alpha.9', relation: 'upgrade' },
    ],
  }
  const choices = coreTargetChoices(core)
  assert.equal(choices.length, 4)
  assert.equal(choices[0].key, 'pinned')
  assert.equal(choices[0].kind, 'pinned')
  assert.equal(choices[0].version, '0.2.0-rc.1')
  assert.equal(choices[0].relation, 'upgrade')
  assert.deepEqual(
    choices.slice(1).map((c) => [c.key, c.kind, c.relation]),
    [['latest', 'tag', 'same'], ['next', 'tag', 'upgrade'], ['alpha', 'tag', 'upgrade']],
  )
})

test('choices: a lagging tag chip carries the downgrade relation', () => {
  const core = {
    packages: [{ current: '0.1.7-rc.2', latest: '0.2.0-rc.1', updateAvailable: true }],
    tags: [{ tag: 'latest', version: '0.1.5-rc.2', relation: 'downgrade' }],
  }
  const latest = coreTargetChoices(core).find((c) => c.key === 'latest')
  assert.equal(latest.relation, 'downgrade')
  assert.equal(latest.version, '0.1.5-rc.2')
})

test('choices: malformed scan payloads degrade to the pinned chip only', () => {
  assert.equal(coreTargetChoices({ packages: [{ current: '1.0.0', latest: '2.0.0', updateAvailable: true }], tags: [{ tag: 'x' }] }).length, 1)
  assert.deepEqual(coreTargetChoices(null), [])
  assert.deepEqual(coreTargetChoices({}), [])
})

// ---------------------------------------------------------------------------
// Render seam: the shipped CoreCard with dual-mode chips and the gated
// execute button (the react stub's useState returns the initial state, so the
// card renders unfolded-logic-free — we assert structure, not interactions).
// ---------------------------------------------------------------------------

const { coreCardElement } = loadBundle().__test

// The card folds by default; '0' is the stored "user unfolded it on purpose"
// value. Node ships an experimental native localStorage that is unavailable
// without --localstorage-file (reads throw, the card's catch folds it), and a
// plain assignment cannot override the global — defineProperty can.
Object.defineProperty(globalThis, 'localStorage', {
  value: { getItem: () => '0', setItem: () => {} },
  configurable: true,
})

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

const corePayload = {
  packages: [{ name: '@deepseek-ai/dsh', current: '0.1.7-rc.2', latest: '0.2.0-rc.1', updateAvailable: true }],
  distTags: { latest: '0.1.7-rc.2', next: '0.2.0-rc.1' },
  tags: [
    { tag: 'latest', version: '0.1.7-rc.2', relation: 'same' },
    { tag: 'next', version: '0.2.0-rc.1', relation: 'upgrade' },
  ],
  install: { method: 'global', writable: true, prefix: '/opt/homebrew' },
  updateCommand: 'npm install -g @deepseek-ai/dsh@0.2.0-rc.1',
}

function makeT() {
  return (key, params = {}) => {
    let s = key
    for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v))
    return s
  }
}

test('core card renders mode chips, the pinned command, and the gated execute button', () => {
  // Function components render by calling them (see renderRow in
  // row-update-click.test.mjs); the stub's useState returns initial state.
  const descriptor = coreCardElement({ t: makeT(), core: corePayload, compat: { current: { findings: [] }, target: null } })
  const element = descriptor.type(descriptor.props)
  const texts = []
  const buttons = []
  walk(element, (node) => {
    if (typeof node === 'string') texts.push(node)
    if (node.type === 'button') buttons.push(node)
  })
  // Mode chips: pinned + latest + next all present.
  const flat = texts.join(' | ')
  assert.ok(flat.includes('coreModePinned'))
  assert.ok(flat.includes('0.1.7-rc.2'))
  assert.ok(flat.includes('0.2.0-rc.1'))
  // The pinned command renders verbatim.
  assert.ok(flat.includes('npm install -g @deepseek-ai/dsh@0.2.0-rc.1'))
  // The execute action exists (label key present on some button).
  assert.ok(buttons.some((b) => String(b.children?.[0] ?? '').includes('coreUpdate')))
})

test('core card degrades to copy-only when the install is not a writable global npm one', () => {
  const descriptor = coreCardElement({
    t: makeT(),
    core: { ...corePayload, install: { method: 'npx', writable: false, prefix: null } },
    compat: { current: { findings: [] }, target: null },
  })
  const element = descriptor.type(descriptor.props)
  const texts = []
  walk(element, (node) => { if (typeof node === 'string') texts.push(node) })
  const flat = texts.join(' | ')
  assert.ok(flat.includes('coreNoExec'))
  assert.ok(!flat.includes('coreUpdate')) // no execute button in copy-only mode
})
