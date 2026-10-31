/**
 * api.js — Public enhancement interface for ScalePress.
 *
 * This used to be a Gradio client talking to GPU servers (Modal /
 * Beam / Hugging Face). That architecture is gone: every server route
 * ended up paid or card-gated (see DEPLOY.md). ScalePress now runs
 * the AI entirely on the visitor's device, and this module is a thin
 * adapter over js/engine.js (which owns the inference worker) that
 * keeps the call shape js/app.js has always used:
 *
 *   upscaleOnce(file, { model, scale, faceEnhance }, { onStage, signal, job })
 *     -> Promise<{ blob }>
 *
 * Stage callbacks keep the UI honest about what is happening:
 *   "downloading-model" (first use of a model; detail has byte counts
 *                        plus an etaMs estimate once a rate is known)
 *   "loading-model"     (session creation on this device)
 *   "enhancing"         (detail { done, total, etaMs } — done/total
 *                        are JOB-level tile counts, see below)
 *   "finalizing"        (encoding the result)
 *
 * Whole-job ETA: one user-facing job can chain several worker passes
 * (a 4K/8K target from a small source runs 4x, then 2x). The worker
 * reports tiles per pass, but the on-screen countdown must cover the
 * whole job, so app.js passes a shared `job` context ({ id, passes })
 * whose passes carry their input dimensions. This module keeps the
 * running state per job id — tiles finished in earlier passes, the
 * tile size in use (learned from the worker; it depends on the
 * execution provider) — projects the remaining passes' tile counts
 * with the same planTiles math the worker uses, and feeds the
 * job-level counters to an EtaTracker (js/eta.js). The "enhancing"
 * detail forwarded to the UI therefore carries job-level done/total
 * plus etaMs (null until the first tile lands). The per-pass numbers
 * stay available as passDone/passTotal. Calls without a job context
 * behave as a single-pass job.
 *
 * faceEnhance is accepted for signature compatibility and ignored:
 * face restoration is not available in the browser version (the UI
 * disables the toggle and says why — see config.FACE_RESTORE_AVAILABLE).
 */

import { runUpscale, EngineError } from "./engine.js";
import { EtaTracker } from "./eta.js";
import { planTiles } from "./tiling.js";
import { TILE_MARGIN } from "./config.js";

export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ApiError";
    this.code = code; // "network" | "engine" | "decode" | "too-large" | "aborted" | "bad-model"
  }
}

/* ------------------------------------------------------------------ */
/* Whole-job ETA state                                                 */
/* ------------------------------------------------------------------ */

const jobStates = new Map(); // job.id -> state (see newJobState)

function newJobState() {
  return {
    passIndex: 0, // which pass the next upscaleOnce call for this job runs
    tilesBefore: 0, // actual tiles completed by earlier passes
    passTotal: null, // tile total of the running pass (the worker's word)
    tileSize: null, // learned from the worker's progress events
    elapsedBase: 0, // worker-clock ms folded in from finished stretches
    lastElapsedMs: null, // last worker elapsedMs seen (per-attempt clock)
    wallStart: null, // fallback clock origin if a worker sends no elapsedMs
    tracker: new EtaTracker(),
  };
}

function validJob(job) {
  return Boolean(
    job &&
      job.id != null &&
      Array.isArray(job.passes) &&
      job.passes.length > 0 &&
      job.passes.every(
        (p) => p && Number.isFinite(p.width) && Number.isFinite(p.height) && p.width > 0 && p.height > 0,
      ),
  );
}

/** Exact tile count for passes [fromPass, toPass) at the learned tile size. */
function projectedTiles(state, job, fromPass, toPass = job.passes.length) {
  if (!state.tileSize) return null;
  let sum = 0;
  try {
    for (let i = fromPass; i < toPass; i += 1) {
      sum += planTiles(Math.round(job.passes[i].width), Math.round(job.passes[i].height), {
        tileSize: state.tileSize,
        margin: TILE_MARGIN,
      }).total;
    }
  } catch {
    return null;
  }
  return sum;
}

