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
import { listHistoryPackages, listHistoryProfiles, listSnapshots, rollbackTargetOf } from './history.js'
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

/**
 * Update history listing for the offline rescue path: works when DSH itself
 * will not boot. `argv` holds the positional [profile] [package] after the
 * `history` subcommand. Every snapshot prints the pre-update state and the
 * rollback command — pnpm/github targets through `dsh plugin add`, local
 * checkouts as the git command that restores the old commit.
 */
export function runHistoryCommand({ argv = [], stdout = process.stdout, env = process.env } = {}) {
  const zh = typeof env.LANG === 'string' && env.LANG.toLowerCase().startsWith('zh')
  const args = argv.filter((arg) => !arg.startsWith('-'))
  const [profileArg, nameArg] = args
  const profiles = profileArg !== undefined ? [profileArg] : listHistoryProfiles()
  if (profiles.length === 0) {
    stdout.write(`${zh ? '没有更新历史快照。' : 'No update history snapshots.'}\n`)
    return 0
  }
  let count = 0
  for (const profile of profiles) {
    const packages = nameArg !== undefined ? [nameArg] : listHistoryPackages(profile)
    for (const name of packages) {
      for (const snapshot of listSnapshots(profile, name)) {
        count += 1
        const before = snapshot.before ?? {}
        stdout.write(`\n[${snapshot.profile ?? profile}/${snapshot.name ?? name}]  at=${snapshot.at ?? '—'}\n`)
        stdout.write(`  ${zh ? '更新前' : 'before'}: ${before.version ?? '—'} (${before.spec ?? '—'}) commit=${before.commit?.slice(0, 8) ?? '—'}\n`)
        const rollback = rollbackTargetOf(snapshot)
        if (rollback === null) {
          stdout.write(`  ${zh ? '回滚' : 'rollback'}: ${zh ? '无法推导自动回滚目标（手动检查 profile 的 pnpm-lock.yaml）' : 'no derivable rollback target (inspect the profile pnpm-lock.yaml manually)'}\n`)
        } else if (rollback.channel === 'linked') {
          stdout.write(`  ${zh ? '回滚' : 'rollback'}: ${rollback.command}\n`)
        } else {
          stdout.write(`  ${zh ? '回滚' : 'rollback'}: dsh plugin --profile ${snapshot.profile ?? profile} add ${rollback.target}\n`)
        }
        if (typeof snapshot.patch?.text === 'string' && snapshot.patch.text !== '') {
          stdout.write(`  ${zh ? '更新前 bundle patch 已存档，可按需还原' : 'the pre-update bundle patch is archived and can be restored'}: ${snapshot.patch.path}\n`)
        }
      }
    }
  }
  if (count === 0) stdout.write(`${zh ? '没有匹配的快照。' : 'No matching snapshots.'}\n`)
  return 0
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
  const argv = process.argv.slice(2)
  if (argv[0] === 'history') {
    runHistoryCommand({ argv: argv.slice(1) }).then((code) => process.exit(code), (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(2)
    })
  } else {
    runCompatCheck({ collectAvailability: collectLocalAvailability }).then((code) => process.exit(code), (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(2)
    })
  }
}
