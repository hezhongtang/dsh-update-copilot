# dsh-update-copilot

[![License: MIT](https://img.shields.io/badge/license-MIT-0B7285?style=flat-square)](LICENSE)
[![DSH core](https://img.shields.io/badge/DSH-%3E%3D%200.1.0--rc.7-5B4CF0?style=flat-square)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![Zero build](https://img.shields.io/badge/zero--build-no%20bundler-2EA44F?style=flat-square)](lib)
[![GitHub stars](https://img.shields.io/github/stars/hezhongtang/dsh-update-copilot?style=flat-square&logo=github)](https://github.com/hezhongtang/dsh-update-copilot/stargazers)

**An update copilot for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh): tracks the dsh core, shipped bundles, and every installed plugin — merged package-centric across all profiles, with one-click updates for eligible independently owned installs.**

<p align="center">
  <img src="assets/popup.png" width="480" alt="The Update Copilot popup: core packages, per-plugin rows behind-first, up-to-date rows folded away." />
</p>

English | [中文](README.zh.md)

## Why this exists

DSH moves fast, and so does its plugin ecosystem. Every profile installs plugins through pnpm specs — npm versions, GitHub commit pins, local `link:` checkouts — and each channel drifts out of date in its own way. Checking them by hand means walking every repo; auto-updating everything blindly means trusting third-party code with your environment.

This plugin takes the middle path: **detect everything, summarize what changed, update only what you trigger.** Updates are one click — no confirmation ceremony between you and the button — and target only the eligible profiles shown for that package. The DSH core is deliberately *report-only* — upgrading the harness restarts every session, so that decision stays with a human.

## Features

| | |
|---|---|
| 🔭 **Full radar** | dsh core + shipped bundles (`dsh-base`, `dsh-web-app`) + every profile's plugin dependencies, in one scan |
| 🔄 **Dual channel** | npm registry versions (full semver compare, prerelease-aware) and git upstreams (pinned-commit vs HEAD, `link:` checkouts via read-only `ls-remote`) |
| 🧭 **Update highlights** | Per-item: semver distance, risk level (major → high, minor → medium, patch → low), changelog material — npm versions between yours and latest, GitHub compare commits, release notes (with their body rendered inline), or local `git log`; every artifact links out (npm version pages, commits, releases, compare views) and every row carries a ↗ to its repository — monorepo sub-packages link to their subdirectory, npm plugins without a resolvable GitHub repository fall back to their npm package page |
| 🤖 **Agent tools** | `update_copilot_scan` / `update_copilot_brief` / `update_copilot_update` — ask your agent *"any updates?"* and get an honest, data-backed answer. Scans are package-centric (one row per package, merged across profiles); inferred mount relationships are presentation-only, while official packages are report-only and each direct dependency keeps its own update policy |
| 🖥 **Web surfaces** | On Web hosts, a sidebar trigger beside Settings hydrates its badge on mount and retries after the startup scan; background scans run at startup and every 30 minutes. The compact popup shows behind rows first and folds up-to-date rows; inferred mount relationships stay with their parent in the same behind or up-to-date section. The full page lives in Settings → Update Copilot. Plugins merge into one package row with per-profile versions; mounted packages expand beneath their parent for disclosure while retaining independent ownership and update actions. A child **Update** targets only that child, a parent **Update** targets only the parent, and **Update bundle** updates the parent first then independently updateable displayed mounted children sequentially with progress and results. Global **Update all** remains a separate action. Updates stream live progress over SSE (resolving / downloading / retrying / stash / pull / restore phases) straight into a per-row progress bar |
| 🛡 **Update guardrails** | Same-origin POST + explicit `confirm`, strict target allowlist, single-flight lock, 5-minute timeout; npm/github specs run only through the official `dsh plugin` CLI, `link:` checkouts update via git pull in their own directory (auto-stash → pull → restore; conflicts are always handed back for manual handling), while `file:` installs and official `@deepseek-ai/*` packages remain refused |
| 🌐 **Fully bilingual** | Every user-facing string — panel, popup, badges, update highlights, recommendations, update errors — follows the UI language (zh/en); the agent tool path keeps stable English identifiers |

## Install

```sh
# from npm (recommended)
dsh plugin --profile web add dsh-update-copilot

# or straight from the GitHub repo
dsh plugin --profile web add github:hezhongtang/dsh-update-copilot
```

Restart `dsh web`, then open **Settings → Update Copilot**. Works the same in any other profile (`--profile <name>`).

## Usage

### Ask your agent

> "check for updates"

The agent runs `update_copilot_scan`, then builds a brief for each outdated item and presents the risk before doing anything. Updates run only after you say yes — the update tool rejects calls without `confirm: true`.

### Or use the popup / panel

The **sidebar button beside Settings** opens the compact radar popup (ESC or backdrop click closes; `?duc=1` in the URL opens it once — handy for screenshots and tests). **Settings → Update Copilot** is the full page: core status (with a copyable upgrade command — never executed), every installed plugin merged across profiles into one row per package (each profile's current → latest listed inline), expandable mount relationships, inline update highlights, and a **one-click Update** button per row. A child row's **Update** affects only that child; a parent row's normal **Update** affects only that parent. **Update bundle** runs the parent first, then each independently updateable displayed mounted child in sequence and reports progress/results. Each package carries explicit eligible profiles, so it never updates every same-named install blindly. The toolbar **Update all** remains the separate global action for eligible outdated packages. Live SSE progress drives a per-row progress bar. After an update, a plugin in the running profile is **hot-reloaded in place** when its entry and bundle patch are unchanged; the restart banner is only shown for updates outside the phase-1 hot-reload scope (bundle-patch changes, non-current profiles, self-update, etc.).

### Agent tool reference

| Tool | Read/Write | Purpose |
|---|---|---|
| `update_copilot_scan` | read | Full scan across core + all profiles, merged package-centric (10-min cache, `force` to bypass) |
| `update_copilot_brief` | read | Semver distance, risk, changelog material, recommendation for one package; optional `profile` restricts the brief to one profile, otherwise every profile that has the package contributes |
| `update_copilot_update` | write | Execute one **confirmed** update — without a `profile`, across eligible independently owned installs only; npm/github specs through the official `dsh plugin` CLI (failed/timeout attempts retry automatically — 3 total, 1s/3s backoff); `link:` checkouts stay local and update via git pull inside their own directory (auto-stash → pull → restore, conflicts handed back for manual handling), or with `source: "remote"` switch the dependency to the published npm version (or a `github:` spec when the package is not on npm) — breaking the local link |

## How it works

Every dependency spec is classified into a channel, and each channel has its own comparison. Scans merge the profiles' plugin lists package-centric: the same package installed in `web`, `headless`, and `desktop` appears once, carrying each profile's channel and versions. An active profile bundle whose contained patch mounts at least two production dependencies exposes presentation-only mount relationships; overlapping parents choose the largest verified child set, then package name. Mounting does not transfer update ownership: each direct dependency keeps its own update policy. Local `link:` and `file:` dependencies stay local, and official `@deepseek-ai/*` packages remain report-only.

| Channel | Example spec | Current | Latest |
|---|---|---|---|
| npm | `^0.1.4` | installed `package.json` version | newest version in the full registry doc |
| github | `github:owner/repo#sha` | pinned commit in `pnpm-lock.yaml` | upstream HEAD via GitHub API |
| linked | `link:../my-plugin` | local `git rev-parse HEAD` | `git ls-remote origin HEAD` (read-only) |

The npm channel deliberately ignores the `latest` dist-tag: monorepo sub-packages often leave that tag stale, which false-flags installs that are actually *newer* than the tag. Versions are compared with full semver precedence (prereleases included), so `0.1.0-rc.6 > 0.1.0-rc.5` and `1.0.0 > 1.0.0-rc.1` both hold.

Updates execute through two vetted paths, never a raw shell string: npm/github specs run `dsh plugin --profile <p> add <target>` — the same path a human would type — with the target string validated against an allowlist; `link:` checkouts stay local and run git directly in their directory (`git stash push` for local changes → `git pull` → `git stash pop` to restore them). Failed or timed-out pulls are retried automatically: 3 total attempts by default, with 1s/3s backoff; merge conflicts or failed restores are never auto-resolved — the result reports `attempts`, a `stash` summary, and the last output. Child, parent, and bundle actions preserve the package row's explicit eligible profiles; global Update all remains separate and never updates every same-named dependency blindly.

A `link:` checkout can also be **switched to a remote source**: the copilot replaces the dependency spec with the newest published npm version (npm registry first), or with `github:owner/repo#<origin HEAD>` when the package has no npm release. The local link breaks and future updates follow the normal npm/github channel. Switching is destructive, so it always requires explicit confirmation and is never part of the default pull path.

## Security

- The only mutating route is `POST /dsh-update-copilot/update`: same-origin and same-transport-scheme checks are enforced, with `confirm: true` required; forwarded scheme headers are not trusted. TLS-terminating proxies may set `DSH_UPDATE_COPILOT_PUBLIC_ORIGIN` to their public HTTP(S) origin; requests must match it exactly, and an invalid value fails closed.
- Official `@deepseek-ai/*` packages and the dsh core are never auto-updated; the core's upgrade command is displayed, not run.
- All upstream queries are read-only (`registry.npmjs.org`, `api.github.com`, `git ls-remote`) with hard timeouts; a failed check degrades that one item instead of failing the scan.

## Limitations

- Plugin hot reload is phase-1 scoped: it covers updates whose running profile entry still exists and whose new version keeps the same `dsh.bundle.patch` and `dsh.client` declaration (this includes `link:` checkouts — node_modules points at the checkout through a symlink, so the pull takes effect on the same files the reloader reads). Bundle-patch changes, non-current profiles, and copilot self-update still ask for a `dsh` restart.
- `link:` updates require the checkout to have an upstream branch configured; uncommitted changes are auto-stashed and restored after the pull, and a failed restore (stash pop conflict) needs manual `git stash list` / `git stash pop`.
- Switching a `link:` to a remote source breaks the local link and there is no automatic switch back (the spec must be edited by hand). The npm-first strategy installs the registry version, which may differ from your local development checkout.
- Unauthenticated GitHub API is rate-limited (60 req/h) — briefs degrade gracefully to version lists.
- Raw `git+https://` specs are reported as-is without a comparison channel.

## Contributing

Issues and PRs welcome at [hezhongtang/dsh-update-copilot](https://github.com/hezhongtang/dsh-update-copilot). The codebase is intentionally small and dependency-free — plain ESM on the host, a hand-authored CJS bundle in the browser, no build step to set up.

## License

[MIT](LICENSE) © 2026 hezhongtang
