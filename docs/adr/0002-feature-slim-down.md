# ADR 0002: Feature slim-down for blind-click users

Date: 2026-09-28
Status: accepted

## Context

The copilot had accumulated two kinds of features:

- **Decision-support surfaces** — briefs with changelog material, risk
  classification, recommendations, dual-mode core target selection, a linked
  dev-channel updater, hot reload, a settings page mirroring the popup.
  These assume a user who reads before clicking.
- **Machine guardrails** — the preflight hard gate (missing named exports),
  the upgrade-card corridor, the session-format storage gate, the empty-husk
  publish gate, core downgrade refusal + version pinning, pre-mutation
  snapshots with rollback, single-flight locking, retry/timeout policy,
  post-flight collateral diffing.

The actual audience is a user who opens the sidebar popup and clicks update.
Nobody reads the highlights; the machine must be the judge.

## Decision

Cut the reading surfaces; keep every guardrail. Concretely (each its own
commit):

1. **Hot reload removed** (reload.js). Every changed update reports
   `requiresRestart: true`; the host restart is already the norm.
2. **The `link:` developer channel removed.** Linked/file: checkouts are
   listed with a "manage it in its own checkout" note and never probed or
   updated; the link→remote switch is gone. `rollbackTargetOf` keeps a
   link:/file: guard returning null — falling through to the npm branch would
   silently migrate the dependency off the local link.
3. **The update-highlights surface removed** (brief tool, /brief route,
   BriefPanel UI, risk/semver classification). advise.js slims to
   `collectBreakingSignals`: the changelog material is still fetched, because
   the preflight gate consumes breaking-change markers as warnings.
4. **Core update collapsed to a single target** — the newest healthy
   published version. Dist-tag mode (mode/tag parameters, chip UI) is gone;
   an explicit `target` version remains for rollback, and a resolved
   downgrade still requires force.
5. **UI collapsed to the sidebar trigger + popup.** The settings section,
   nav icon patch, `?duc=` visual-test hooks, hide-badge and 30-minute
   periodic-refresh preferences, and dsh-market category labels are gone.
   The popup gains the operation log and the auto-update toggle.

## Consequences

- Roughly 1,900 lines of host+client code removed with zero guardrail loss;
  tests went from 276 to 269 cases.
- Breaking-change signals, peer warnings, and gate evidence still reach the
  user — post-decision, on the update result — instead of pre-decision prose.
- Agents get four tools (scan / preflight / update / update-core); the
  preflight tool replaces the brief for "will this break anything?".
- Developer workflows (linked checkouts, dist-tag channels) move out of the
  product: `git pull` in the checkout, `npm install -g @deepseek-ai/dsh@<v>`
  by hand.
