/**
 * Host named-export compatibility scanner.
 *
 * Third-party plugins import names from `@deepseek-ai/*`. A DSH alpha can drop
 * a public name while peer ranges still match; the plugin then fails to load
 * and takes the whole profile tree with it. This module statically compares
 * those named imports against the host package's actual exports.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { TtlCache, execText, profileDir, profilesRoot, readJson } from './util.js'

const GATHER_TTL_MS = 10 * 60 * 1000
const gatherCache = new TtlCache(GATHER_TTL_MS)

const IMPORT_RE = /(?:^|\n|;)[ \t]*import\s*(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g
const EXPORT_LIST_RE = /(?:^|\n|;)[ \t]*export\s*(type\s+)?\{([\s\S]*?)\}(?:\s*from\s*['"]([^'"]+)['"])?/g
const EXPORT_STAR_RE = /(?:^|\n|;)[ \t]*export\s*\*\s*from\s*['"]([^'"]+)['"]/g
const EXPORT_FN_RE = /(?:^|\n|;)[ \t]*export\s+(?:async\s+)?function\s+(?:\*\s*)?([A-Za-z_$][\w$]*)/g
const EXPORT_CLASS_RE = /(?:^|\n|;)[ \t]*export\s+class\s+([A-Za-z_$][\w$]*)/g
const EXPORT_VAR_RE = /(?:^|\n|;)[ \t]*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g
const REL_FROM_RE = /(?:^|\n|;)[ \t]*(?:import|export)\s*[\s\S]*?from\s*['"](\.[^'"]+)['"]/g
const REL_BARE_RE = /(?:^|\n|;)[ \t]*import\s*['"](\.[^'"]+)['"]/g

function stripComments(source) {
  return String(source).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
}

function splitExportList(inner) {
  const names = []
  for (const raw of inner.split(',')) {
    let part = raw.trim()
    if (part === '') continue
    if (/^type\s+/.test(part)) continue
    const as = /\s+as\s+/.exec(part)
    if (as !== null) {
      names.push({ original: part.slice(0, as.index).trim(), exported: part.slice(as.index + as[0].length).trim() })
    } else {
      names.push({ original: part, exported: part })
    }
  }
  return names
}

/**
 * Named ESM imports in `source`. Type-only imports and type-only members are
 * dropped (they never hit the runtime loader). `import { a as b }` records `a`,
 * the name the exporting module must provide.
 * @param {string} source
 * @returns {Array<{ specifier: string, names: string[] }>}
 */
export function parseNamedImports(source) {
  const rows = []
  const text = stripComments(source)
  IMPORT_RE.lastIndex = 0
  let m
  while ((m = IMPORT_RE.exec(text)) !== null) {
    if (m[1] !== undefined) continue
    const clause = m[2]
    const specifier = m[3]
    if (clause.trim().startsWith('*')) continue
    const brace = clause.indexOf('{')
    if (brace === -1) continue
    const names = splitExportList(clause.slice(brace + 1, clause.lastIndexOf('}')))
      .map((entry) => entry.original)
      .filter((name) => name !== '' && name !== 'default')
    if (names.length > 0) rows.push({ specifier, names })
  }
  return rows
}

/**
 * Named ESM exports in `source`. `export { foo as bar }` provides `bar`.
 * `export type { … }` is ignored. `export * from` specifiers are listed in
 * `stars` so a walker can follow relative re-exports.
 * @param {string} source
 * @returns {{ names: Set<string>, stars: string[] }}
 */
export function parseNamedExports(source) {
  const names = new Set()
  const stars = []
  const text = stripComments(source)

  EXPORT_LIST_RE.lastIndex = 0
  let m
  while ((m = EXPORT_LIST_RE.exec(text)) !== null) {
    if (m[1] !== undefined) continue
    for (const entry of splitExportList(m[2])) {
      if (entry.exported !== '') names.add(entry.exported)
    }
  }

  EXPORT_STAR_RE.lastIndex = 0
  while ((m = EXPORT_STAR_RE.exec(text)) !== null) stars.push(m[1])

  EXPORT_FN_RE.lastIndex = 0
  while ((m = EXPORT_FN_RE.exec(text)) !== null) names.add(m[1])

  EXPORT_CLASS_RE.lastIndex = 0
  while ((m = EXPORT_CLASS_RE.exec(text)) !== null) names.add(m[1])

  EXPORT_VAR_RE.lastIndex = 0
  while ((m = EXPORT_VAR_RE.exec(text)) !== null) names.add(m[1])

  return { names, stars }
}

