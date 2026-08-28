// Regression tests for the live update-status slot (lib/live.js).
//
// The web panel's /update-status poll reads one shared slot: which update is
// executing right now, on which package/profile/target, and at what stage.
// Every executor path (web routes, agent tools, link: switches) records into
// it and MUST clear it exactly once per update — otherwise the GUI holds a
// ghost "updating" banner forever, or hides a real background update and lets
// a foreground click collide with the single-flight lock into the confusing
// "another update is already running" error.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clearLiveUpdate,
  readLiveUpdate,
  setLiveProgress,
  setLiveUpdate,
} from '../lib/live.js'

test('idle slot reads null until an update is recorded', () => {
  clearLiveUpdate()
  assert.deepEqual(readLiveUpdate(), { current: null, progress: null })
})

test('recording an update stamps startedAt and keeps its fields', () => {
  clearLiveUpdate()
  setLiveUpdate({ name: 'dshmarket', profile: 'web', target: 'dshmarket@1.2.3' })
  const { current } = readLiveUpdate()
  assert.equal(current.name, 'dshmarket')
  assert.equal(current.profile, 'web')
  assert.equal(current.target, 'dshmarket@1.2.3')
  assert.ok(!Number.isNaN(Date.parse(current.startedAt)), 'startedAt is a valid ISO timestamp')
  assert.equal(readLiveUpdate().progress, null)
})

test('a newer recording replaces the older one (per-profile passes in bulk)', () => {
  clearLiveUpdate()
  setLiveUpdate({ name: 'dshmarket', profile: 'web' })
  setLiveUpdate({ name: 'dshmarket', profile: 'headless' })
  assert.equal(readLiveUpdate().current.profile, 'headless')
})

test('progress events track the latest stage and survive with no SSE sink', () => {
  clearLiveUpdate()
  setLiveUpdate({ name: 'pkg', profile: null })
  setLiveProgress({ type: 'phase', phase: 'start', attempt: 1, total: 3 })
  setLiveProgress({ type: 'progress', percent: 42, phase: 'downloading', attempt: 1, total: 3 })
  assert.deepEqual(readLiveUpdate().progress,
    { type: 'progress', percent: 42, phase: 'downloading', attempt: 1, total: 3 })
})

test('clearing empties both the entry and the progress', () => {
  clearLiveUpdate()
  setLiveUpdate({ name: 'pkg' })
  setLiveProgress({ type: 'phase', phase: 'pull' })
  clearLiveUpdate()
  assert.deepEqual(readLiveUpdate(), { current: null, progress: null })
})