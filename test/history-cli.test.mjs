// The offline CLI history subcommand: the rescue path when DSH will not
// boot. It must list snapshots with concrete rollback commands and degrade
// to friendly empty-state lines without throwing on missing history.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordUpdateSnapshot } from '../lib/history.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-cli-'))
process.env.DSH_HOME = home
test.after(() => rmSync(home, { recursive: true, force: true }))

function bufferText() {
  const lines = []
  return { write: (chunk) => lines.push(chunk), text: () => lines.join('') }
}

test('history prints snapshots with rollback commands, in zh and en', async () => {
  const { runHistoryCommand } = await import('../lib/cli.js')
  recordUpdateSnapshot({
    profile: 'web', name: 'my-plugin', target: 'my-plugin@2.0.0',
    before: { version: '1.4.2', spec: '^1.4.0', commit: null },
    at: new Date(Date.UTC(2026, 8, 6, 3, 0, 0)).toISOString(),
  })
  const stdout = bufferText()
  const code = runHistoryCommand({ argv: ['web', 'my-plugin'], stdout, env: { LANG: 'zh_CN.UTF-8' } })
  assert.equal(code, 0)
  const text = stdout.text()
  assert.match(text, /\[web\/my-plugin\]/)
  assert.match(text, /1\.4\.2/)
  assert.match(text, /dsh plugin --profile web add my-plugin@1\.4\.2/)
})

test('history degrades to friendly empty states, never throws', async () => {
  const { runHistoryCommand } = await import('../lib/cli.js')
  const stdout = bufferText()
  const code = runHistoryCommand({ argv: ['no-such-profile'], stdout, env: { LANG: 'en' } })
  assert.equal(code, 0)
  assert.match(stdout.text(), /No matching snapshots/)
  // A fresh home has no history at all.
  const fresh = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-cli-empty-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = fresh
  try {
    const empty = bufferText()
    assert.equal(runHistoryCommand({ argv: [], stdout: empty, env: { LANG: 'en' } }), 0)
    assert.match(empty.text(), /No update history snapshots/)
  } finally {
    process.env.DSH_HOME = previousHome
    rmSync(fresh, { recursive: true, force: true })
  }
})