export function isHostSpecifier(specifier) {
  return typeof specifier === 'string' && specifier.startsWith('@deepseek-ai/')
}

/**
 * Compare plugin named imports against a host export map.
 * @param {Array<{ plugin: string, file: string, specifier: string, names: string[] }>} imports
 * @param {Record<string, Set<string>>} hostExports
 * @param {{ against: 'current' | 'target', hostVersion: string | null }} meta
 */
export function diffHostImports(imports, hostExports, meta) {
  const findings = []
  for (const row of imports) {
    if (!isHostSpecifier(row.specifier)) continue
    const exported = hostExports[row.specifier]
    const hostMissing = exported === undefined
    // A target pack/version miss is not evidence the upgrade is incompatible.
    if (hostMissing && meta.against === 'target') continue
    const missing = hostMissing
      ? [...row.names]
      : row.names.filter((name) => !exported.has(name))
    if (missing.length === 0) continue
    findings.push({
      plugin: row.plugin,
      file: row.file,
      specifier: row.specifier,
      missing,
      against: meta.against,
      hostVersion: meta.hostVersion ?? null,
      ...(hostMissing ? { hostMissing: true } : {}),
    })
  }
  return findings
}

/** Id-targeted user-layer patch that stops a loader entry from starting. */
export function disablePatchSnippet(id) {
  return `- id: ${id}\n  disabled: true`
}

/** Official CLI uninstall for one profile. */
export function removeCommand(profile, packageName) {
  return `dsh plugin --profile ${profile} remove ${packageName}`
}

export function isOfficialPackage(name) {
  return typeof name === 'string' && name.startsWith('@deepseek-ai/')
}

/** Package entry file relative to the package root, or null. */
export function entryFromManifest(pkg) {
  const exp = pkg?.exports
  if (typeof exp === 'string') return exp
  if (exp !== null && typeof exp === 'object') {
    const dot = exp['.']
    if (typeof dot === 'string') return dot
    if (dot !== null && typeof dot === 'object') {
      if (typeof dot.default === 'string') return dot.default
      if (typeof dot.import === 'string') return dot.import
    }
  }
  if (typeof pkg?.module === 'string') return pkg.module
  if (typeof pkg?.main === 'string') return pkg.main
  return null
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function resolveRelative(fromFile, spec) {
  const candidate = resolve(dirname(fromFile), spec)
  if (existsSync(candidate)) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch { /* fall through */ }
    const index = join(candidate, 'index.js')
    if (existsSync(index)) return index
  }
  if (extname(spec) === '') {
    for (const ext of ['.js', '.mjs', '.cjs']) {
      const withExt = candidate + ext
      if (existsSync(withExt)) return withExt
    }
  }
  return candidate
}

function relativeSpecifiers(source) {
  const text = stripComments(source)
  const specs = []
  REL_FROM_RE.lastIndex = 0
  let m
  while ((m = REL_FROM_RE.exec(text)) !== null) specs.push(m[1])
  REL_BARE_RE.lastIndex = 0
  while ((m = REL_BARE_RE.exec(text)) !== null) specs.push(m[1])
  return specs
}

/**
 * Walk a plugin's published entry graph and collect `@deepseek-ai/*` named
 * imports. Relative imports are followed; bare specifiers are not.
 * @param {string} pluginDir
 * @returns {Array<{ plugin: string, file: string, specifier: string, names: string[] }>}
 */
export function collectPluginHostImports(pluginDir) {
  const pkg = readJson(join(pluginDir, 'package.json')) ?? {}
  const plugin = typeof pkg.name === 'string' ? pkg.name : pluginDir
  const entry = entryFromManifest(pkg)
  if (entry === null) return []
  const seen = new Set()
  const queue = [resolve(pluginDir, entry)]
  const imports = []
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const source = readText(file)
    if (source === null) continue
    for (const row of parseNamedImports(source)) {
      if (isHostSpecifier(row.specifier)) {
        imports.push({
          plugin,
          file: relative(pluginDir, file),
          specifier: row.specifier,
          names: row.names,
        })
      }
    }
    for (const spec of relativeSpecifiers(source)) {
      queue.push(resolveRelative(file, spec))
    }
  }
  return imports
}

/**
 * Named exports of a host package, following relative `export * from`.
 * @param {string} packageDir
 * @returns {{ name: string | null, version: string | null, names: Set<string> }}
 */
