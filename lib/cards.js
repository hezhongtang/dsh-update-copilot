/**
 * Upgrade-card corridor index + failure-layer classification.
 *
 * The oh-my-dsh upgrade cards are the curated host↔plugin breaking-change
 * knowledge base: one card per real trap, organized as corridor edges
 * (from → to). A path with a missing edge means we do not know what broke
 * in that hop — the same "stop the automatic migration" rule the cards
 * use. This module vendors a compact edge index (offline, zero-dep) and
 * folds preflight findings into the community three-layer signature:
 * link-time / mount-time / run-time, plus storage / peer / breaking-card.
 */

/** Normalize `dsh-v0.1.5-rc.2` / `v0.1.5-rc.2` / `0.1.5-rc.2` → `0.1.5-rc.2`. */
export function normalizeDshVersion(text) {
  if (typeof text !== 'string') return null
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text.trim())
  return m !== null ? m[1] : null
}

const NUM_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseVer(text) {
  const v = normalizeDshVersion(text)
  if (v === null) return null
  const m = NUM_RE.exec(v)
  if (m === null) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] !== undefined ? m[4].split('.') : null,
    raw: v,
  }
}

/** Full semver precedence (release outranks prerelease). */
export function compareDshVersions(a, b) {
  const x = parseVer(a)
  const y = parseVer(b)
  if (x === null || y === null) return null
  if (x.major !== y.major) return x.major - y.major
  if (x.minor !== y.minor) return x.minor - y.minor
  if (x.patch !== y.patch) return x.patch - y.patch
  if (x.pre === null && y.pre === null) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  const len = Math.min(x.pre.length, y.pre.length)
  for (let i = 0; i < len; i += 1) {
    const xi = x.pre[i]
    const yi = y.pre[i]
    const xn = /^\d+$/.test(xi)
    const yn = /^\d+$/.test(yi)
    if (xn && yn) {
      if (Number(xi) !== Number(yi)) return Number(xi) - Number(yi)
    } else if (xn) return -1
    else if (yn) return 1
    else if (xi !== yi) return xi < yi ? -1 : 1
  }
  return x.pre.length - y.pre.length
}

/**
 * Corridor edges derived from oh-my-dsh/dsh-plugin-upgrade-skill card
 * files (one file per from→to hop). `notes` are the high-severity traps
 * already verified in that hop — used for actionLevel and the recipe hint.
 * Versions after `0.1.5-rc.2` intentionally have no edge yet: missing
 * corridor must stop, never be filled from memory.
 */
