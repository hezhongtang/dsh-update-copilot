/**
 * Patch-name audit for profile cordis.patch.yml files.
 *
 * dsh's patch loader validates each entry's `name` strictly: when a pinned
 * name no longer matches the package it once targeted (dsh-base renamed
 * @deepseek-ai/dsh-llm-deepseek to @deepseek-ai/dsh-llm-deepseek-api-key in
 * 0.1.7-rc.2), the whole entry — config included — is silently skipped with
 * one stderr line, and the user's customizations vanish with no radar signal.
 * This audit finds those entries before they bite: a patch entry whose `name`
 * matches no package the loader could resolve becomes a finding for the
 * client's warning banner.
 *
 * Silence over noise: validNames unions every name source the loader may
 * match against, so a name is reported stale only when it is absent from ALL
 * of them — prefer a missed report over a false alarm.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { profileDir, profilesRoot, readJson } from './util.js'
import { packageDirOf } from './availability.js'
import { containedPatch, insertedPackageNames } from './scan.js'

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// Quoted-or-bare YAML scalar values, optional trailing comment. The bare name
// class mirrors insertedPackageNames() so both parsers accept the same names.
const ID_VALUE = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_.-]+))\s*(?:#.*)?$/
const NAME_VALUE = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9@][A-Za-z0-9@._/-]*))\s*(?:#.*)?$/
const RECORD_START = /^(\s*)-\s+id\s*:\s*(.*)$/
const INSERT_ITEM = /^(\s*)-\s+insert\s*:\s*(?:#.*)?$/
const FIELD = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/

function capture(match) {
  return match !== null ? (match[1] ?? match[2] ?? match[3]) : null
}

/**
 * `{ id, name }` per patch entry, in document order. Entries are records that
 * start with `- id:` — at the top level of the patch list or nested under an
 * `- insert:` item; name may be null (an entry without a name pins nothing
 * and is matched by id, which never goes stale). Fields are read only at the
 * record's own field level, so a `name:` nested inside `config:` never leaks
 * into the entry. Records nested under a plain mapping key are not
 * loader-visible entries and are ignored.
 * @param {string} text - cordis.patch.yml content.
 * @returns {Array<{id: string, name: string | null}>}
 */
export function parsePatchEntries(text) {
  const entries = []
  if (typeof text !== 'string' || text === '') return entries
  let entry = null
  let recordIndent = null
  let fieldIndent = null
  // Indent of an open `- insert:` item; records may start at any deeper level.
  let insertIndent = null
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const indent = /^\s*/.exec(line)[0].length
    const trimmed = line.trim()

    if (entry !== null && indent <= recordIndent) {
      entries.push(entry)
      entry = null
      recordIndent = null
      fieldIndent = null
    }

    if (entry !== null) {
      if (indent <= recordIndent) continue
      const field = FIELD.exec(trimmed)
      // Nested lists/scalars under a field are never direct fields; the
      // record's own field level is the first deeper mapping-key column.
      if (field === null) continue
      if (fieldIndent === null) fieldIndent = indent
      if (indent === fieldIndent && entry.name === null && field[1] === 'name') {
        entry.name = capture(NAME_VALUE.exec(field[2].trim()))
      }
      continue
    }

    const record = RECORD_START.exec(line)
    if (record !== null && (indent === 0 || (insertIndent !== null && indent > insertIndent))) {
      const id = capture(ID_VALUE.exec(record[2].trim()))
      // An unparsable id means this is not a loader entry — skip the line
      // rather than guess (its fields then attach to nothing).
      if (id !== null) {
        entry = { id, name: null }
        recordIndent = indent
        fieldIndent = null
      }
      continue
    }

    if (INSERT_ITEM.test(line) && indent === 0) {
      insertIndent = indent
      continue
    }

    if (insertIndent !== null && indent <= insertIndent) insertIndent = null
    // Top-level mapping keys and unrecognizable lines are not entries.
  }
  if (entry !== null) entries.push(entry)
  return entries
}

/**
 * Entries whose pinned name is missing from validNames. Pure over its inputs;
 * entries without a name are never stale (the loader matches those by id).
 * @param {Array<{id: string, name: string | null}>} entries
 * @param {Set<string> | string[]} validNames
 * @returns {Array<{id: string, name: string | null}>}
 */