export function readHostExports(packageDir) {
  const pkg = readJson(join(packageDir, 'package.json')) ?? {}
  const entry = entryFromManifest(pkg)
  const names = new Set()
  if (entry === null) {
    return { name: pkg.name ?? null, version: pkg.version ?? null, names }
  }
  const seen = new Set()
  const queue = [resolve(packageDir, entry)]
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const source = readText(file)
    if (source === null) continue
    const parsed = parseNamedExports(source)
    for (const name of parsed.names) names.add(name)
    for (const spec of parsed.stars) {
      if (spec.startsWith('.')) queue.push(resolveRelative(file, spec))
    }
  }
  return {
    name: typeof pkg.name === 'string' ? pkg.name : null,
    version: typeof pkg.version === 'string' ? pkg.version : null,
    names,
  }
}

/**
 * Loader entry id from the plugin's bundle patch, if it declares one.
 * @param {string} pluginDir
 * @returns {string | null}
 */
export function cordisEntryId(pluginDir) {
  const text = readText(join(pluginDir, 'cordis.patch.yml'))
  if (text === null) return null
  const insert = /- insert:\s*\n[ \t]*- id:\s*['"]?([A-Za-z0-9_.-]+)/.exec(text)
  if (insert !== null) return insert[1]
  const any = /(?:^|\n)[ \t]*- id:\s*['"]?([A-Za-z0-9_.-]+)/.exec(text)
  return any !== null ? any[1] : null
}

/**
 * Scan one third-party plugin against a host export map.
 * Official `@deepseek-ai/*` packages are skipped — they ship with the core.
 */
export function reportPluginCompat({ name, dir, profiles, hostExports, against, hostVersion }) {
  if (isOfficialPackage(name)) return { findings: [], skipped: 'official' }
  const imports = collectPluginHostImports(dir)
  const findings = diffHostImports(imports, hostExports, { against, hostVersion })
  const entryId = cordisEntryId(dir)
  const disablePatch = entryId !== null ? disablePatchSnippet(entryId) : null
  const removeCommands = (profiles ?? []).map((profile) => removeCommand(profile, name))
  for (const finding of findings) {
    finding.plugin = name
    finding.entryId = entryId
    finding.disablePatch = disablePatch
    finding.removeCommands = removeCommands
    finding.profiles = profiles ?? []
  }
  return { findings }
}

/**
 * Resolve each host specifier through `resolvePackageDir` and read its exports.
 * Missing packages are omitted (the diff then flags `hostMissing`).
 * @param {string[]} specifiers
 * @param {(specifier: string) => string | null} resolvePackageDir
 * @returns {Record<string, Set<string>>}
 */
export function hostExportsMap(specifiers, resolvePackageDir) {
  const map = {}
  for (const spec of specifiers) {
    const dir = resolvePackageDir(spec)
    if (dir === null || dir === undefined) continue
    map[spec] = readHostExports(dir).names
  }
  return map
}

function scanPluginList(plugins, hostExports, against, hostVersion) {
  const findings = []
  for (const plugin of plugins) {
    const { findings: hits } = reportPluginCompat({
      name: plugin.name,
      dir: plugin.dir,
      profiles: plugin.profiles,
      hostExports,
      against,
      hostVersion,
    })
    findings.push(...hits)
  }
  return findings
}

/**
 * @param {{
 *   plugins: Array<{ name: string, dir: string, profiles: string[] }>,
 *   currentExports: Record<string, Set<string>>,
 *   currentVersion: string | null,
 *   targetExports: Record<string, Set<string>> | null,
 *   targetVersion: string | null,
 * }} args
 */
export async function buildCompatReport({
  plugins,
  currentExports,
  currentVersion,
  targetExports,
  targetVersion,
}) {
  const current = {
    hostVersion: currentVersion,
    findings: scanPluginList(plugins, currentExports ?? {}, 'current', currentVersion),
  }
  const target = targetExports === null || targetVersion === null
    ? null
    : {
        hostVersion: targetVersion,
        findings: scanPluginList(plugins, targetExports, 'target', targetVersion),
      }
  return { current, target }
}

/** Attach findings onto aggregated plugin rows (mutates `plugins`). */
export function attachCompatToPlugins(plugins, report) {
  const byPlugin = new Map()
  for (const finding of [...(report?.current?.findings ?? []), ...(report?.target?.findings ?? [])]) {
    let list = byPlugin.get(finding.plugin)
    if (list === undefined) {
      list = []
      byPlugin.set(finding.plugin, list)
    }
    list.push(finding)
  }
  for (const plugin of plugins) {
    const hits = byPlugin.get(plugin.name)
    if (hits !== undefined) plugin.compat = hits
  }
  return plugins
}

/**
 * @returns {{ current: number, target: number, plugins: string[] } | null}
 */
export function compatSummary(report) {
  if (report === null || report === undefined) return null
  const current = report.current?.findings?.length ?? 0
  const target = report.target?.findings?.length ?? 0
  if (current === 0 && target === 0) return null
  const names = new Set()
  for (const finding of report.current?.findings ?? []) names.add(finding.plugin)
  for (const finding of report.target?.findings ?? []) names.add(finding.plugin)
  return { current, target, plugins: [...names].sort() }
}

function formatFinding(finding, zh) {
  const missing = finding.missing.join(', ')
  const lines = []
  lines.push(`  ${finding.plugin} (${(finding.profiles ?? []).join(', ') || '—'})`)
  const hostNote = finding.hostMissing
    ? (zh ? '（host 包未找到）' : ' (host package not found)')
    : ''
  const where = finding.against === 'target'
    ? (zh ? '目标版本导出里没有' : 'not exported by the target host')
    : (zh ? '当前导出里没有' : 'not exported')
  lines.push(zh
    ? `    ${finding.file} 从 ${finding.specifier} 导入 ${missing}，${where}${hostNote}`
    : `    ${finding.file} imports ${missing} from ${finding.specifier} — ${where}${hostNote}`)
  if (typeof finding.disablePatch === 'string') {
    lines.push(zh
      ? `    临时禁用（追加到该 profile 的 cordis.patch.yml）：`
      : `    temporarily disable (append to that profile's cordis.patch.yml):`)
    for (const line of finding.disablePatch.split('\n')) lines.push(`      ${line}`)
  }
  if (Array.isArray(finding.removeCommands) && finding.removeCommands.length > 0) {
    lines.push(zh ? '    或卸载：' : '    or uninstall:')
    for (const cmd of finding.removeCommands) lines.push(`      ${cmd}`)
  }
  return lines.join('\n')
}

/**
 * Human-readable report for the offline CLI. `lang` is `'zh'` or anything else
 * for English (typically `process.env.LANG`).
 */
export function formatCompatReport(report, lang = 'en') {
  const zh = typeof lang === 'string' && lang.toLowerCase().startsWith('zh')
  const lines = []
  const currentN = report?.current?.findings?.length ?? 0
  const targetN = report?.target?.findings?.length ?? 0
  const currentVer = report?.current?.hostVersion ?? '—'
  const targetVer = report?.target?.hostVersion ?? null

  lines.push(zh ? 'DSH 第三方插件 × host named export 检查' : 'DSH third-party plugin × host named-export check')
  lines.push(zh
    ? `当前 host ${currentVer}：${currentN} 处不兼容`
    : `current host ${currentVer}: ${currentN} finding(s)`)
  for (const finding of report?.current?.findings ?? []) lines.push(formatFinding(finding, zh))
  if (targetVer !== null) {
    lines.push(zh
      ? `目标 DSH ${targetVer}：${targetN} 处可能不兼容`
      : `target DSH ${targetVer}: ${targetN} finding(s)`)
    for (const finding of report?.target?.findings ?? []) lines.push(formatFinding(finding, zh))
  }
  if (currentN === 0 && targetN === 0) {
    lines.push(zh ? '未发现缺 named export。' : 'No missing named exports found.')
  }
  return lines.join('\n')
}

/**
 * Directory of the running / on-disk `@deepseek-ai/dsh` package, or null.
 * `argv1` is injected in tests; production uses `process.argv[1]` (the dsh bin).
 */
export function locateDshPackageDir(argv1 = process.argv[1], options = {}) {
  if (typeof argv1 === 'string' && argv1.length > 0) {
    let dir = dirname(argv1)
    for (let i = 0; i < 8; i += 1) {
      const pkg = readJson(join(dir, 'package.json'))
      if (pkg?.name === '@deepseek-ai/dsh') return dir
      const nested = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
      if (readJson(join(nested, 'package.json'))?.name === '@deepseek-ai/dsh') return nested
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  if (options.fallbackFlat === false) return null
  const flat = join(profilesRoot(), 'node_modules', '@deepseek-ai', 'dsh')
  if (readJson(join(flat, 'package.json'))?.name === '@deepseek-ai/dsh') return flat
  return null
}

/** Package root of a host specifier resolved from a dsh install, or null. */
export function resolveHostPackageDir(dshDir, specifier) {
  if (typeof dshDir !== 'string' || dshDir === '') return null
  try {
    const req = createRequire(join(dshDir, 'package.json'))
    const entry = req.resolve(specifier)
    let dir = dirname(entry)
    for (let i = 0; i < 8; i += 1) {
      if (readJson(join(dir, 'package.json'))?.name === specifier) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* not installed next to this dsh */ }
  return null
}

/**
 * Third-party plugins that are actually on disk, keyed by package name.
 * Linked/file rows keep their checkout path; npm/github rows use the profile
 * node_modules install.
 */
export function pluginScanTargets(profileScans, io = {}) {
  const dirOf = io.profileDir ?? profileDir
  const byName = new Map()
  for (const scan of profileScans ?? []) {
    for (const row of scan.plugins ?? []) {
      if (isOfficialPackage(row.name)) continue
      const dir = typeof row.dir === 'string' && row.dir !== ''
        ? row.dir
        : join(dirOf(scan.profile), 'node_modules', row.name)
      if (!existsSync(join(dir, 'package.json'))) continue
      let entry = byName.get(row.name)
      if (entry === undefined) {
        entry = { name: row.name, dir, profiles: [] }
        byName.set(row.name, entry)
      }
      if (!entry.profiles.includes(scan.profile)) entry.profiles.push(scan.profile)
    }
  }
  return [...byName.values()]
}

function uniqueHostSpecifiers(plugins) {
  const specs = []
  const seen = new Set()
  for (const plugin of plugins) {
    for (const row of collectPluginHostImports(plugin.dir)) {
      if (seen.has(row.specifier)) continue
      seen.add(row.specifier)
      specs.push(row.specifier)
    }
  }
  return specs
}

/** Packages that share DSH's own version line (`dsh-settings@0.1.2-alpha.2`). */
function sharesDshRelease(specifier) {
  return specifier === '@deepseek-ai/dsh' || specifier.startsWith('@deepseek-ai/dsh-')
}

async function packExtract(name, version) {
  const dir = mkdtempSync(join(tmpdir(), 'duc-compat-'))
  try {
    const packed = await execText('npm', ['pack', `${name}@${version}`, '--pack-destination', dir], { timeoutMs: 30000, cwd: dir })
    if (packed === null) return null
    const tgzName = packed.split(/\r?\n/).filter(Boolean).at(-1)
    if (typeof tgzName !== 'string' || tgzName === '') return null
    await execText('tar', ['-xzf', join(dir, tgzName), '-C', dir], { timeoutMs: 15000 })
    const pkgDir = join(dir, 'package')
    if (!existsSync(join(pkgDir, 'package.json'))) return null
    const names = readHostExports(pkgDir).names
    return names
  } catch {
    return null
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

async function defaultLoadTargetExports(specifiers, version) {
  const map = {}
  const aligned = specifiers.filter(sharesDshRelease)
  const packed = await Promise.all(aligned.map(async (spec) => {
    const names = await packExtract(spec, version)
    return names === null ? null : [spec, names]
  }))
  for (const row of packed) {
    if (row === null) continue
    map[row[0]] = row[1]
  }
  return map
}

/**
 * Full compat pass for a scan: current on-disk dsh vs third-party plugins,
 * plus the published target dsh when the core row is behind.
 */
export async function gatherCompatForScan({
  profileScans,
  core,
  force = false,
  locateDsh = locateDshPackageDir,
  loadTargetExports = defaultLoadTargetExports,
  profileDir: profileDirFn,
} = {}) {
  const plugins = pluginScanTargets(profileScans, { profileDir: profileDirFn })
  const specifiers = uniqueHostSpecifiers(plugins)
  const dshDir = locateDsh()
  const currentVersion = (dshDir !== null ? readJson(join(dshDir, 'package.json'))?.version : null)
    ?? core?.packages?.[0]?.current
    ?? null
  const currentExports = hostExportsMap(specifiers, (spec) => resolveHostPackageDir(dshDir, spec))
  const coreRow = core?.packages?.[0]
  let targetExports = null
  let targetVersion = null
  if (coreRow?.updateAvailable === true && typeof coreRow.latest === 'string' && coreRow.latest !== '') {
    targetVersion = coreRow.latest
  }
  const cacheKey = `compat:${String(currentVersion)}:${String(targetVersion)}:${plugins.map((p) => p.name).join(',')}`
  const cached = gatherCache.get(cacheKey, force)
  if (cached !== undefined) return cached
  if (targetVersion !== null) {
    try {
      targetExports = await loadTargetExports(specifiers, targetVersion)
    } catch {
      targetExports = null
    }
    if (targetExports !== null && Object.keys(targetExports).length === 0) {
      targetExports = null
    }
  }
  const report = await buildCompatReport({
    plugins,
    currentExports,
    currentVersion,
    targetExports,
    targetVersion,
  })
  gatherCache.set(cacheKey, report)
  return report
}
