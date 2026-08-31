import test from 'node:test'
import assert from 'node:assert/strict'
import { runCompatCheck } from '../lib/cli.js'

test('runCompatCheck does not call scanAll (stays local when DSH will not boot)', async () => {
  let scanned = false
  await runCompatCheck({
    env: { LANG: 'en' },
    stdout: { write() { return true } },
    scan: async () => { scanned = true; return { compat: { current: { findings: [] }, target: null } } },
    gather: async () => ({ current: { findings: [], hostVersion: '0.1.2-alpha.2' }, target: null }),
  })
  assert.equal(scanned, false)
})

test('runCompatCheck exits 1 when current host findings exist', async () => {
  const chunks = []
  const code = await runCompatCheck({
    env: { LANG: 'zh-CN' },
    stdout: { write(text) { chunks.push(text); return true } },
    gather: async () => ({
        current: {
          hostVersion: '0.1.2-alpha.2',
          findings: [{
            plugin: '@dsh-external/dsh-vision-toolkit',
            profiles: ['web'],
            file: 'lib/config.js',
            specifier: '@deepseek-ai/dsh-settings',
            missing: ['settingsNamespace'],
            disablePatch: '- id: vision-toolkit\n  disabled: true',
            removeCommands: ['dsh plugin --profile web remove @dsh-external/dsh-vision-toolkit'],
          }],
        },
        target: null,
    }),
  })
  assert.equal(code, 1)
  const text = chunks.join('')
  assert.match(text, /settingsNamespace/)
  assert.match(text, /disabled: true/)
})

test('runCompatCheck exits 0 when only target findings exist', async () => {
  const code = await runCompatCheck({
    env: { LANG: 'en_US' },
    stdout: { write() { return true } },
    gather: async () => ({
        current: { hostVersion: '0.1.1-rc.2', findings: [] },
        target: { hostVersion: '0.1.2-alpha.2', findings: [{ plugin: 'x', missing: ['y'], file: 'a.js', specifier: '@deepseek-ai/dsh-settings', profiles: ['web'] }] },
    }),
  })
  assert.equal(code, 0)
})
