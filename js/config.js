/**
 * config.js — ScalePress runtime configuration.
 *
 * ScalePress runs 100% in the visitor's browser. There is no server:
 * this file is the registry of the ONNX models the worker downloads
 * (or reads from the site itself) and runs on the user's device with
 * ONNX Runtime Web. See DEPLOY.md for how each model was sourced and
 * verified, and for the (superseded) server architecture this
 * replaced.
 */

// ---------------------------------------------------------------------------
// ONNX Runtime Web — pinned. The webgpu bundle includes both the
// WebGPU and WASM execution providers; the WASM binaries are loaded
// from the same CDN directory (ORT_WASM_PATHS).
// ---------------------------------------------------------------------------
export const ORT_VERSION = "1.20.1";
export const ORT_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.webgpu.min.mjs`;
export const ORT_WASM_PATHS = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

/** Cache Storage bucket for downloaded model files (first visit only). */
export const MODEL_CACHE_NAME = "scalepress-models-v1";

// ---------------------------------------------------------------------------
// Model registry. Every model is a 4x network with dynamic input H/W,
// NCHW float input in [0, 1] and NCHW float output in ~[0, 1] (the
// engine clamps). `sources` are tried in order: the first source whose
// bytes load AND run on an available execution provider wins.
//
//   general — realesr-general-x4v3 (SRVGGNetCompact), converted from
//             the official release weights; small enough (4.9 MB) to
//             ship inside the site.
//   max     — RealESRGAN_x4plus. Primary source is a verified fp16
//             conversion hosted on Hugging Face (dynamic axes, CORS
//             open; output verified against the official weights —
//             see DEPLOY.md). Fallback is our own fp32 conversion of
//             the official weights, hosted in our own HF repo
//             (codewithkrrish/scalepress-models, CORS open, byte size
//             verified 67,051,644): at 67 MB it is too big to ship
//             inside the site, but it runs everywhere fp16 cannot.
//   anime   — RealESRGAN_x4plus_anime_6B, converted from the official
//             release weights. No trustworthy hosted ONNX of this
//             model exists (see DEPLOY.md), so it ships in the site.
//
// dtype says what the file's tensors are: "fp32" everywhere except
// the hosted x4plus, which is "fp16" (ideal on WebGPU; the engine
// falls back to the fp32 file when a device cannot run fp16).
// ---------------------------------------------------------------------------
export const MODELS = {
  general: {
    id: "general",
    label: "General Photo",
    scale: 4,
    sources: [
      { url: "assets/models/realesr-general-x4v3.onnx", sizeMB: 4.9, dtype: "fp32" },
    ],
  },
  max: {
    id: "max",
    label: "Max Quality",
    scale: 4,
    sources: [
      {
        url: "https://huggingface.co/imgdesignart/realesrgan-x4-onnx/resolve/main/onnx/model_fp16.onnx",
        sizeMB: 33.7,
        dtype: "fp16",
      },
      {
        url: "https://huggingface.co/codewithkrrish/scalepress-models/resolve/main/RealESRGAN_x4plus.onnx",
        sizeMB: 67.1,
        dtype: "fp32",
      },
    ],
  },
  anime: {
    id: "anime",
    label: "Anime",
    scale: 4,
    sources: [
      { url: "assets/models/RealESRGAN_x4plus_anime_6B.onnx", sizeMB: 17.9, dtype: "fp32" },
    ],
  },
};

/** Default model id, used when an unknown id is requested. */
export const DEFAULT_MODEL_ID = "general";

/**
 * Face restoration (GFPGAN) is NOT available in the browser version:
 * no trustworthy hosted ONNX of GFPGAN exists, the checkpoint alone
 * is ~349 MB, and a working feature also needs a face detector +
 * alignment pipeline. The UI says exactly this instead of faking it.
 * Evidence and details: DEPLOY.md, "Face restore".
 */
export const FACE_RESTORE_AVAILABLE = false;

/**
 * Input tile sizes for the tiled inference (see js/tiling.js).
 * WebGPU has the memory headroom for 512 px tiles; WASM stays at
 * 256 px to bound peak tensor memory on low-end devices.
 */
export const TILE_SIZE_WASM = 256;
export const TILE_SIZE_WEBGPU = 512;

/** Input-space context margin around each tile core (see tiling.js). */
export const TILE_MARGIN = 16;
