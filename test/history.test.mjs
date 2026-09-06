// Update history: pre-mutation snapshots under the copilot's own directory,
// pruned per package, with rollback targets derived from what was installed
// before. The writer is best-effort — a refusing disk must never block an
// update. The rollback target must address exactly the recorded package.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachRollback, listSnapshots, recordUpdateSnapshot, rollbackTargetOf, sanitizeName, validateRollbackTarget } from '../lib/history.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-history-'))
process.env.DSH_HOME = home
test.after(() => rmSync(home, { recursive: true, force: true }))

test('sanitizeName keeps package names flat and filesystem-safe', () => {
  assert.equal(sanitizeName('my-plugin'), 'my-plugin')
  assert.equal(sanitizeName('@scope/pkg'), '@scope__pkg')
  assert.equal(sanitizeName('../etc'), null)
  assert.equal(sanitizeName('a/b/c'), 'a__b__c')
  assert.equal(sanitizeName(''), null)
  assert.equal(sanitizeName(undefined), null)
})

test('snapshots land under the copilot history dir and read back newest-first', () => {
  const first = recordUpdateSnapshot({
    profile: 'web', name: 'my-plugin', target: 'my-plugin@2.0.0',
    before: { version: '1.0.0', spec: '^1.0.0', commit: null },
  })
  const second = recordUpdateSnapshot({
    profile: 'web', name: 'my-plugin', target: 'my-plugin@3.0.0',
    before: { version: '2.0.0', spec: '^2.0.0', commit: null },
  })
  assert.ok(first !== null && second !== null)
  assert.ok(existsSync(first) && existsSync(second))
  assert.ok(second > first, 'monotonic file names')
  const rows = listSnapshots('web', 'my-plugin')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].target, 'my-plugin@3.0.0')
  assert.equal(rows[0].before.version, '2.0.0')
  // Scoped names flatten into one directory.
  recordUpdateSnapshot({ profile: 'web', name: '@scope/pkg', before: { version: '1.0.0' } })
  assert.equal(listSnapshots('web', '@scope/pkg').length, 1)
})

test('history keeps only the newest snapshots per package', () => {
  for (let i = 0; i < 13; i += 1) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
    recordUpdateSnapshot({ profile: 'keep', name: 'p', at, before: { version: `1.0.${i}` } })
  }
  const rows = listSnapshots('keep', 'p')
  assert.equal(rows.length, 10)
  assert.equal(rows[0].before.version, '1.0.12')
  assert.equal(rows[9].before.version, '1.0.3')
})

test('a refusing disk degrades to null instead of throwing', () => {
  // A FILE occupies the profile's history directory slot — every write under
  // it must fail without throwing.
  const blocker = join(home, 'dsh-update-copilot', 'history', 'blocker-file')
  mkdirSync(join(home, 'dsh-update-copilot', 'history'), { recursive: true })
  writeFileSync(blocker, 'not a directory')
  const result = recordUpdateSnapshot({
    profile: 'blocker-file', name: 'p', before: { version: '1.0.0' },
  })
  assert.equal(result, null)
  assert.deepEqual(listSnapshots('blocker-file', 'p'), [])
})

const sha = 'a'.repeat(40)

test('rollback targets: npm version, pinned github commit, linked command text', () => {
  assert.deepEqual(
    rollbackTargetOf({ name: 'my-plugin', before: { version: '1.2.3', spec: '^1.0.0' } }),
    { channel: 'npm', target: 'my-plugin@1.2.3' },
  )
  assert.deepEqual(
    rollbackTargetOf({ name: 'gh-plugin', before: { version: '0.1.0', spec: 'github:owner/repo', commit: sha } }),
    { channel: 'github', target: `github:owner/repo#${sha}` },
  )
  assert.deepEqual(
    rollbackTargetOf({ name: 'gh-plugin', before: { version: null, spec: 'github:owner/repo#path:/sub', commit: sha } }),
    { channel: 'github', target: `github:owner/repo#${sha}` },
  )
  const linked = rollbackTargetOf({ name: 'dev-plugin', before: { version: '1.0.0', spec: 'link:../dev-plugin', commit: sha } })
  assert.equal(linked.channel, 'linked')
  assert.ok(linked.command.includes(`checkout ${sha}`))
  assert.deepEqual(rollbackTargetOf({ name: 'x', before: { spec: 'link:../dev', commit: null } }), null)
  assert.deepEqual(rollbackTargetOf(null), null)
  assert.deepEqual(rollbackTargetOf({ name: 'x', before: { spec: 'npm:other@^1' } }), null)
})

test('rollback targets validated against the recorded package', () => {
  const spec = '^1.0.0'
  assert.deepEqual(
    validateRollbackTarget('my-plugin', spec, 'my-plugin@1.2.3'),
    { target: 'my-plugin@1.2.3', targetVersion: '1.2.3', repoKey: null },
  )
  // A target addressing a DIFFERENT package would make pnpm install that
  // other package — rejected.
  assert.equal(validateRollbackTarget('my-plugin', spec, 'other-plugin@1.2.3'), null)
  assert.equal(validateRollbackTarget('my-plugin', spec, 'not-a-target'), null)
  const gh = validateRollbackTarget('gh-plugin', 'github:owner/repo', `github:owner/repo#${sha}`)
  assert.equal(gh.target, `github:owner/repo#${sha}`)
  assert.equal(gh.repoKey, `owner/repo#${sha}`)
  // A github rollback of a DIFFERENT repo is rejected.
  assert.equal(validateRollbackTarget('gh-plugin', 'github:owner/repo', 'github:other/repo#x'), null)
  // A github rollback target may not silently drop the pin.
  assert.equal(validateRollbackTarget('gh-plugin', 'github:owner/repo', 'github:owner/repo'), null)
  // Channel migration is not rollback: an npm-shaped target against a
  // github-channel dependency is rejected (and vice versa).
  assert.equal(validateRollbackTarget('gh-plugin', 'github:owner/repo', 'gh-plugin@1.2.3'), null)
  assert.equal(validateRollbackTarget('my-plugin', spec, `github:owner/repo#${sha}`), null)
})

test('attachRollback rides only outcomes that actually changed disk state', () => {
  const snapshot = { at: '2026-09-06T00:00:00Z', profile: 'web', name: 'my-plugin', before: { version: '1.4.2', spec: '^1.4.0', commit: null } }
  // A failed update that half-applied still carries the rollback suggestion.
  const failed = attachRollback({ ok: false, code: 'update_failed', changed: true, profile: 'web', name: 'my-plugin' }, snapshot)
  assert.equal(failed.rollback.target, 'my-plugin@1.4.2')
  assert.equal(failed.rollback.channel, 'npm')
  // No change → nothing to roll back; no snapshot → no suggestion.
  assert.equal(attachRollback({ ok: false, changed: false }, snapshot).rollback, undefined)
  assert.equal(attachRollback({ ok: true, changed: true }, null).rollback, undefined)
  const unchanged = attachRollback({ ok: true, changed: true, profile: 'web', name: 'my-plugin' }, { ...snapshot, before: { spec: 'link:../x', commit: null } })
  assert.equal(unchanged.rollback, undefined)
})
