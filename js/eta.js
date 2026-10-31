/**
 * eta.js — Pure time-remaining estimates for the enhance flow.
 *
 * No DOM, no worker APIs, no imports: plain arithmetic over
 * (elapsed, units done, units total), so tests/harness.mjs can verify
 * every branch in Node. Units are whatever the caller counts — tiles
 * across a whole multi-pass job, or bytes during a model download.
 *
 * The estimate is a rate projection: remaining = unitsLeft / rate.
 * The rate blends the overall average since the job started with the
 * rate over a recent window, so a device that warms up (or throttles)
 * moves the estimate instead of leaving it stuck on the first tile's
 * pace. Everything is defensive: until at least one unit is done the
 * answer is null ("no honest estimate yet"), it is exactly 0 at
 * completion, and it is clamped so a pathological rate can never
 * promise more than an hour.
 */

/** Hard ceiling for a displayed estimate — anything above is noise. */
export const MAX_ETA_MS = 60 * 60 * 1000;

/**
 * Estimate the milliseconds remaining.
 *
 * @param {{elapsedMs: number, done: number, total: number,
 *          recent?: {elapsedMs: number, done: number} | null}} input
 *   elapsedMs / done — units completed within the elapsed window.
 *   total            — units in the same scope as `done` (a caller
 *                      tracking a window that started mid-job passes
 *                      total relative to the window's start).
 *   recent           — optional earlier point in the same window;
 *                      the rate between it and now is blended 50/50
 *                      with the overall rate.
 * @returns {number|null} ms remaining (>= 0, <= MAX_ETA_MS), 0 when
 *   done >= total, or null when no honest estimate exists yet.
 */
export function estimateRemainingMs({ elapsedMs, done, total, recent = null } = {}) {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(done) || done <= 0) return null;
  if (done >= total) return 0;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;

  const overallRate = done / elapsedMs; // units per ms
  let rate = overallRate;
  if (recent && Number.isFinite(recent.done) && Number.isFinite(recent.elapsedMs)) {
    const dDone = done - recent.done;
    const dMs = elapsedMs - recent.elapsedMs;
    if (dDone > 0 && dMs > 0) {
      const recentRate = dDone / dMs;
      if (Number.isFinite(recentRate) && recentRate > 0) {
        rate = (overallRate + recentRate) / 2;
      }
    }
  }
  if (!(rate > 0) || !Number.isFinite(rate)) return null;

  const remaining = (total - done) / rate;
  if (!Number.isFinite(remaining)) return null;
  return Math.min(MAX_ETA_MS, Math.max(0, Math.round(remaining)));
}

/**
 * Stateful sampler around estimateRemainingMs. Feed it a timestamp
 * with each progress update; it keeps the origin sample (for the
 * overall rate) and a recent window (for the blended rate), and it
 * normalises both to the origin, so a caller may pass absolute job
 * counters. If progress ever moves backwards — the worker restarted
 * a pass on a fallback provider, say — the history resets and the
 * estimate warms up again instead of going negative or absurd.
 */
export class EtaTracker {
  constructor({ windowMs = 15000 } = {}) {
    this.windowMs = windowMs;
    this.samples = []; // [{ t, done }] — t in the caller's clock
  }

  reset() {
    this.samples = [];
  }

  /**
   * @param {number} nowMs  timestamp in any monotonic-enough clock
   * @param {number} done   units completed (absolute)
   * @param {number} total  units in the whole job (absolute)
   * @returns {number|null} estimated ms remaining
   */
  sample(nowMs, done, total) {
    if (!Number.isFinite(nowMs) || !Number.isFinite(done) || !Number.isFinite(total)) return null;
    const last = this.samples[this.samples.length - 1];
    if (last && (done < last.done || nowMs < last.t)) this.reset();
    const tail = this.samples[this.samples.length - 1];
    if (!tail || tail.done !== done || tail.t !== nowMs) {
      this.samples.push({ t: nowMs, done });
    }
    // Keep the origin plus a bounded tail; jobs have at most a few
    // thousand tiles, downloads a few hundred chunks.
    if (this.samples.length > 300) {
      this.samples.splice(1, this.samples.length - 256);
    }

    const origin = this.samples[0];
    const elapsedMs = nowMs - origin.t;
    const doneInWindow = done - origin.done;

    // Recent window: the earliest retained sample inside the last
    // windowMs — unless that is the origin itself (then the overall
    // rate already IS the recent rate and blending changes nothing).
    let recent = null;
    for (const s of this.samples) {
      if (s.t >= nowMs - this.windowMs) {
        if (s !== origin && nowMs - s.t >= 500 && done - s.done >= 1) {
          recent = { elapsedMs: s.t - origin.t, done: s.done - origin.done };
        }
        break;
      }
    }

    return estimateRemainingMs({
      elapsedMs,
      done: doneInWindow,
      total: total - origin.done,
      recent,
    });
  }
}

/**
 * Age an estimate: an ETA computed `etaAt` in the past has shrunk by
 * however long ago it was computed. Lets the 1-second UI ticker count
 * the displayed value down between progress events instead of leaving
 * it frozen on the last tile's number. Returns null for null input.
 */
export function decayedEtaMs(etaMs, etaAt, nowMs) {
  if (etaMs == null || !Number.isFinite(etaMs)) return null;
  if (etaAt == null || !Number.isFinite(etaAt) || !Number.isFinite(nowMs)) return etaMs;
  return Math.max(0, etaMs - (nowMs - etaAt));
}

/**
 * Format an ETA the way the UI speaks: "~24s left", "~1m 20s left".
 * Rounds up to whole seconds (an estimate should not promise 0 while
 * work remains). null in → "" out.
 */
export function formatEta(etaMs) {
  if (etaMs == null || !Number.isFinite(etaMs) || etaMs < 0) return "";
  const totalSeconds = Math.ceil(etaMs / 1000);
  if (totalSeconds < 60) return `~${totalSeconds}s left`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `~${minutes}m ${String(seconds).padStart(2, "0")}s left`;
}
