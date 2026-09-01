import test from 'node:test'
import assert from 'node:assert/strict'
import { runCompatCheck } from '../lib/cli.js'

test('runCompatCheck prints availability and does not call scanAll', async () => {
  let scanned = false
  const chunks = []
  const code = await runCompatCheck({
    env: { LANG: 'zh-CN' },
    stdout: { write(text) { chunks.push(text); return true } },
    scan: async () => { scanned = true; return {} },
    gather: async () => ({ current: { findings: [], hostVersion: '0.1.2' }, target: null }),
    collectAvailability: async () => ({
      summary: { broken: 1, missing: 1, disabled: 0, inert: 0 },
      rows: [
        { name: 'broken-entry', profile: 'web', availability: { state: 'broken', reasons: '入口缺失 / entry missing' } },
        { name: 'missing-plugin', profile: 'web', availability: { state: 'missing', reasons: '未安装 / not installed' } },
      ],
    }),
  })
  assert.equal(scanned, false)
  assert.equal(code, 0)
  const text = chunks.join('')
  assert.match(text, /broken=1/)
  assert.match(text, /missing=1/)
  assert.match(text, /broken-entry/)
})

test('runCompatCheck still exits 1 on current host compat findings', async () => {
  const code = await runCompatCheck({
    env: { LANG: 'en' },
    stdout: { write() { return true } },
    gather: async () => ({
      current: {
        hostVersion: '0.1.2',
        findings: [{ plugin: 'x', missing: ['y'], file: 'a.js', specifier: '@deepseek-ai/dsh-settings', profiles: ['web'] }],
      },
      target: null,
    }),
    collectAvailability: async () => ({ summary: { broken: 0, missing: 0, disabled: 0, inert: 0 }, rows: [] }),
  })
  assert.equal(code, 1)
})