export const CORRIDOR_EDGES = [
  {
    from: '0.1.1-rc.1', to: '0.1.1-rc.2', cards: 3, idPrefix: 'DSH-0.1.1-R2', status: 'reviewed',
    notes: ['adapter prepareCall contract', 'object-literal LlmAdapter crash'],
  },
  {
    from: '0.1.1-rc.2', to: '0.1.2-alpha.1', cards: 4, idPrefix: 'DSH-0.1.2-A1', status: 'reviewed',
    notes: ['autoInstallPeers tightened', 'BrowserAuth forced 401'],
  },
  {
    from: '0.1.2-alpha.1', to: '0.1.2-alpha.2', cards: 4, idPrefix: 'DSH-0.1.2-A2', status: 'reviewed',
    notes: ['useSession rework'],
  },
  {
    from: '0.1.2-alpha.2', to: '0.1.2-alpha.3', cards: 5, idPrefix: 'DSH-0.1.2-A3', status: 'reviewed',
    notes: ['core bundles no longer auto-injected', 'settingsNamespace type-only'],
  },
  {
    from: '0.1.2-alpha.3', to: '0.1.2-alpha.4', cards: 4, idPrefix: 'DSH-0.1.2-A4', status: 'reviewed',
    notes: ['dsh-code-runtime-python renamed', 'Session.events removed'],
  },
  {
    from: '0.1.2-alpha.4', to: '0.1.2-alpha.5', cards: 3, idPrefix: 'DSH-0.1.2-A5', status: 'reviewed',
    notes: ['tool-subagent-report → send_message'],
  },
  {
    from: '0.1.2-alpha.5', to: '0.1.2-rc.1', cards: 6, idPrefix: 'DSH-0.1.2-R1', status: 'reviewed',
    notes: ['client store/ui-primitives/ui-slots removed', 'registerContinuableSetup removed'],
  },
  {
    from: '0.1.2-rc.1', to: '0.1.3-alpha.1', cards: 4, idPrefix: 'DSH-0.1.3-A1', status: 'reviewed',
    notes: ['subagent/session rework'],
  },
  {
    from: '0.1.3-alpha.1', to: '0.1.3-alpha.2', cards: 3, idPrefix: 'DSH-0.1.3-A2', status: 'reviewed',
    notes: ['runtime verification fixes'],
  },
  {
    from: '0.1.3-alpha.2', to: '0.1.5-alpha.1', cards: 8, idPrefix: 'DSH-0.1.5-A1', status: 'reviewed',
    notes: ['session format V3 (forward-only)', 'dsh-host-apiproxy removed', 'code→ptc rename'],
  },
  {
    from: '0.1.5-alpha.1', to: '0.1.5-alpha.2', cards: 5, idPrefix: 'DSH-0.1.5-A2', status: 'reviewed',
    notes: ['upload/attachment handling'],
  },
  {
    from: '0.1.5-alpha.2', to: '0.1.5-rc.1', cards: 6, idPrefix: 'DSH-0.1.5-R1', status: 'reviewed',
    notes: ['0.1.5 rc consolidation'],
  },
  {
    from: '0.1.5-rc.1', to: '0.1.5-rc.2', cards: 2, idPrefix: 'DSH-0.1.5-R2', status: 'reviewed',
    notes: ['UI polish only'],
  },
  // Documented host breaking points without a published card edge yet.
  {
    from: '0.1.5-rc.2', to: '0.1.6-alpha.1', cards: 0, idPrefix: null, status: 'gap',
    notes: ['ptc-runtime rename', 'agent/created replaces session-start', 'E2B removed', 'Messages API default'],
  },
  {
    from: '0.1.6-alpha.1', to: '0.1.6-alpha.2', cards: 0, idPrefix: null, status: 'gap',
    notes: [],
  },
  {
    from: '0.1.5-rc.2', to: '0.1.5-rc.3', cards: 0, idPrefix: null, status: 'gap',
    notes: [],
  },
  {
    from: '0.1.6-alpha.2', to: '0.1.7-alpha.1', cards: 0, idPrefix: null, status: 'gap',
    notes: ['Session log V4', 'readBytes unifies workspace reads', 'settings.yaml one-shot import'],
  },
]

/** Session log format family per host line (storage gate). */
export const SESSION_FORMAT_BY_VERSION = [
  { atLeast: '0.1.7-alpha.1', sessionFormat: 'v4', projcacheVersion: null },
  { atLeast: '0.1.5-alpha.1', sessionFormat: 'v3', projcacheVersion: 3 },
  { atLeast: '0.0.1-rc.1', sessionFormat: 'v2', projcacheVersion: 2 },
]

export function sessionFormatOf(version) {
  const v = parseVer(version)
  if (v === null) return null
  for (const row of SESSION_FORMAT_BY_VERSION) {
    const cmp = compareDshVersions(v.raw, row.atLeast)
    if (cmp !== null && cmp >= 0) return row
  }
  return null
}

/**
 * Walk the corridor from `from` to `to`. Hops are the known from→to edges
 * that overlap the interval (from, to]. A path is open only when those hops
 * cover the interval without holes and every hop is `reviewed` with cards;
 * a `gap` hop, an uncovered prefix/suffix, or a target past the last
 * reviewed node sets `missingEdge` (caller must block).
 */
