# ADR 0003: Drop the peer-range warning surface

Date: 2026-09-29
Status: accepted

## Context

Since 0.6.x the copilot evaluated every installed plugin's declared
`@deepseek-ai/*` `peerDependencies` against the running (and, when the core
is behind, the upgrade-target) dsh host with prerelease-correct semver, and
surfaced a row badge plus evidence lines:

> `@deepseek-ai/dsh-llm 声明 >=0.1.0-rc.6 <0.2.0 || ^0.1.5-rc.1 || ^0.1.7-rc.2，不包含当前 dsh 0.2.0-rc.1`

The 0.x-prerelease trap the check was built for is real (`^0.1.0-rc.8`
reads fine but excludes `0.1.2-rc.1` under node-semver's same-tuple
prerelease rule), but the warning it produced named no fix:

- A plugin whose declared range excludes the host is broken either way —
  either the harness lets it load anyway (peer warnings are advisory in
  dsh) or the boot fails, and in the failure case the **missing named
  export** hard gate (`gatherTargetBlockers` / the scan's host export
  check) already names the import and ships a copy-pasteable
  `cordis.patch.yml` disable snippet and a remove command.
- The warning was the only remaining consumer of ~200 lines of
  hand-rolled semver range machinery (comparators, unions, prerelease
  tuples) that duplicated node-semver semantics with zero tests against
  real node-semver.
- In practice the message read as noise on rows the user was about to
  update anyway; the actionable signals (blockers, corridor, storage
  boundary, breaking-change markers) were drowned in it.

## Decision

Delete the whole peer-range warning surface (0.12.0), keeping every signal
that names a fix:

1. `lib/preflight.js` drops `peerRangeFindings`,
   `peerWarningsForPackageDir`, `peerWarningsForInstall`,
   `hostVersionsFromCore`, and the semver range engine behind them. The
   module keeps `currentDshVersion` and `breakingFindings`.
2. `lib/scan.js` no longer attaches `peerWarnings` to package rows.
3. `lib/update.js` preflight (`runPreflight` + `evaluatePreflight`)
   drops the peer pass; `runPreflight` warnings now carry only
   breaking-change markers, and the tool items drop the always-empty
   `warnings` field (decision matrix: blockers → blocked, breaking /
   capability → warning, else ok).
4. `lib/cards.js` layer vocabulary loses `peer`; `toLayerFinding` keeps
   link-time / mount-time / run-time / storage / breaking-card.
5. Client (`client/client.js`) drops the peer badge, the
   `PeerWarningDetails` component, the four peer i18n keys, and the
   `rowPeerWarnings` selector; `UpdateWarnings` renders every remaining
   (message-bearing) warning verbatim.
6. Docs: the README feature rows and the `update_copilot_preflight` tool
   description lose the peer-range clause; the breaking-change sentence
   stays with the layered-preflight row.

## Consequences

- ~450 lines of host + client + tests removed (semver engine, findings,
  badge, details, i18n, four test files' worth of peer cases).
- The update-gate decision surface keeps its evidence-shaped findings:
  missing named exports (hard), upgrade-card corridor (hard), session
  format (hard), capability risks and breaking-change markers (warning).
- A peer range that excludes the host no longer pre-warns; if it ever
  breaks a boot, the host-export check and the failure-classification
  layers already report it with an actionable fix.
- Tests went from 269 to 259 cases.
