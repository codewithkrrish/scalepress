/**
 * worker.js — ScalePress on-device inference worker (module worker).
 *
 * Owns everything heavy so the page never freezes:
 *   - ONNX Runtime Web (loaded once from the pinned CDN bundle)
 *   - model downloads with progress, cached in Cache Storage
 *   - inference sessions, with a (model source x execution provider)
 *     fallback chain: WebGPU first, WASM second; the fp16 Max Quality
 *     file first, its fp32 fallback second (see js/config.js)
 *   - tiled 4x inference (js/tiling.js) stitched into an output
 *     canvas, downscaled during the draw when a 2x result was asked
 *     for, encoded to a PNG blob
 *
 * Protocol (see js/engine.js for the other side):
 *   in : { type: "run", id, model: {id, scale, sources}, scale, blob }
 *        { type: "cancel", id }
 *   out: { type: "stage", id, stage, detail }
 *        { type: "result", id, blob }
 *        { type: "error", id, message, code }
 * Stages: "downloading-model" (detail {loaded, total}),
 *         "loading-model", "enhancing" (detail {done, total,
 *         tileSize, elapsedMs} — tiles within THIS pass, the tile
 *         size in use, and ms since this pass's tile loop began;
 *         js/api.js aggregates these into a whole-job ETA),
 *         "finalizing".
 */

import {
  ORT_BUNDLE_URL,
  ORT_WASM_PATHS,
  MODEL_CACHE_NAME,
  TILE_SIZE_WASM,
  TILE_SIZE_WEBGPU,
  TILE_MARGIN,
} from "./config.js";
import { planTiles, checkOutputBudget } from "./tiling.js";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

function jobError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/* ------------------------------------------------------------------ */
/* ONNX Runtime — loaded lazily, once                                  */
/* ------------------------------------------------------------------ */

let ortPromise = null;
function loadOrt() {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import(/* @vite-ignore */ ORT_BUNDLE_URL);
      ort.env.wasm.wasmPaths = ORT_WASM_PATHS;
      ort.env.wasm.numThreads = self.crossOriginIsolated
        ? Math.min(4, navigator.hardwareConcurrency || 2)
        : 1;
      return ort;
    })();
  }
  return ortPromise;
}

/* ------------------------------------------------------------------ */
/* fp16 <-> fp32 helpers (the hosted Max Quality file is fp16)         */
/* ------------------------------------------------------------------ */

const _f32 = new Float32Array(1);
const _i32 = new Int32Array(_f32.buffer);

function floatToHalf(value) {
  _f32[0] = value;
  const x = _i32[0];
  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;
  if (e < 103) return bits;
  if (e > 142) {
    bits |= 0x7c00;
    return bits;
  }
  if (e < 113) {
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}

function halfToFloat(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) {
    if (f === 0) return s ? -0 : 0;
    let ef = f;
    let exp = -14;
    while ((ef & 0x0400) === 0) {
      ef <<= 1;
      exp -= 1;
    }
    ef &= 0x03ff;
    return (s ? -1 : 1) * 2 ** exp * (1 + ef / 1024);
  }
  if (e === 0x1f) return f === 0 ? (s ? -Infinity : Infinity) : NaN;
  return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
}

/* ------------------------------------------------------------------ */
/* Model bytes: Cache Storage first, then a streamed fetch             */
/* ------------------------------------------------------------------ */

async function getModelBytes(source, report) {
  const url = source.url;
  let cache = null;
  try {
    cache = await caches.open(MODEL_CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    cache = null; // Cache Storage unavailable (private mode, quota) — go without.
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw jobError(`The AI model could not be downloaded (HTTP ${res.status}). Check your connection and retry.`, "network");
  }
  const total = Number(res.headers.get("content-length")) || Math.round((source.sizeMB || 0) * 1024 * 1024);
  let bytes;
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      report({ loaded, total });
    }
    bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
    report({ loaded: bytes.byteLength, total: total || bytes.byteLength });
  }

  if (cache) {
    try {
      await cache.put(url, new Response(bytes.slice(), { headers: { "Content-Type": "application/octet-stream" } }));
    } catch {
      // Caching is an optimisation; a quota failure must not fail the job.
    }
  }
  return bytes;
}

/* ------------------------------------------------------------------ */
/* Sessions: one per model, with a source x provider fallback chain    */
/* ------------------------------------------------------------------ */

const sessions = new Map(); // modelId -> { session, provider, source, inputName, outputName }
const badCombos = new Set(); // `${modelId}|${sourceIndex}|${provider}` — failed at create/first run
const provenCombos = new Set(); // same key shape — completed at least one tile