export function corridorFindings(from, to) {
  const a = normalizeDshVersion(from)
  const b = normalizeDshVersion(to)
  if (a === null || b === null) {
    return { from: a, to: b, edges: [], missingEdge: true, cards: [], notes: [], reason: 'unparsable version' }
  }
  const cmp = compareDshVersions(a, b)
  if (cmp === 0) {
    return { from: a, to: b, edges: [], missingEdge: false, cards: [], notes: [], reason: 'same version' }
  }
  if (cmp !== null && cmp > 0) {
    // Downgrade / rollback: corridor cards are upgrade-oriented; never block recovery.
    return { from: a, to: b, edges: [], missingEdge: false, cards: [], notes: [], reason: 'downgrade — corridor not applied', direction: 'down' }
  }

  const lastReviewed = CORRIDOR_EDGES
    .filter((e) => e.status === 'reviewed' && e.cards > 0)
    .map((e) => e.to)
    .sort((x, y) => compareDshVersions(x, y))
    .pop()
  if (lastReviewed !== undefined && compareDshVersions(b, lastReviewed) > 0) {
    return {
      from: a,
      to: b,
      edges: [],
      missingEdge: true,
      cards: [],
      notes: [],
      reason: `target ${b} is past the last curated card hop (${lastReviewed}) — missing corridor edge`,
    }
  }

  // Hops that overlap the move: they end after `a` and start before `b`.
  const covering = CORRIDOR_EDGES
    .filter((e) => compareDshVersions(e.to, a) > 0 && compareDshVersions(e.from, b) < 0)
    .sort((x, y) => compareDshVersions(x.from, y.from) ?? 0)
  if (covering.length === 0) {
    return {
      from: a,
      to: b,
      edges: [],
      missingEdge: true,
      cards: [],
      notes: [],
      reason: `no corridor hop overlaps ${a} → ${b}`,
    }
  }
  // Uncovered prefix: the first hop must start at or before `a` (or its
  // predecessor already ends at `a`). An edge that merely starts after `a`
  // leaves (a, first.from) unknown.
  const first = covering[0]
  const prefixOpen = compareDshVersions(first.from, a) > 0
  // Contiguity + suffix: each hop must reach the next, and the last must reach `b`.
  const edges = []
  let cursor = a
  for (const edge of covering) {
    if (compareDshVersions(edge.from, cursor) > 0) {
      return {
        from: a,
        to: b,
        edges,
        missingEdge: true,
        cards: edges.filter((e) => e.idPrefix !== null).map((e) => e.idPrefix),
        notes: edges.flatMap((e) => e.notes),
        reason: `missing corridor edge ${cursor} → ${edge.from}`,
      }
    }
    edges.push(edge)
    if (compareDshVersions(edge.to, cursor) > 0) cursor = edge.to
    if (compareDshVersions(cursor, b) >= 0) break
  }
  const suffixOpen = compareDshVersions(cursor, b) < 0
  if (prefixOpen || suffixOpen) {
    return {
      from: a,
      to: b,
      edges,
      missingEdge: true,
      cards: edges.filter((e) => e.idPrefix !== null).map((e) => e.idPrefix),
      notes: edges.flatMap((e) => e.notes),
      reason: prefixOpen
        ? `missing corridor edge ${a} → ${first.from}`
        : `missing corridor edge ${cursor} → ${b}`,
    }
  }
  const missingEdge = edges.some((e) => e.status !== 'reviewed' || e.cards === 0)
  return {
    from: a,
    to: b,
    edges,
    missingEdge,
    cards: missingEdge ? [] : edges.filter((e) => e.idPrefix !== null).map((e) => e.idPrefix),
    notes: edges.flatMap((e) => e.notes),
    reason: missingEdge
      ? `corridor path ${a} → ${b} contains unreviewed hop(s)`
      : `corridor path ${a} → ${b} (${edges.length} edge(s))`,
  }
}

/**
 * Known run-time / link-time host API traps that static named-import diff
 * cannot see (methods that vanished from an object, not from exports).
 * Heuristic: a hit is a warning with a fix hint, never a hard block.
 */
