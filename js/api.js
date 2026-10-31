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
 *   upscaleOnce(file, { model, scale, faceEnhance }, { onStage, signal })
 *     -> Promise<{ blob }>
 *
 * Stage callbacks keep the UI honest about what is happening:
 *   "downloading-model" (first use of a model; detail has byte counts)
 *   "loading-model"     (session creation on this device)
 *   "enhancing"         (detail { done, total } tile progress)
 *   "finalizing"        (encoding the result)
 *
 * faceEnhance is accepted for signature compatibility and ignored:
 * face restoration is not available in the browser version (the UI
 * disables the toggle and says why — see config.FACE_RESTORE_AVAILABLE).
 */

import { runUpscale, EngineError } from "./engine.js";

export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ApiError";
    this.code = code; // "network" | "engine" | "decode" | "too-large" | "aborted" | "bad-model"
  }
}

/**
 * Run one upscale pass end to end, on this device.
 *
 * @param {File|Blob} file  The image to enhance (a Blob from a previous
 *                          pass is fine — passes chain through here).
 * @param {{model: string, scale: number, faceEnhance?: boolean}} options
 * @param {{onStage?: (stage: string, detail?: object) => void,
 *          signal?: AbortSignal}} hooks
 * @returns {Promise<{blob: Blob}>}
 */
export async function upscaleOnce(file, options, { onStage, signal } = {}) {
  try {
    const blob = await runUpscale(
      file,
      { model: options.model, scale: options.scale },
      { onStage, signal },
    );
    if (!blob || !blob.size) {
      throw new ApiError("Enhancement finished but produced an empty file. Please retry.", "engine");
    }
    return { blob };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof EngineError) throw new ApiError(err.message, err.code);
    throw new ApiError(err?.message || "Enhancement failed for an unknown reason. Please retry.", "engine");
  }
}