async function providerOrder() {
  const order = [];
  if (typeof navigator !== "undefined" && "gpu" in navigator) order.push("webgpu");
  order.push("wasm");
  return order;
}

async function ensureSession(job, model, stage) {
  const existing = sessions.get(model.id);
  if (existing) return existing;

  const ort = await loadOrt().catch(() => null);
  if (!ort) {
    throw jobError(
      "The AI engine (ONNX Runtime) could not be loaded. Check your connection and reload the page.",
      "engine",
    );
  }

  const providers = await providerOrder();
  let lastError = null;
  for (let s = 0; s < model.sources.length; s += 1) {
    const source = model.sources[s];
    let bytes = null;
    for (const provider of providers) {
      const key = `${model.id}|${s}|${provider}`;
      if (badCombos.has(key)) continue;
      try {
        if (!bytes) {
          stage("downloading-model", { loaded: 0, total: Math.round((source.sizeMB || 0) * 1024 * 1024) });
          bytes = await getModelBytes(source, (detail) => stage("downloading-model", detail));
        }
        stage("loading-model", { provider });
        const session = await ort.InferenceSession.create(bytes, {
          executionProviders: [provider],
          graphOptimizationLevel: "all",
        });
        const entry = {
          session,
          provider,
          source,
          sourceIndex: s,
          inputName: session.inputNames[0],
          outputName: session.outputNames[0],
        };
        sessions.set(model.id, entry);
        return entry;
      } catch (err) {
        lastError = err;
        badCombos.add(key);
      }
    }
  }
  throw jobError(
    `The ${model.label || "AI"} model could not run on this device (${lastError?.message || "no execution provider available"}). Try the General Photo model, or a device with WebGPU.`,
    "engine",
  );
}

/* ------------------------------------------------------------------ */
/* Tensor <-> pixels                                                   */
/* ------------------------------------------------------------------ */

function tileToTensor(imageData, W, tile, dtype) {
  const { inX, inY, inW, inH } = tile;
  const count = inW * inH;
  const src = imageData.data;
  if (dtype === "fp16") {
    const data = new Uint16Array(count * 3);
    for (let c = 0; c < 3; c += 1) {
      const base = c * count;
      for (let y = 0; y < inH; y += 1) {
        let p = ((inY + y) * W + inX) * 4 + c;
        let q = base + y * inW;
        for (let x = 0; x < inW; x += 1) {
          data[q] = floatToHalf(src[p] / 255);
          p += 4;
          q += 1;
        }
      }
    }
    return { data, dims: [1, 3, inH, inW], type: "float16" };
  }
  const data = new Float32Array(count * 3);
  for (let c = 0; c < 3; c += 1) {
    const base = c * count;
    for (let y = 0; y < inH; y += 1) {
      let p = ((inY + y) * W + inX) * 4 + c;
      let q = base + y * inW;
      for (let x = 0; x < inW; x += 1) {
        data[q] = src[p] / 255;
        p += 4;
        q += 1;
      }
    }
  }
  return { data, dims: [1, 3, inH, inW], type: "float32" };
}