export const HOST_API_RISKS = [
  {
    id: 'prepareCall',
    re: /\bprepareCall\b/,
    layer: 'run-time',
    actionLevel: 'required-if-hit',
    subject: 'adapter.prepareCall',
    fix: 'inherit the host LlmAdapter base class via peerDependency; probe typeof LlmAdapter.prototype.prepareCall — do not ship a plain object adapter',
  },
  {
    id: 'registerContinuableSetup',
    re: /registerContinuableSetup/,
    layer: 'run-time',
    actionLevel: 'required-if-hit',
    subject: 'ctx.subagents.registerContinuableSetup',
    fix: 'API removed in 0.1.2-rc.1 — branch on typeof ctx.subagents.registerContinuableSetup === "function" or drop the call',
  },
  {
    id: 'sessionProjectionCache',
    re: /sessionProjectionCache/,
    layer: 'run-time',
    actionLevel: 'required-if-hit',
    subject: 'sessionProjectionCache.hydratePrepared',
    fix: 'alpha hosts require hydratePrepared — probe the method before use',
  },
  {
    id: 'Session.events',
    re: /Session\.events\b|\.events\.length\b/,
    layer: 'run-time',
    actionLevel: 'required-if-hit',
    subject: 'Session.events',
    fix: 'removed in 0.1.2-alpha.4 — use seq / eventAt() / snapshotEvents() / ownEvents()',
  },
  {
    id: 'installSettingsSection',
    re: /installSettingsSection/,
    layer: 'link-time',
    actionLevel: 'required-if-hit',
    subject: 'installSettingsSection',
    fix: 'removed from @deepseek-ai/dsh-settings — migrate to SettingsForms / settings plugin APIs',
  },
  {
    id: 'settingsNamespace-value',
    re: /import\s*\{[^}]*\bsettingsNamespace\b[^}]*\}\s*from\s*['"]@deepseek-ai\/dsh-settings['"]/,
    layer: 'link-time',
    actionLevel: 'required-if-hit',
    subject: 'settingsNamespace (value import)',
    fix: 'now type-only — import type { SettingsNamespace } or use SettingsForms',
  },
  {
    id: 'tool-subagent-report',
    re: /tool-subagent-report|toolSubagentReport/,
    layer: 'mount-time',
    actionLevel: 'required-if-hit',
    subject: 'tool-subagent-report',
    fix: 'renamed to send_message in 0.1.2-alpha.5',
  },
  {
    id: 'dsh-code-runtime-python',
    re: /@deepseek-ai\/dsh-code-runtime-python/,
    layer: 'mount-time',
    actionLevel: 'required-if-hit',
    subject: '@deepseek-ai/dsh-code-runtime-python',
    fix: 'renamed to @deepseek-ai/dsh-experimental-code-runtime-python',
  },
  {
    id: 'dsh-client-store',
    re: /@deepseek-ai\/dsh-client-store|@deepseek-ai\/dsh-client-ui-primitives|@deepseek-ai\/dsh-client-ui-slots/,
    layer: 'link-time',
    actionLevel: 'required-if-hit',
    subject: 'removed client packages',
    fix: 'dsh-client-store / ui-primitives / ui-slots were removed at 0.1.2-rc.1 — drop the require and use current client inject packages',
  },
  {
    id: 'old-workspace-read',
    re: /\breadFile(?:Sync)?\s*\(/,
    layer: 'run-time',
    actionLevel: 'informational',
    subject: 'workspace file read',
    fix: '0.1.7-alpha.1 unifies workspace reads on readBytes — migrate when targeting that line',
  },
]

/**
 * Heuristic capability / API-contract risks in plugin source text.
 * @param {string} source
 * @returns {Array<object>}
 */
export function capabilityFindings(source) {
  const text = typeof source === 'string' ? source : ''
  const out = []
  for (const risk of HOST_API_RISKS) {
    if (!risk.re.test(text)) continue
    out.push({
      type: 'capability',
      layer: risk.layer,
      actionLevel: risk.actionLevel,
      subject: risk.subject,
      id: risk.id,
      fix: risk.fix,
      message: `${risk.subject}: ${risk.fix}`,
    })
  }
  return out
}

/** stderr / loader signatures → layer (grunmin acp-doctor mapping). */
export function classifyFailureSignature(text) {
  const s = typeof text === 'string' ? text : ''
  if (/does not provide an export named|SyntaxError: The requested module|ERR_MODULE_NOT_FOUND/.test(s)) {
    return { layer: 'link-time', subject: 'module link', fix: 'plugin imports a name/package the host closure no longer provides — update or disable the plugin' }
  }
  if (/duplicate loader entry id|failed to apply loader entry|in the Host scope|cannot resolve profile bundle/.test(s)) {
    return { layer: 'mount-time', subject: 'loader entry', fix: 'fix cordis.patch.yml / dsh.profile.bundles (stale or duplicate id) and reinstall' }
  }
  if (/is not a function/.test(s)) {
    return { layer: 'run-time', subject: 'host API method', fix: 'probe the capability (typeof … === "function") and migrate off the removed method' }
  }
  if (/has no Session format codec|session format/i.test(s)) {
    return { layer: 'storage', subject: 'session format', fix: 'forward-only session migration — restore a snapshot before downgrading the host' }
  }
  return { layer: 'unknown', subject: 'unclassified', fix: 'see output; classify manually' }
}

