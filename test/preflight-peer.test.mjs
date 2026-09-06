// Pre-flight peer-range checks (lib/preflight.js).
//
// A dsh upgrade can leave a plugin's declared peer range behind: under 0.x
// prerelease semver the range still *looks* fine while it no longer admits
// the running (or target) host — the exact class that bricks profiles at
// boot. These tests pin the prerelease-correct range semantics first (the
// #5609 boundary cases), then the warning objects the scan/brief/executor
// surfaces attach.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { peerRangeFindings, peerWarningsForPackageDir, satisfiesRange } from '../lib/preflight.js'

test('caret ranges lock the minor on 0.x and reject other-minor prereleases', () => {
  // The community pain (#5609): ^0.1.0-rc.8 reads as "fine" but excludes
  // 0.1.2-rc.1 under prerelease rules.
  assert.equal(satisfiesRange('^0.1.0-rc.8', '0.1.0-rc.8'), true)
  assert.equal(satisfiesRange('^0.1.0-rc.8', '0.1.1-rc.2'), false)
  assert.equal(satisfiesRange('^0.1.0-rc.8', '0.1.2-rc.1'), false)
  assert.equal(satisfiesRange('^0.1.0-rc.8', '0.1.0'), true)
})

test('prereleases only satisfy ranges via a same-tuple prerelease comparator', () => {
  assert.equal(satisfiesRange('^0.1.2-alpha.1', '0.1.2-rc.1'), true)
  assert.equal(satisfiesRange('^0.1.2-alpha.1', '0.1.2-alpha.4'), true)
  assert.equal(satisfiesRange('^0.1.2-alpha.1', '0.1.2'), true)
  assert.equal(satisfiesRange('^0.1.2', '0.1.2-rc.1'), false)
  assert.equal(satisfiesRange('^0.1.2', '0.1.3-alpha.1'), false)
  assert.equal(satisfiesRange('^0.1.2-alpha.1', '0.1.3-alpha.1'), false)
})

test('interval ranges admit releases from the lower-bound tuple upward', () => {
  assert.equal(satisfiesRange('>=4.0.0-rc.7 <5.0.0', '4.0.0'), true)
  assert.equal(satisfiesRange('>=4.0.0-rc.7 <5.0.0', '4.0.2'), true)
  assert.equal(satisfiesRange('>=4.0.0-rc.7 <5.0.0', '5.0.0'), false)
  assert.equal(satisfiesRange('>=4.0.0-rc.7 <5.0.0', '4.0.0-rc.6'), false)
  // Same-tuple prereleases above the lower bound match (node-semver rule).
  assert.equal(satisfiesRange('>=4.0.0-rc.7 <5.0.0', '4.0.0-rc.8'), true)
})

test('exact, tilde, and union ranges behave like node-semver', () => {
  assert.equal(satisfiesRange('0.1.2', '0.1.2'), true)
  assert.equal(satisfiesRange('0.1.2', '0.1.3'), false)
  assert.equal(satisfiesRange('~0.1.2', '0.1.9'), true)
  assert.equal(satisfiesRange('~0.1.2', '0.2.0'), false)
  assert.equal(satisfiesRange('^0.1.2 || ^0.2.0', '0.2.5'), true)
  assert.equal(satisfiesRange('^0.1.2 || ^0.2.0', '0.3.0'), false)
  assert.equal(satisfiesRange('1.x', '1.9.9'), true)
  assert.equal(satisfiesRange('1.x', '2.0.0'), false)
  assert.equal(satisfiesRange('*', '0.1.2-rc.1'), true)
  assert.equal(satisfiesRange('>=0.1.0 <0.2.0', '0.1.5'), true)
})

test('unparsable ranges and versions read as silence, never a warning', () => {
  assert.equal(satisfiesRange('workspace:^', '0.1.2'), null)
  assert.equal(satisfiesRange('catalog:', '0.1.2'), null)
  assert.equal(satisfiesRange('^0.1.2', 'not-a-version'), null)
  assert.equal(satisfiesRange('', '0.1.2'), null)
})

function finding(overrides = {}) {
  return { role: 'current', version: '0.1.3-alpha.1', ...overrides }
}

test('peer findings cover only @deepseek-ai specifiers and real versions', () => {
  const findings = peerRangeFindings({
    name: 'some-plugin',
    peerDependencies: {
      '@deepseek-ai/cordis': '^4.0.0-rc.7',
      '@deepseek-ai/dsh-tools': '>=0.0.1-rc.1',
      react: '^19.0.0',
    },
    versions: [finding()],
  })
  assert.deepEqual(findings.map((f) => f.specifier), ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools'])
  assert.equal(findings[0].plugin, 'some-plugin')
  assert.equal(findings[0].against, 'current')
  assert.equal(findings[0].range, '^4.0.0-rc.7')
  assert.equal(findings[0].version, '0.1.3-alpha.1')
})

test('peer findings evaluate the current and the target host independently', () => {
  const findings = peerRangeFindings({
    name: 'some-plugin',
    peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.2' },
    versions: [
      { role: 'current', version: '0.1.2' },
      { role: 'target', version: '0.1.3-alpha.1' },
    ],
  })
  assert.deepEqual(findings.map((f) => f.against), ['target'])
})

test('satisfied ranges, unparsable ranges, and missing versions stay silent', () => {
  const findings = peerRangeFindings({
    name: 'some-plugin',
    peerDependencies: {
      '@deepseek-ai/cordis': 'workspace:^',
      '@deepseek-ai/dsh-tools': '^0.1.2',
    },
    versions: [
      { role: 'current', version: '0.1.2' },
      { role: 'target', version: null },
    ],
  })
  assert.deepEqual(findings, [])
})

test('peer warnings read the installed manifest of a package directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'duc-preflight-'))
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'linked-plugin',
      peerDependencies: { '@deepseek-ai/dsh': '^0.1.2' },
    }))
    const warnings = peerWarningsForPackageDir(dir, [{ role: 'current', version: '0.1.3-alpha.1' }])
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].specifier, '@deepseek-ai/dsh')
    assert.equal(warnings[0].against, 'current')
    assert.deepEqual(peerWarningsForPackageDir(dir, []), [])
    assert.deepEqual(peerWarningsForPackageDir(join(dir, 'absent'), [{ role: 'current', version: '0.1.2' }]), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