function tensorToImageData(rawData, isFp16, w, h) {
  const count = w * h;
  const out = new ImageData(w, h);
  const dst = out.data;
  for (let c = 0; c < 3; c += 1) {
    const base = c * count;
    for (let i = 0; i < count; i += 1) {
      let v = isFp16 ? halfToFloat(rawData[base + i]) : rawData[base + i];
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      dst[i * 4 + c] = Math.round(v * 255);
    }
  }
  for (let i = 0; i < count; i += 1) dst[i * 4 + 3] = 255;
  return out;
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

const cancelled = new Set();

function deviceHints() {
  const ua = navigator.userAgent || "";
  return {
    deviceMemoryGB: typeof navigator.deviceMemory === "number" ? navigator.deviceMemory : null,
    isMobile: /Android|iPhone|iPad|iPod|Mobile/i.test(ua),
  };
}

async function runJob(msg) {
  const { id, model, scale, blob } = msg;
  const stage = (name, detail) => self.postMessage({ type: "stage", id, stage: name, detail });
  const isCancelled = () => cancelled.has(id);

  // 1) Decode + read pixels.
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw jobError("This image could not be decoded by your browser. Try a JPG or PNG version of it.", "decode");
  }
  const W = bitmap.width;
  const H = bitmap.height;

  // 2) Memory budget: refuse cleanly instead of crashing the tab.
  const budget = checkOutputBudget(W, H, scale, deviceHints());
  if (!budget.ok) {
    bitmap.close?.();
    throw jobError(
      `This image would produce a ${(budget.pixels / 1e6).toFixed(0)} MP result at ${scale}x, which is more than this device can safely hold in memory (limit ≈ ${(budget.cap / 1e6).toFixed(0)} MP). Shrink the image first (PixelPress works for that) or pick a smaller scale.`,
      "too-large",
    );
  }
  const srcCanvas = new OffscreenCanvas(W, H);
  const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });
  srcCtx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const imageData = srcCtx.getImageData(0, 0, W, H);

  // 3) Session (with the fallback chain), then tiled inference. If the
  // very first tile run fails on a combo that has never succeeded,
  // blacklist it and retry with the next combo — this is how an fp16
  // file on a device without fp16 support lands on its fp32 fallback.
  // A failure after some tiles succeeded is a real error (usually
  // memory), surfaced as-is.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const entry = await ensureSession({ id }, model, stage);
    const comboKey = `${model.id}|${entry.sourceIndex}|${entry.provider}`;
    const ort = await loadOrt();
    const tileSize = entry.provider === "webgpu" ? TILE_SIZE_WEBGPU : TILE_SIZE_WASM;
    const plan = planTiles(W, H, { tileSize, margin: TILE_MARGIN, scale: model.scale });

    const outScale = scale / model.scale; // 1 for a 4x request, 0.5 for 2x
    const outCanvas = new OffscreenCanvas(Math.round(plan.outputWidth * outScale), Math.round(plan.outputHeight * outScale));
    const outCtx = outCanvas.getContext("2d");
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = "high";

    const tileCanvas = new OffscreenCanvas(1, 1);
    const tileCtx = tileCanvas.getContext("2d");

    const tilesStartedAt = performance.now();
    const enhancingDetail = (done) => ({
      done,
      total: plan.total,
      tileSize,
      elapsedMs: Math.round(performance.now() - tilesStartedAt),
    });
    stage("enhancing", enhancingDetail(0));
    let tilesDone = 0;
    try {
      for (let i = 0; i < plan.tiles.length; i += 1) {
        if (isCancelled()) throw jobError("Enhancement was cancelled.", "aborted");
        const tile = plan.tiles[i];
        const t = tileToTensor(imageData, W, tile, entry.source.dtype);
        const input = new ort.Tensor(t.type, t.data, t.dims);
        const outputs = await entry.session.run({ [entry.inputName]: input });
        const outTensor = outputs[entry.outputName];
        const raw = typeof outTensor.getData === "function" ? await outTensor.getData() : outTensor.data;
        const tileImg = tensorToImageData(raw, entry.source.dtype === "fp16", tile.inW * model.scale, tile.inH * model.scale);
        tileCanvas.width = tileImg.width;
        tileCanvas.height = tileImg.height;
        tileCtx.putImageData(tileImg, 0, 0);
        outCtx.drawImage(
          tileCanvas,
          tile.cropX,
          tile.cropY,
          tile.outW,
          tile.outH,
          Math.round(tile.outX * outScale),
          Math.round(tile.outY * outScale),
          Math.round(tile.outW * outScale),
          Math.round(tile.outH * outScale),
        );
        tilesDone = i + 1;
        provenCombos.add(comboKey);
        stage("enhancing", enhancingDetail(tilesDone));
      }
    } catch (err) {
      if (err?.code === "aborted") throw err;
      if (tilesDone === 0 && !provenCombos.has(comboKey)) {
        badCombos.add(comboKey);
        sessions.delete(model.id);
        continue; // next combo in the chain
      }
      throw jobError(
        `The AI model stopped while enhancing this image (${err?.message || "unknown error"}). A smaller image, or the General Photo model, may work better on this device.`,
        "engine",
      );
    }

    stage("finalizing", {});
    const outBlob = await outCanvas.convertToBlob({ type: "image/png" });
    return outBlob;
  }
  throw jobError("The AI model could not run on this device.", "engine");
}

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "cancel") {
    cancelled.add(msg.id);
    return;
  }
  if (msg.type !== "run") return;
  runJob(msg)
    .then((blob) => {
      self.postMessage({ type: "result", id: msg.id, blob });
    })
    .catch((err) => {
      self.postMessage({
        type: "error",
        id: msg.id,
        message: err?.message || "Enhancement failed on this device.",
        code: err?.code || "engine",
      });
    })
    .finally(() => {
      cancelled.delete(msg.id);
    });
});