/**
 * Tag a raw preflight finding with the shared layer vocabulary and keep
 * a `layerFindings` row shape used by evaluatePreflight.
 */
export function toLayerFinding(row) {
  const layer = row.layer ?? row.type ?? 'unknown'
  return {
    layer,
    subject: row.subject ?? row.specifier ?? row.source ?? 'finding',
    actionLevel: row.actionLevel
      ?? (layer === 'link-time' || layer === 'storage' || row.against === 'target' && row.missing
        ? 'required'
        : layer === 'peer' || layer === 'breaking' || layer === 'breaking-card'
          ? 'conditional'
          : 'informational'),
    ...(row.cards !== undefined ? { cards: row.cards } : {}),
    ...(row.touchpoints !== undefined ? { touchpoints: row.touchpoints } : {}),
    evidence: row.evidence ?? row.message ?? row.line ?? '',
    fix: row.fix ?? row.disablePatch ?? '',
    raw: row,
  }
}

/** Collapse preflight parts into one layerFindings list (stable order). */
export function buildLayerFindings({ blockers = [], warnings = [], breaking = [], corridor = null, storage = null, capability = [] } = {}) {
  const rows = []
  for (const b of blockers) {
    rows.push(toLayerFinding({
      ...b,
      layer: 'link-time',
      subject: `${b.specifier ?? 'host'} missing ${Array.isArray(b.missing) ? b.missing.join(', ') : ''}`.trim(),
      actionLevel: 'required',
      evidence: b.message ?? `missing named export(s): ${Array.isArray(b.missing) ? b.missing.join(', ') : ''}`,
      fix: b.disablePatch ?? 'disable the plugin or wait for a plugin release that drops the import',
    }))
  }
  for (const w of warnings) {
    const layer = w.type === 'peer' ? 'peer' : w.type === 'breaking' ? 'breaking' : w.type === 'capability' ? (w.layer ?? 'run-time') : (w.layer ?? 'warning')
    rows.push(toLayerFinding({ ...w, layer, actionLevel: w.actionLevel ?? 'conditional' }))
  }
  for (const b of breaking) {
    rows.push(toLayerFinding({ ...b, layer: 'breaking', actionLevel: 'informational', subject: b.source ?? 'release note' }))
  }
  if (corridor !== null && corridor.missingEdge === true) {
    rows.push(toLayerFinding({
      layer: 'breaking-card',
      subject: `corridor ${corridor.from} → ${corridor.to}`,
      actionLevel: 'required',
      evidence: corridor.reason ?? 'missing curated upgrade-card edge',
      fix: 'stop the automatic upgrade — read oh-my-dsh cards / release notes for this hop, or stay on the current host line',
      cards: [],
    }))
  } else if (corridor !== null && Array.isArray(corridor.notes) && corridor.notes.length > 0) {
    for (const note of corridor.notes) {
      rows.push(toLayerFinding({
        layer: 'breaking-card',
        subject: note,
        actionLevel: 'conditional',
        evidence: corridor.reason ?? '',
        fix: 'apply the matching oh-my-dsh migration recipe before/after the host move',
        cards: corridor.cards,
      }))
    }
  }
  if (storage !== null && storage.compatible === false) {
    rows.push(toLayerFinding({
      layer: 'storage',
      subject: `session format ${storage.current ?? '?'} → ${storage.target ?? '?'}`,
      actionLevel: 'required',
      evidence: storage.reason ?? 'session format jump',
      fix: 'snapshot $DSH_HOME first — session logs migrate forward only and old builds cannot read new formats',
    }))
  }
  for (const c of capability) {
    rows.push(toLayerFinding({ ...c, layer: c.layer ?? 'run-time' }))
  }
  return rows
}
