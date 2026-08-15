# dsh-update-copilot

[![License: MIT](https://img.shields.io/badge/license-MIT-0B7285?style=flat-square)](LICENSE)
[![DSH core](https://img.shields.io/badge/DSH-%3E%3D%200.1.0--rc.6-5B4CF0?style=flat-square)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![Zero build](https://img.shields.io/badge/zero--build-no%20bundler-2EA44F?style=flat-square)](lib)
[![GitHub stars](https://img.shields.io/github/stars/hezhongtang/dsh-update-copilot?style=flat-square&logo=github)](https://github.com/hezhongtang/dsh-update-copilot/stargazers)

**An update copilot for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh): tracks the dsh core, shipped bundles, and every installed profile plugin — then helps you decide, and only then updates.**

English | [中文](README.zh.md)

## Why this exists

DSH moves fast, and so does its plugin ecosystem. Every profile installs plugins through pnpm specs — npm versions, GitHub commit pins, local `link:` checkouts — and each channel drifts out of date in its own way. Checking them by hand means walking every repo; auto-updating everything blindly means trusting third-party code with your environment.

This plugin takes the middle path: **detect everything, summarize what changed, update only what you confirmed.** The DSH core is deliberately *report-only* — upgrading the harness restarts every session, so that decision stays with a human.

## Features

| | |
|---|---|
| 🔭 **Full radar** | dsh core + shipped bundles (`dsh-base`, `dsh-web-app`) + every profile's plugin dependencies, in one scan |
| 🔄 **Dual channel** | npm registry versions (full semver compare, prerelease-aware) and git upstreams (pinned-commit vs HEAD, `link:` checkouts via read-only `ls-remote`) |
| 🧭 **Decision briefs** | Per-item: semver distance, risk level (major → high, minor → medium, patch → low), changelog material — npm versions between yours and latest, GitHub compare commits, release notes, or local `git log` |
| 🤖 **Agent tools** | `update_copilot_scan` / `update_copilot_brief` / `update_copilot_update` — ask your agent *"any updates?"* and get an honest, data-backed answer |
| 🖥 **Web panel** | Settings → Update Copilot: core card, per-plugin rows, inline briefs, two-step confirm updates |
| 🛡 **Update guardrails** | Same-origin POST + explicit `confirm`, strict target allowlist, single-flight lock, 5-minute timeout; `link:`/`file:` and official `@deepseek-ai/*` installs are refused |

## Install

```sh
dsh plugin --profile web add github:hezhongtang/dsh-update-copilot
```

Restart `dsh web`, then open **Settings → Update Copilot**. Works the same in any other profile (`--profile <name>`).

## Usage

### Ask your agent

> "check for updates"

The agent runs `update_copilot_scan`, then builds a brief for each outdated item and presents the risk before doing anything. Updates run only after you say yes — the update tool rejects calls without `confirm: true`.

### Or use the panel

**Settings → Update Copilot** shows the core status (with a copyable upgrade command — never executed), every profile's plugins with current → latest versions, inline decision briefs, and a two-step confirm button per update. A restart banner reminds you that plugin updates apply after the next `dsh` restart.

### Agent tool reference

| Tool | Read/Write | Purpose |
|---|---|---|
| `update_copilot_scan` | read | Full scan across core + all profiles (10-min cache, `force` to bypass) |
| `update_copilot_brief` | read | Semver distance, risk, changelog material, recommendation for one item |
| `update_copilot_update` | write | Execute one **confirmed** update through the official `dsh plugin` CLI |

## How it works

Each dependency spec is classified into a channel, and each channel has its own comparison:

| Channel | Example spec | Current | Latest |
|---|---|---|---|
| npm | `^0.1.4` | installed `package.json` version | newest version in the full registry doc |
| github | `github:owner/repo#sha` | pinned commit in `pnpm-lock.yaml` | upstream HEAD via GitHub API |
| linked | `link:../my-plugin` | local `git rev-parse HEAD` | `git ls-remote origin HEAD` (read-only) |

The npm channel deliberately ignores the `latest` dist-tag: monorepo sub-packages often leave that tag stale, which false-flags installs that are actually *newer* than the tag. Versions are compared with full semver precedence (prereleases included), so `0.1.0-rc.6 > 0.1.0-rc.5` and `1.0.0 > 1.0.0-rc.1` both hold.

Updates execute only through `dsh plugin --profile <p> add <target>` — the same path a human would type — with the target string validated against an allowlist. Nothing is ever piped through a shell.

## Security

- The only mutating route is `POST /dsh-update-copilot/update`: same-origin enforced, `confirm: true` required.
- Official `@deepseek-ai/*` packages and the dsh core are never auto-updated; the core's upgrade command is displayed, not run.
- All upstream queries are read-only (`registry.npmjs.org`, `api.github.com`, `git ls-remote`) with hard timeouts; a failed check degrades that one item instead of failing the scan.

## Limitations

- Plugin updates need a `dsh` restart to take effect (no hot-mount).
- Unauthenticated GitHub API is rate-limited (60 req/h) — briefs degrade gracefully to version lists.
- Raw `git+https://` specs are reported as-is without a comparison channel.

## Contributing

Issues and PRs welcome at [hezhongtang/dsh-update-copilot](https://github.com/hezhongtang/dsh-update-copilot). The codebase is intentionally small and dependency-free — plain ESM on the host, a hand-authored CJS bundle in the browser, no build step to set up.

## License

[MIT](LICENSE) © 2026 hezhongtang
