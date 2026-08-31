// gatherCompatForScan against a fake dsh install + plugin fixture. No network:
// target exports are injected.
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  gatherCompatForScan,
  locateDshPackageDir,
  pluginScanTargets,
  resolveHostPackageDir,
} from '../lib/compat.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'compat')
const dshDir = join(fixtures, 'fake-dsh')
const brokenDir = join(fixtures, 'broken-plugin')

test('locateDshPackageDir walks argv[1] up to @deepseek-ai/dsh', () => {
  const argv1 = join(dshDir, 'lib', 'bin.js')
  assert.equal(locateDshPackageDir(argv1), dshDir)
  assert.equal(locateDshPackageDir(join(fixtures, 'no-such', 'bin.js'), { fallbackFlat: false }), null)
})

test('resolveHostPackageDir finds nested dsh-settings', () => {
  const dir = resolveHostPackageDir(dshDir, '@deepseek-ai/dsh-settings')
  assert.equal(dir, join(dshDir, 'node_modules', '@deepseek-ai', 'dsh-settings'))
  assert.equal(resolveHostPackageDir(dshDir, '@deepseek-ai/missing'), null)
})

test('pluginScanTargets skips official packages and missing installs', () => {
  const targets = pluginScanTargets([
    {
      profile: 'web',
      plugins: [
        { name: '@dsh-external/dsh-vision-toolkit', dir: brokenDir },
        { name: '@deepseek-ai/dsh-base' },
        { name: 'not-installed' },
      ],
    },
  ], { profileDir: () => fixtures })
  assert.deepEqual(targets.map((t) => t.name), ['@dsh-external/dsh-vision-toolkit'])
  assert.deepEqual(targets[0].profiles, ['web'])
})

test('gatherCompatForScan: current findings from fake dsh; target injected', async () => {
  const profileScans = [{
    profile: 'web',
    plugins: [{ name: '@dsh-external/dsh-vision-toolkit', dir: brokenDir }],
  }]
  const core = {
    packages: [{ name: '@deepseek-ai/dsh', current: '0.1.1-rc.2', latest: '0.1.2-alpha.2', updateAvailable: true }],
  }
  const report = await gatherCompatForScan({
    profileScans,
    core,
    locateDsh: () => dshDir,
    loadTargetExports: async () => ({
      '@deepseek-ai/dsh-settings': new Set(['SettingsConflictError']),
    }),
  })
  assert.equal(report.current.findings.length, 1)
  assert.equal(report.current.hostVersion, '0.1.2-alpha.2')
  assert.equal(report.target.findings.length, 1)
  assert.equal(report.target.hostVersion, '0.1.2-alpha.2')
})
