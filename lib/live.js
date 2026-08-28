/**
 * Live "an update is executing right now" state, shared by every trigger
 * path and readable by every surface.
 *
 * All updates funnel through the serialized executors in update.js (web
 * routes, agent tools, link: switches). The executors record the current
 * update here — plus each emitted progress event — so ANY reader (the web
 * panel's /update-status poll, a second browser tab, a tool log) can tell
 * whether an update is running, which package it is on, and what stage it is
 * at. The GUI renders a persistent pulsing banner/badge from this instead of
 * letting a background update collide with the user clicking Update in the
 * foreground (which used to surface the confusing "another update is already
 * running" error while the actual update churned along invisibly).
 *
 * Pure ESM over no deps — unit-testable with `node --test` like the rest of
 * lib/.
 */

let current = null
let progress = null

/** Record that an update is executing (replaces any previous entry). */
export function setLiveUpdate(entry) {
  current = { startedAt: new Date().toISOString(), ...(entry ?? {}) }
}

/** Record the latest emitted progress event for the live reader. */
export function setLiveProgress(event) {
  progress = event ?? null
}

/** Clear the live slot — the update finished (or was aborted). */
export function clearLiveUpdate() {
  current = null
  progress = null
}

/** Snapshot of the live slot. `running` lives with update.js, not here. */
export function readLiveUpdate() {
  return { current, progress }
}