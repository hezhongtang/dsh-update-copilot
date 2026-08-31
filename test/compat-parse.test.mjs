// Named-import / named-export parsers for the host-compat scanner.
//
// The failure that motivated this: a third-party plugin `import { settingsNamespace }`
// from `@deepseek-ai/dsh-settings`, while DSH 0.1.2-alpha.2 stopped exporting that
// name. Peer ranges still matched. These tests pin the static parse that catches it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseNamedExports, parseNamedImports } from '../lib/compat.js'

test('parseNamedImports: vision-toolkit config.js named import', () => {
  const source = `import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
export const VISION_TOOLKIT_SETTINGS_NAMESPACE = settingsNamespace('vision-toolkit');
`
  const imports = parseNamedImports(source)
  assert.deepEqual(
    imports.filter((row) => row.specifier === '@deepseek-ai/dsh-settings'),
    [{ specifier: '@deepseek-ai/dsh-settings', names: ['settingsNamespace'] }],
  )
})

test('parseNamedImports: skips import type and type-only members', () => {
  const source = `
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { SettingsConflictError, type SettingsDescriptor } from '@deepseek-ai/dsh-settings'
`
  const imports = parseNamedImports(source)
  assert.deepEqual(imports, [
    { specifier: '@deepseek-ai/dsh-settings', names: ['SettingsConflictError'] },
  ])
})

test('parseNamedImports: import { a as b } records the export name a', () => {
  const source = `import { settingsNamespace as ns } from '@deepseek-ai/dsh-settings'\n`
  assert.deepEqual(parseNamedImports(source), [
    { specifier: '@deepseek-ai/dsh-settings', names: ['settingsNamespace'] },
  ])
})

test('parseNamedImports: multiline brace list', () => {
  const source = `import {
  SettingsConflictError,
  redactSecrets,
} from '@deepseek-ai/dsh-settings'
`
  assert.deepEqual(parseNamedImports(source), [{
    specifier: '@deepseek-ai/dsh-settings',
    names: ['SettingsConflictError', 'redactSecrets'],
  }])
})

test('parseNamedImports: ignores import…from prose inside a block comment', () => {
  const source = `/**
 * This module used to import two helpers from
 * \`@deepseek-ai/dsh-settings\`. sctx.settings.register(ns, schema,
 * { base }) is identical. Installing the market stopped the host:
 *
 *   SyntaxError: does not provide an export named 'installSettingsSection'
 */
import z from '@deepseek-ai/schemastery'
import { restartAllowed } from './restart.js'
`
  assert.deepEqual(parseNamedImports(source), [
    { specifier: './restart.js', names: ['restartAllowed'] },
  ])
})

test('parseNamedImports: skips default, namespace, and side-effect imports', () => {
  const source = `
import z from '@deepseek-ai/schemastery'
import * as settings from '@deepseek-ai/dsh-settings'
import '@deepseek-ai/dsh-settings'
`
  assert.deepEqual(parseNamedImports(source), [])
})

test('parseNamedExports: 0.1.2-alpha.2 dsh-settings list has no settingsNamespace', () => {
  const source = `export { SettingsConflictError, SettingsProvider, SettingsProvider as default, redactSecrets };
`
  const { names } = parseNamedExports(source)
  assert.equal(names.has('SettingsConflictError'), true)
  assert.equal(names.has('SettingsProvider'), true)
  assert.equal(names.has('redactSecrets'), true)
  assert.equal(names.has('default'), true)
  assert.equal(names.has('settingsNamespace'), false)
})

test('parseNamedExports: export { foo as bar } provides bar, not foo', () => {
  const { names } = parseNamedExports(`export { parseSettingsNamespace as settingsNamespace };`)
  assert.equal(names.has('settingsNamespace'), true)
  assert.equal(names.has('parseSettingsNamespace'), false)
})

test('parseNamedExports: function/class/const and export * from', () => {
  const source = `
export function settingsNamespace(value) {}
export class SettingsConflictError {}
export const redactSecrets = () => {}
export * from './redact.js'
export type { SettingsNamespace } from './types.ts'
`
  const parsed = parseNamedExports(source)
  assert.equal(parsed.names.has('settingsNamespace'), true)
  assert.equal(parsed.names.has('SettingsConflictError'), true)
  assert.equal(parsed.names.has('redactSecrets'), true)
  assert.equal(parsed.names.has('SettingsNamespace'), false)
  assert.deepEqual(parsed.stars, ['./redact.js'])
})
