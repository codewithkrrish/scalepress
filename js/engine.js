/**
 * engine.js — Main-thread client for the on-device inference worker.
 *
 * Owns the single module Worker (js/worker.js), job bookkeeping and
 * the translation between worker messages and the promise/stage
 * interface js/api.js exposes. The worker is created lazily on the
 * first job: importing this module (e.g. at page startup) starts
 * nothing.
 */

import { MODELS, DEFAULT_MODEL_ID } from "./config.js";

export class EngineError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "EngineError";
    this.code = code; // "network" | "engine" | "decode" | "too-large" | "aborted" | "bad-model"
  }
}

let worker = null;
let nextJobId = 1;
const pending = new Map(); // id -> { resolve, reject, onStage }

function getWorker() {
  if (worker) return worker;
  if (typeof Worker === "undefined") {
    throw new EngineError("Web Workers are not available in this browser, so on-device enhancement cannot run.", "engine");
  }
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    const job = pending.get(msg.id);
    if (!job) return;
    if (msg.type === "stage") {
      job.onStage?.(msg.stage, msg.detail);
    } else if (msg.type === "result") {
      pending.delete(msg.id);
      job.resolve(msg.blob);
    } else if (msg.type === "error") {
      pending.delete(msg.id);
      job.reject(new EngineError(msg.message || "Enhancement failed on this device.", msg.code || "engine"));
    }
  });
  worker.addEventListener("error", () => {
    // A worker-level failure (script load error, unhandled throw)
    // fails every in-flight job; the next job respawns the worker.
    const err = new EngineError("The enhancement worker stopped unexpectedly. Please retry.", "engine");
    for (const job of pending.values()) job.reject(err);
    pending.clear();
    worker?.terminate();
    worker = null;
  });
  return worker;
}

/** Resolve a model id to its registry entry, with absolute source URLs. */
export function resolveModel(modelId) {
  const model = MODELS[modelId] || MODELS[DEFAULT_MODEL_ID];
  return {
    id: model.id,
    label: model.label,
    scale: model.scale,
    sources: model.sources.map((s) => ({
      ...s,
      url: new URL(s.url, document.baseURI).href,
    })),
  };
}

/**
 * Run one upscale pass on this device.
 *
 * @param {Blob|File} blob  image to enhance (a previous pass's output
 *                          Blob is fine — passes chain through here)
 * @param {{model: string, scale: number}} options
 * @param {{onStage?: (stage: string, detail?: object) => void,
 *          signal?: AbortSignal}} hooks
 * @returns {Promise<Blob>} the enhanced image as a PNG Blob
 */
export function runUpscale(blob, options, { onStage, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EngineError("Enhancement was cancelled.", "aborted"));
      return;
    }
    let w;
    try {
      w = getWorker();
    } catch (err) {
      reject(err);
      return;
    }
    const id = nextJobId++;
    const model = resolveModel(options.model);
    const scale = options.scale === 2 ? 2 : 4;

    const onAbort = () => {
      try {
        w.postMessage({ type: "cancel", id });
      } catch {
        // Worker already gone; the rejection below is what matters.
      }
      pending.delete(id);
      reject(new EngineError("Enhancement was cancelled.", "aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    pending.set(id, {
      onStage,
      resolve: (out) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(out);
      },
      reject: (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    });

    try {
      w.postMessage({ type: "run", id, model, scale, blob });
    } catch (err) {
      pending.delete(id);
      signal?.removeEventListener("abort", onAbort);
      reject(new EngineError(`The image could not be handed to the enhancement worker (${err?.message || "unknown error"}).`, "engine"));
    }
  });
}
