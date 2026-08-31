#!/usr/bin/env node
/**
 * Offline host-compat check. Does not boot a DSH profile — safe to run when
 * `dsh web` dies on a third-party plugin named-export error.
 *
 *   node lib/cli.js
 *   node ~/.dsh/profiles/web/node_modules/dsh-update-copilot/lib/cli.js
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { formatCompatReport } from './compat.js'
import { scanAll } from './scan.js'

export async function runCompatCheck({
  env = process.env,
  stdout = process.stdout,
  scan = scanAll,
} = {}) {
  const result = await scan(true)
  const report = result?.compat ?? { current: { findings: [], hostVersion: null }, target: null }
  const lang = typeof env.LANG === 'string' ? env.LANG : ''
  stdout.write(`${formatCompatReport(report, lang)}\n`)
  return (report.current?.findings?.length ?? 0) > 0 ? 1 : 0
}

function invokedDirectly() {
  const argv1 = process.argv[1]
  if (typeof argv1 !== 'string' || argv1 === '') return false
  try {
    return realpathSync(argv1) === fileURLToPath(import.meta.url)
  } catch {
    return argv1.endsWith('cli.js') || argv1.endsWith('dsh-update-copilot')
  }
}

if (invokedDirectly()) {
  runCompatCheck().then((code) => process.exit(code), (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  })
}