/**
 * One continuous job clock out of the worker's per-attempt elapsedMs
 * (it restarts at every attempt of every pass): whenever the reported
 * value goes backwards, the finished stretch is folded into the base.
 */
function jobClock(state, detail) {
  const e = detail?.elapsedMs;
  if (!Number.isFinite(e)) {
    if (state.wallStart == null) state.wallStart = Date.now();
    return state.elapsedBase + (Date.now() - state.wallStart);
  }
  if (state.lastElapsedMs != null && e < state.lastElapsedMs) {
    state.elapsedBase += state.lastElapsedMs;
  }
  state.lastElapsedMs = e;
  return state.elapsedBase + e;
}

/**
 * Run one upscale pass end to end, on this device.
 *
 * @param {File|Blob} file  The image to enhance (a Blob from a previous
 *                          pass is fine — passes chain through here).
 * @param {{model: string, scale: number, faceEnhance?: boolean}} options
 * @param {{onStage?: (stage: string, detail?: object) => void,
 *          signal?: AbortSignal,
 *          job?: {id: *, passes: Array<{width: number, height: number}>}}} hooks
 *   job — shared context for a multi-pass job (see the header note);
 *   passes[i] is the input size of pass i. Omit for a one-pass job.
 * @returns {Promise<{blob: Blob}>}
 */
export async function upscaleOnce(file, options, { onStage, signal, job } = {}) {
  const hasJob = validJob(job);
  let state;
  let passIndex = 0;
  if (hasJob) {
    state = jobStates.get(job.id);
    if (!state) {
      state = newJobState();
      jobStates.set(job.id, state);
    }
    passIndex = state.passIndex;
    state.passIndex += 1;
  } else {
    state = newJobState();
  }
  const downloadTracker = new EtaTracker();

  const handleStage = (stage, detail) => {
    if (stage === "enhancing" && detail) {
      if (Number.isFinite(detail.tileSize)) state.tileSize = detail.tileSize;
      if (Number.isFinite(detail.total)) state.passTotal = detail.total;
      const passDone = Number.isFinite(detail.done) ? detail.done : 0;
      const jobDone = state.tilesBefore + passDone;
      let jobTotal = null;
      if (state.passTotal != null) {
        jobTotal = state.tilesBefore + state.passTotal;
        if (hasJob && passIndex < job.passes.length - 1) {
          const rest = projectedTiles(state, job, passIndex + 1);
          if (rest != null) jobTotal += rest;
        }
      }
      const etaMs = jobTotal != null ? state.tracker.sample(jobClock(state, detail), jobDone, jobTotal) : null;
      onStage?.(stage, {
        ...detail,
        done: jobDone,
        total: jobTotal ?? state.tilesBefore + (state.passTotal ?? 0),
        passDone,
        passTotal: state.passTotal,
        etaMs,
      });
      return;
    }
    if (stage === "downloading-model" && detail && detail.total > 0) {
      // Bytes are just another unit to the tracker; the estimate is
      // null until enough of the file has arrived to price a rate.
      const etaMs = downloadTracker.sample(Date.now(), detail.loaded || 0, detail.total);
      onStage?.(stage, { ...detail, etaMs });
      return;
    }
    onStage?.(stage, detail);
  };

  try {
    const blob = await runUpscale(
      file,
      { model: options.model, scale: options.scale },
      { onStage: handleStage, signal },
    );
    if (!blob || !blob.size) {
      throw new ApiError("Enhancement finished but produced an empty file. Please retry.", "engine");
    }
    if (hasJob) {
      // Bank this pass's tiles for the next pass's job-level counters.
      state.tilesBefore += state.passTotal ?? projectedTiles(state, job, passIndex, passIndex + 1) ?? 0;
      state.passTotal = null;
      if (passIndex >= job.passes.length - 1) jobStates.delete(job.id);
    }
    return { blob };
  } catch (err) {
    if (hasJob) jobStates.delete(job.id);
    if (err instanceof ApiError) throw err;
    if (err instanceof EngineError) throw new ApiError(err.message, err.code);
    throw new ApiError(err?.message || "Enhancement failed for an unknown reason. Please retry.", "engine");
  }
}
