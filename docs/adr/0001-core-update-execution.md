# ADR-0001: The DSH core update is executed by the copilot — gated, dual-mode, global-npm-only

- Status: accepted
- Date: 2026-09-28
- Supersedes: the previous `core-report-only` policy (the radar surfaced a copyable
  `npm install -g @deepseek-ai/dsh@<version>` command but never ran it)

## Context

The copilot runs inside the dsh host process, and the harness itself updates fast
(24 releases between 2026-08-10 and 2026-09-22, dual rc/alpha lines, no `dsh update`
subcommand — see `research/dsh-plugin-compat/REPORT.md` §1.2). Keeping the core on a
manual copy-paste loop meant the copilot could *advise* on a harness upgrade with
full evidence (compat scan, corridor cards, storage boundaries) but not complete the
action it had just vetted. Two constraints shaped the old report-only stance:

1. **Self-update risk.** `npm install -g` replaces the files of the running process.
   Node loads modules lazily, so a mid-flight require could mix old and new code.
2. **Install diversity.** The official zero-install entry is `npx @deepseek-ai/dsh web`;
   an npx launch has no global install to replace — executing `npm install -g` there
   would create a parallel install nobody runs.

Meanwhile the ecosystem made naive execution dangerous on its own: dist-tags lag
systemically (`dsh-base`'s `latest` sat on an empty 0.0.1-rc.1 husk while `next` and
`alpha` carried the real line), so `@latest` can resolve to a *downgrade* of the
installed version.

## Decision

The copilot **executes the core update** through `updateCore` (lib/update.js), behind
four gates, in this order — each refusal happens before any process is spawned:

1. **Target resolution is always a concrete pinned version.** `pinned` mode installs
   the newest *healthy* published version (the radar's own line — empty-husk versions
   are skipped, exactly like plugin updates). `tag` mode (latest / next / alpha)
   resolves the tag to its concrete version first; the executed command pins that
   version, never the tag. A resolved **downgrade is refused without `force`** — the
   systemic tag lag means "update to latest" can silently mean "downgrade".
2. **Install shape must be a writable global npm install** (`lib/core-install.js`:
   the running package dir traced and classified against `npm prefix -g` / the npx
   cache). npx and untraceable launches keep report-only behavior and get the manual
   command back; a root-owned prefix (would need sudo) is reported, not attempted.
3. **The full compatibility gate** — the same evidence vocabulary as the plugin gate:
   upgrade-card corridor (a hop without curated cards stops the move), session-format
   storage boundary, and per-plugin missing-export evidence across **every** profile.
   `force: true` overrides after explicit approval; the evidence stays on the outcome.
4. **Restart is always required.** There is no hot reload for the host itself: the
   running process keeps the old version until dsh is restarted, and every changed
   outcome reports `requiresRestart: true` plus a rollback command (reinstall of the
   before-version). We never claim the running session was updated.

Execution itself reuses the shared executor machinery: single-flight lock (core and
plugin updates serialize), SSE progress bus, 5-minute timeout, up to 3 attempts with
jittered backoff, fatal-signature fail-fast, and a no-retry guard when a failed
attempt already moved the on-disk version.

Surfaces: `POST /dsh-update-copilot/update-core` (same-origin + `confirm: true`,
same SSE contract as `/update`), the agent tool `update_copilot_core`, and the core
card's dual-mode UI (mode chips with resolved versions and downgrade warnings,
two-step confirmed **Update core** button, force-on-blocked and rollback affordances).

## Consequences

- The core card becomes actionable for global npm installs; every other install
  shape is unchanged (copy the command).
- `@latest`-style blind updates remain impossible by construction: the UI shows what
  a tag resolves to *now* and colors it as an upgrade/downgrade/same before confirm.
- The autopilot ("Update all", auto-update on sidebar click) never includes the core.
- Rollback for the core is the simplest of all channels: reinstall the before-version
  (also surfaced as a copyable command).
- Risk we accept: a forced gate override can break profiles on boot — same accepted
  risk as the plugin force path, and the CLI (`node …/lib/cli.js`) still works when
  DSH will not start.
