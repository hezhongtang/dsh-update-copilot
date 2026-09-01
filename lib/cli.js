#!/usr/bin/env node
/**
 * Offline host-compat check. Does not boot a DSH profile — safe to run when
 * `dsh web` dies on a third-party plugin named-export error.
 *
 *   node lib/cli.js
 *   node ~/.dsh/profiles/web/node_modules/dsh-update-copilot/lib/cli.js
 */
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatAvailabilityReport, summarizeAvailability, verdictAvailability } from './availability.js'
import { formatCompatReport, gatherCompatForScan, isOfficialPackage } from './compat.js'
import { bundleNamesOf, inferMountRelationships, listProfiles, pluginEntries, pluginMemberNames } from './scan.js'
import { profileDir, readJson } from './util.js'

function localProfileScans() {
  return listProfiles().map((profile) => {
    const manifest = readJson(join(profileDir(profile), 'package.json'))
    const deps = manifest?.dependencies ?? {}
    const plugins = pluginEntries(deps, bundleNamesOf(manifest)).map(([name, spec]) => {
      const dir = /^(link:|file:)/.test(spec)
        ? spec.replace(/^(link:|file:)/, '')
        : join(profileDir(profile), 'node_modules', name)
      return { name, dir }
    }).filter((row) => !isOfficialPackage(row.name))
    return { profile, plugins }
  })
}

/** Filesystem-only availability over every profile's plugin members. */
export function collectLocalAvailability() {
  const rows = []
  for (const profile of listProfiles()) {
    const dir = profileDir(profile)
    const manifest = readJson(join(dir, 'package.json'))
    const deps = manifest?.dependencies ?? {}
    const bundles = bundleNamesOf(manifest)
    const mount = inferMountRelationships(profile, deps)
    const members = pluginMemberNames(profile, deps, mount)
    for (const name of members) {
      if (isOfficialPackage(name)) continue
      const spec = deps[name] ?? ''
      rows.push({
        name,
        profile,
        availability: verdictAvailability({
          profileDir: dir,
          name,
          spec,
          inBundles: bundles instanceof Set ? bundles.has(name) : false,
        }),
      })
    }
  }
  return { summary: summarizeAvailability(rows), rows }
}

export async function runCompatCheck({
  env = process.env,
  stdout = process.stdout,
  gather = gatherCompatForScan,
  collectAvailability = async () => null,
} = {}) {
  const lang = typeof env.LANG === 'string' ? env.LANG : ''
  const avail = await collectAvailability()
  if (avail !== null && avail !== undefined) {
    stdout.write(`${formatAvailabilityReport(avail.summary, avail.rows, lang)}\n`)
  }
  const report = await gather({
    profileScans: localProfileScans(),
    core: { packages: [{ updateAvailable: false }] },
    force: true,
  })
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
  runCompatCheck({ collectAvailability: collectLocalAvailability }).then((code) => process.exit(code), (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  })
}
