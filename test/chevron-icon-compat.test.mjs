// Regression: dsh host 0.1.7 renamed the primitives icon exports from
// size-suffixed (IconChevronDownOutline14) to weight-suffixed
// (IconChevronDownOutlineRegular). The Chevron component hardcoded the
// pre-0.1.7 names, so on a 0.1.7 host `primitives.IconChevronDownOutline14`
// was undefined and h(undefined) threw React error #130 ("Element type is
// invalid") — the SlotErrorBoundary caught it and rendered an empty
// data-slot-error face, silently killing both the shell.overlay popup and the
// settings.section page while the sidebar trigger (no Chevron) kept working.
//
// Fix + seam: Chevron resolves the icon across host generations and degrades
// to the text glyph when neither name exists; `__test.chevronElement` hands
// back the element so a test can render the shipped Chevron against each
// generation's export shape and assert the element type is never undefined.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBundle } from './bundle-loader.mjs'

const icon = () => function HostIcon() { /* shape-only stub */ }

/** Render the shipped Chevron once against the given primitives module. */
function renderChevron(primitives, open) {
  const { __test } = loadBundle({ primitives })
  const element = __test.chevronElement({ open: open === true })
  return element.type(element.props)
}

test('host 0.1.7 shape (…OutlineRegular) renders an icon component, not undefined', () => {
  const primitives = {
    IconChevronDownOutlineRegular: icon(),
    IconChevronRightOutlineRegular: icon(),
  }
  for (const open of [false, true]) {
    const rendered = renderChevron(primitives, open)
    assert.equal(typeof rendered.type, 'function', `open=${open}: element type must be a component, got ${rendered.type}`)
    assert.notEqual(rendered.props.className, 'duc-chevron-fallback', `open=${open}: icon found, text fallback must not be used`)
  }
})

test('pre-0.1.7 host shape (…Outline14) still resolves its icon', () => {
  const primitives = {
    IconChevronDownOutline14: icon(),
    IconChevronRightOutline14: icon(),
  }
  for (const open of [false, true]) {
    const rendered = renderChevron(primitives, open)
    assert.equal(typeof rendered.type, 'function', `open=${open}: element type must be a component, got ${rendered.type}`)
    assert.notEqual(rendered.props.className, 'duc-chevron-fallback', `open=${open}: icon found, text fallback must not be used`)
  }
})

test('a future rename degrades to the text glyph instead of crashing the seat', () => {
  const rendered = renderChevron({}, false)
  assert.equal(rendered.props.className, 'duc-chevron-fallback', 'unresolvable icon names must fall back to the text chevron')
  assert.equal(rendered.children.join(''), '▸')
  const renderedOpen = renderChevron({}, true)
  assert.equal(renderedOpen.props.className, 'duc-chevron-fallback')
  assert.equal(renderedOpen.children.join(''), '▾')
})

test('primitives absent (host without the bundle) keeps the text glyph', () => {
  const { __test } = loadBundle()
  const element = __test.chevronElement({ open: false })
  const rendered = element.type(element.props)
  assert.equal(rendered.props.className, 'duc-chevron-fallback')
})
