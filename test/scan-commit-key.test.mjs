// Fragment-aware github commit keys: the lockfile's codeload URLs carry the
// pin in the URL path and only STRUCTURAL (#path:) fragments — so a spec's
// pin fragment (#<sha>, e.g. the state a rollback install leaves behind)
// must not leak into the key, while same-repo subpath deps stay distinct
// from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-update-copilot-key-'))
process.env.DSH_HOME = home

const rootSha = 'a'.repeat(40)
const subSha = 'b'.repeat(40)

const profile = join(home, 'profiles', 'web')
mkdirSync(profile, { recursive: true })
writeFileSync(join(profile, 'pnpm-lock.yaml'), [
  'packages:',
  `  root:`,
  `    resolution: {tarball: https://codeload.github.com/owner/repo/tar.gz/${rootSha}}`,
  `  sub:`,
  `    resolution: {tarball: https://codeload.github.com/owner/repo/tar.gz/${subSha}#path:/examples/sub}`,
  '',
].join('\n'))

const { githubCommitKey, pinnedCommits } = await import('../lib/scan.js')

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('githubCommitKey keeps structural fragments, drops pins', () => {
  assert.equal(githubCommitKey('github:owner/repo'), 'owner/repo')
  assert.equal(githubCommitKey('owner/repo'), 'owner/repo')
  assert.equal(githubCommitKey('github:owner/repo#path:/examples/sub'), 'owner/repo#path:/examples/sub')
  // Pin fragments never appear in codeload URLs — the pin IS the URL path.
  assert.equal(githubCommitKey(`github:owner/repo#${rootSha}`), 'owner/repo')
  assert.equal(githubCommitKey('github:owner/repo#main'), 'owner/repo')
  assert.equal(githubCommitKey('plain-version-1.2.3'), null)
})

test('pinnedCommits keys match githubCommitKey for the same specs', () => {
  const commits = pinnedCommits('web')
  assert.equal(commits.get(githubCommitKey('github:owner/repo')), rootSha)
  assert.equal(commits.get(githubCommitKey('github:owner/repo#path:/examples/sub')), subSha)
  // The post-rollback spec (pinned to a commit) resolves to the same row.
  assert.equal(commits.get(githubCommitKey(`github:owner/repo#${rootSha}`)), rootSha)
})
