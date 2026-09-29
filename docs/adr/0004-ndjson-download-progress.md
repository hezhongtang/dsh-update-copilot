# ADR 0004: Real download progress via pnpm's NDJSON reporter

Date: 2026-09-29
Status: accepted

## Context

The update panel has always streamed progress events, but the numbers
behind them were nearly empty. `dsh plugin --profile <p> add <target>`
forwards to pnpm, and pnpm's default non-TTY reporter emits only a
handful of coarse lines per install:

```
Progress: resolved 1, reused 0, downloaded 0, added 0
Progress: resolved 7, reused 0, downloaded 6, added 0
Packages: +8
++++++++
Progress: resolved 8, reused 0, downloaded 8, added 8, done
```

For a fresh 66-package install that is ~4 lines: resolution, one fetch
snapshot, one link snapshot, done. Between the second and fourth lines
the entire download happens silently — the panel showed an indeterminate
6px bar or a percentage that jumped 27/28 → 64/66 → 66/66. Users read
that as "模糊": no byte counts, no speed, no ETA, and a bar that mostly
stood still. The old `| 42%` regex never matched anything non-TTY pnpm
actually prints.

## Decision

Run the plugin-update child with pnpm's NDJSON reporter
(`dsh plugin --profile <p> add <target> --reporter=ndjson`), validated
against the real toolchain: it is the only non-TTY output carrying
byte-level progress. `lib/progress.js` (new) turns the event stream into
normalized `progress` events; the panel renders a determinate download
bar. (0.13.0)

- **Tracker** (`NdjsonProgressTracker`): accumulates
  `pnpm:fetching-progress` (`started` size + `in_progress` downloaded
  bytes), `pnpm:progress` stage transitions (resolved / found_in_store /
  fetched / imported) and `pnpm:stage` boundaries. Percent policy per
  phase with the numbers that are really known: bytes during downloads,
  imported-over-resolved while linking, null (indeterminate) during
  resolution — the total is genuinely unknown until resolution ends —
  and 100 at done. Emitted percent never decreases (newly started
  packages grow the known total and would rewind the bar); events are
  throttled to ~8/s per run with phase transitions always surfacing.
- **Output reconstruction** (`ndjsonLineToText`): error and warn events
  become readable `pnpm: <code> <message>` lines in the captured output
  (so the deterministic-failure classification keeps matching
  `ERR_PNPM_*` / `E404` / auth codes and the failure tail stays
  diagnosable); all other ndjson events are dropped as progress noise;
  non-JSON lines (dsh's own messages, lifecycle-script output) pass
  through unchanged. Verified end-to-end: a nonexistent-version update
  still fails fast with `ERR_PNPM_NO_MATCHING_VERSION` and one
  retry-free attempt.
- **Text fallback** (`parseProgressLine`): pnpm's coarse `Progress:`
  counters with pnpm's own semantics (resolved = denominator, added =
  numerator) plus npm's final `added N packages` summary, used by the
  core path and any seat whose pnpm predates the flag. npm has no
  non-TTY progress at all — the core bar stays indeterminate until its
  summary, which is honest.
- **UI**: a solid 8px determinate fill on a solid track (no translucent
  gradient washing out), a striped sliding indeterminate fill, and a
  detail line with counters (`8.4 MB / 9.3 MB`, `8/13 个包`), measured
  speed and ETA computed client-side from the server-stamped event
  times. `role="progressbar"` with `aria-valuenow` / `aria-valuetext`.
- The wire event shape stays a superset of the legacy
  `{ percent, phase }` (plus done/total/unit/package/at); older clients
  ignore the new fields.

## Consequences

- Plugin updates now show real byte progress with speed and ETA; the
  download phase is no longer a waiting room. Resolution and linking
  show honest package counts; unknowable phases animate instead of
  lying.
- The captured output tail on success is empty (all noise was events) —
  failures carry the reconstructed `pnpm:` lines plus dsh's own
  stderr, which is strictly more readable than the old tail.
- The spawned command gains one pnpm flag. Risk accepted: `--reporter`
  has existed in pnpm for years and a failure here degrades to the
  text fallback (which parses nothing new but never throws). Core
  (npm) updates are untouched.
- `lib/progress.js` is pure and unit-tested; 19 new tests
  (host tracker + reconstructor + client render model).
