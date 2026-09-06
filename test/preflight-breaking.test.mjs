// Breaking-change signals (lib/preflight.js breakingFindings): heuristic
// line-level markers over the brief's already-fetched material — release
// bodies and commit subjects. Purely informational: a hit is never a gate
// blocker, and missing material degrades to no signal.
import test from 'node:test'
import assert from 'node:assert/strict'
import { breakingFindings } from '../lib/preflight.js'

test('conventional-bang subjects, BREAKING CHANGE bodies, and removal verbs hit', () => {
  const findings = breakingFindings({
    commits: [
      { message: 'feat(ui)!: rename code-mode to ptc' },
      { message: 'fix: correct an off-by-one' },
      { sha: 'abc', message: 'refactor: remove ApiProxy package' },
    ],
    releases: [
      { tag: 'v2', name: 'v2.0.0', body: '## Changes\n- BREAKING CHANGE: settings RPCs are gone\n- drop the legacy Host event carriers\nThe gallery renders faster now.' },
    ],
  })
  assert.equal(findings.length, 4)
  assert.ok(findings.every((f) => f.type === 'breaking'))
  // Evidence keeps the original line, trimmed; commit hits carry source.
  assert.equal(findings[0].source, 'commit')
  assert.equal(findings[0].line, 'feat(ui)!: rename code-mode to ptc')
  const releaseLines = findings.filter((f) => f.source === 'release').map((f) => f.line)
  assert.ok(releaseLines.some((line) => line.includes('BREAKING CHANGE')))
  assert.ok(releaseLines.some((line) => line.includes('drop the legacy')))
})

test('Chinese markers hit: 移除 / 删除 / 更名 / 重命名 / 废弃', () => {
  const findings = breakingFindings({
    commits: [
      { message: 'feat!: 移除 ApiProxy 包' },
      { message: 'fix: 更名 web 伪协议' },
      { message: 'docs: 废弃旧示例' },
      { message: 'chore: 清理注释' },
    ],
  })
  assert.equal(findings.length, 3)
})

test('clean material produces no signal', () => {
  assert.deepEqual(breakingFindings({
    commits: [
      { message: 'fix: correct an off-by-one' },
      { message: 'docs: refresh the readme' },
    ],
    releases: [{ tag: 'v1', name: 'v1.0.1', body: 'Patch release: performance and stability.' }],
  }), [])
})

test('empty or missing material degrades to no signal; hits cap at ten', () => {
  assert.deepEqual(breakingFindings({}), [])
  assert.deepEqual(breakingFindings(null), [])
  const many = { commits: Array.from({ length: 20 }, (_, i) => ({ message: `fix${i}!: 移除 thing ${i}` })) }
  assert.equal(breakingFindings(many).length, 10)
})