export function stalePatchNames(entries, validNames) {
  const valid = validNames instanceof Set ? validNames : new Set(Array.isArray(validNames) ? validNames : [])
  return (Array.isArray(entries) ? entries : []).filter((entry) => entry !== null && typeof entry === 'object'
    && typeof entry.name === 'string' && entry.name !== '' && !valid.has(entry.name))
}

/**
 * Top-level package directory names under one node_modules layer, `@scope/`
 * children included. pnpm exposes direct dependencies as symlinks — a
 * symlinked directory reports isSymbolicLink, not isDirectory — so entries
 * are judged by name shape alone and dot entries (.bin, .pnpm, .modules.yaml)
 * are skipped.
 */
function addModuleDirNames(dir, names) {
  let dirents
  try {
    dirents = readdirSync(dir, { withFileTypes: true })
  } catch { /* layer absent — nothing to add */ }
  for (const dirent of dirents ?? []) {
    if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue
    if (dirent.name.startsWith('@')) {
      let scoped
      try {
        scoped = readdirSync(join(dir, dirent.name), { withFileTypes: true })
      } catch { continue }
      for (const child of scoped) {
        if (child.name.startsWith('.') || child.name === 'node_modules') continue
        names.add(`${dirent.name}/${child.name}`)
      }
      continue
    }
    names.add(dirent.name)
  }
}

/**
 * Every `name:` scalar in a bundle patch text — the loader's target.name
 * universe. dsh-base's patch carries the plugin rows a profile's own patch
 * entries address by id, and most of them are plain rows (the llm plugins),
 * which `insertedPackageNames` (only the `- insert:` package records) does
 * not cover. A pinned name any row here still declares is resolvable.
 */
function patchRowNames(text) {
  const names = new Set()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^[ \t]*name:[ \t]+['"]?(@?[A-Za-z0-9@][A-Za-z0-9@._/-]*)['"]?[ \t]*(?:#.*)?$/.exec(line)
    if (m !== null && m[1] !== '') names.add(m[1])
  }
  return names
}

/**
 * Audit one profile's cordis.patch.yml for entries pinning package names the
 * loader can no longer resolve. validNames deliberately unions every source
 * the loader may match against: the dependency tree (deps keys), the
 * manifest's declared dsh.profile.bundles, both node_modules layers
 * (profile-local and the flat profiles-root fallback), and the patches of
 * every bundle plugin — deps AND bundles entries, because official bundles
 * like dsh-base live in the flat layer outside the profile's dependencies —
 * collecting both their insert records and their plain row names. That last
 * source is how a rename shipped inside a bundle (the plugin arrives
 * transitively, e.g. dsh-llm-deepseek → dsh-llm-deepseek-api-key in
 * 0.1.7-rc.2) is still recognized as the current name. Only names absent
 * from ALL sources become findings.
 * @param {string} profile - profile directory name.
 * @param {Record<string, string>} deps - the profile's dependencies map.
 * @param {Set<string> | string[] | null} bundles - dsh.profile.bundles names.
 * @returns {Array<{profile: string, id: string, pinnedName: string}>}
 */
export function auditProfilePatch(profile, deps, bundles) {
  const dir = profileDir(profile)
  const text = readText(join(dir, 'cordis.patch.yml'))
  if (text === null) return []
  const valid = new Set(Object.keys(deps ?? {}))
  const candidates = new Map(Object.entries(deps ?? {}))
  for (const name of bundles ?? []) {
    if (typeof name === 'string' && name !== '') {
      valid.add(name)
      if (!candidates.has(name)) candidates.set(name, undefined)
    }
  }
  addModuleDirNames(join(dir, 'node_modules'), valid)
  addModuleDirNames(join(profilesRoot(), 'node_modules'), valid)
  for (const [name, spec] of candidates) {
    let packageDir = packageDirOf(dir, name, spec)
    if (!existsSync(join(packageDir, 'package.json'))) {
      // Official bundles ship in the flat profiles-root layer, not the
      // profile's own node_modules — the loader reads them from there.
      packageDir = join(profilesRoot(), 'node_modules', name)
    }
    const manifest = readJson(join(packageDir, 'package.json'))
    const patch = containedPatch(packageDir, manifest?.dsh?.bundle?.patch)
    if (patch === null) continue
    for (const inserted of insertedPackageNames(patch)) valid.add(inserted)
    for (const rowName of patchRowNames(patch)) valid.add(rowName)
  }
  return stalePatchNames(parsePatchEntries(text), valid)
    .map((entry) => ({ profile, id: entry.id, pinnedName: entry.name }))
}
