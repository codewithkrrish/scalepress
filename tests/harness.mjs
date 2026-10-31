/**
 * harness.mjs — jsdom smoke test for the ScalePress frontend.
 *
 * Why this exists (hard lesson from PixelPress): `node --check` only proves
 * the files parse. It does not prove the module graph executes, that init()
 * finds every element id it expects in the real index.html, or that the
 * intake handlers register. This harness loads the REAL index.html into
 * jsdom, stubs the browser APIs jsdom lacks (canvas, object URLs,
 * createImageBitmap, Worker), imports the REAL js/app.js module graph, and
 * then drives the intake paths (file input change, paste, drop), the
 * engine client against a fake worker, the pure tiling math, and the
 * honesty checks for the browser build (no server copy, face restore
 * clearly unavailable).
 *
 * Run:  node tests/harness.mjs
 * (requires jsdom — `npm i --no-save jsdom` somewhere and NODE_PATH, or run
 *  from a directory where jsdom is installed; see tests/run.sh)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  // ES modules ignore NODE_PATH, so fall back to explicit locations:
  // $SCALEPRESS_JSDOM, then the scratch install used by tests/run.sh.
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const candidates = [
    process.env.SCALEPRESS_JSDOM,
    "/tmp/scalepress-test/node_modules/jsdom",
    join(root, "node_modules/jsdom"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      ({ JSDOM } = req(candidate));
      break;
    } catch {
      // try the next candidate
    }
  }
  if (!JSDOM) {
    console.error("FAIL: jsdom is not installed/resolvable. Run tests/run.sh.");
    process.exit(2);
  }
}

const html = readFileSync(join(root, "index.html"), "utf8");

const dom = new JSDOM(html, {
  url: "http://localhost:8000/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;

// ---- Stubs for APIs jsdom does not implement -----------------------------
let urlCounter = 0;
window.URL.createObjectURL = (blob) => `blob:mock-${++urlCounter}-${blob?.type || "x"}`;
window.URL.revokeObjectURL = () => {};
window.CSS = window.CSS || {};
window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
// jsdom has no canvas 2d context and no createImageBitmap.
window.createImageBitmap = async () => ({ width: 120, height: 80, close() {} });
window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    fillStyle: "",
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "high",
    fillRect() {},
    drawImage() {},
  };
};
window.HTMLCanvasElement.prototype.toBlob = function toBlob(cb, mime) {
  cb(new window.Blob(["fake-png"], { type: mime || "image/png" }));
};
// fetch is stubbed per-test below; start with a hard failure so any
// unexpected network attempt during startup is loud, not silent.
window.fetch = async () => {
  throw new Error("fetch called during startup — nothing should do that");
};

// A fake module Worker implementing the js/worker.js protocol, so the
// real engine client (js/engine.js) + api.js can run end to end.
class FakeWorker {
  static instances = [];
  static lastRun = null;
  constructor(url, opts) {
    this.url = String(url);
    this.opts = opts;
    this.listeners = new Map();
    FakeWorker.instances.push(this);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener() {}
  emit(type, data) {
    for (const fn of this.listeners.get(type) || []) fn({ data });
  }
  postMessage(msg) {
    if (msg?.type === "run") {
      FakeWorker.lastRun = msg;
      const deliver = (data) => queueMicrotask(() => this.emit("message", data));
      deliver({ type: "stage", id: msg.id, stage: "downloading-model", detail: { loaded: 50, total: 100 } });
      deliver({ type: "stage", id: msg.id, stage: "loading-model", detail: { provider: "wasm" } });
      // Worker-protocol enhancing events: per-pass tiles plus the
      // tileSize and tile-loop elapsedMs api.js aggregates into an ETA.
      // 4 tiles at a steady 1 tile/second keeps the expected ETAs exact.
      deliver({ type: "stage", id: msg.id, stage: "enhancing", detail: { done: 0, total: 4, tileSize: 256, elapsedMs: 0 } });
      deliver({ type: "stage", id: msg.id, stage: "enhancing", detail: { done: 2, total: 4, tileSize: 256, elapsedMs: 2000 } });
      deliver({ type: "stage", id: msg.id, stage: "enhancing", detail: { done: 4, total: 4, tileSize: 256, elapsedMs: 4000 } });
      deliver({ type: "result", id: msg.id, blob: new Blob(["result"], { type: "image/png" }) });
    }
  }
  terminate() {}
}

// Make jsdom globals visible to the ES modules (they reference bare
// `document`, `window`, `fetch`, `FormData`, `File`, ...).
for (const key of [
  "document", "window", "navigator", "HTMLElement", "HTMLInputElement",
  "HTMLCanvasElement", "Image", "Blob", "File", "FormData", "fetch",
  "URL", "CSS", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent",
  "AbortController", "AbortSignal", "TextDecoder", "TextEncoder",
  "ReadableStream", "crypto", "createImageBitmap",
]) {
  // NOTE: timers (setTimeout & friends) are deliberately NOT shadowed with
  // jsdom's — jsdom's timers delegate to the global ones, so replacing them
  // recurses forever. Node's timers serve the modules just fine.
  if (window[key] !== undefined) {
    // Some Node globals (navigator, crypto) are getter-only — define, don't assign.
    try {
      Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
    } catch {
      // A global we cannot shadow is fine to leave as Node's own.
    }
  }
}
// jsdom may not expose these on window even though Node has them globally.
window.TextEncoder = window.TextEncoder || globalThis.TextEncoder;
window.TextDecoder = window.TextDecoder || globalThis.TextDecoder;
window.ReadableStream = window.ReadableStream || globalThis.ReadableStream;
globalThis.window = window;
globalThis.document = window.document;
globalThis.self = window;
globalThis.Worker = FakeWorker;

const failures = [];
function check(name, cond) {
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures.push(name);
    console.log(`  FAIL - ${name}`);
  }
}

// jsdom fires DOMContentLoaded itself; app.js also handles the
// readyState!=="loading" path. Import after DOM is parsed.
console.log("1) importing the real module graph (js/app.js)…");
let appImportError = null;
try {
  await import(pathToFileURL(join(root, "js/app.js")).href);
} catch (err) {
  appImportError = err;
}
check("app.js module graph imports without throwing", !appImportError);
if (appImportError) console.error(appImportError);

// Give init() a tick (it runs on import or DOMContentLoaded).
await new Promise((r) => setTimeout(r, 50));

console.log("2) startup state…");
check("window.__scalepress handle exists (init ran)", Boolean(window.__scalepress));
check("enhance button exists and starts disabled", (() => {
  const b = window.document.querySelector("#enhanceBtn");
  return b && b.disabled === true;
})());
check("empty state is visible initially", window.document.querySelector("#emptyState").hidden === false);
check("footer contains the Instagram link", (() => {
  const a = window.document.querySelector('footer a[href="https://www.instagram.com/krrishx.ai"]');
  return Boolean(a);
})());
check("no worker was spawned at startup", FakeWorker.instances.length === 0);

console.log("3) intake: file-input change with a real File…");
const pngFile = new window.File([new Uint8Array([137, 80, 78, 71])], "photo.png", { type: "image/png" });
const input = window.document.querySelector("#fileInput");
Object.defineProperty(input, "files", { value: [pngFile], configurable: true });
input.dispatchEvent(new window.Event("change", { bubbles: true }));
await new Promise((r) => setTimeout(r, 100));
const entries = window.__scalepress.entries;
check("one entry was added", entries.size === 1);
const [entry] = [...entries.values()];
check("entry probed dimensions via stubbed createImageBitmap", entry.originalWidth === 120 && entry.originalHeight === 80);
check("entry is pending", entry.status === "pending");
check("a card was rendered for the entry", Boolean(window.document.querySelector(`[data-id="${entry.id}"]`)));
check("enhance button enabled with a pending entry", window.document.querySelector("#enhanceBtn").disabled === false);

console.log("4) intake: unsupported file produces an error card, not a crash…");
const txtFile = new window.File(["hello"], "notes.txt", { type: "text/plain" });
Object.defineProperty(input, "files", { value: [txtFile], configurable: true });
input.dispatchEvent(new window.Event("change", { bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
check("second entry added", entries.size === 2);
const errEntry = [...entries.values()].find((e) => e.file.name === "notes.txt");
check("unsupported entry is an error with a message", errEntry.status === "error" && /Unsupported/.test(errEntry.errorMessage));

console.log("5) intake: drop event on the dropzone registers…");
const dropzone = window.document.querySelector("#dropzone");
const jpgFile = new window.File([new Uint8Array([255, 216])], "drop.jpg", { type: "image/jpeg" });
const dropEvent = new window.Event("drop", { bubbles: true, cancelable: true });
dropEvent.dataTransfer = { files: [jpgFile], items: [], dropEffect: "copy" };
dropzone.dispatchEvent(dropEvent);
await new Promise((r) => setTimeout(r, 50));
check("drop added a third entry", entries.size === 3);

console.log("6) engine client: upscaleOnce against the fake worker…");
const { upscaleOnce, ApiError } = await import(pathToFileURL(join(root, "js/api.js")).href);
const stagesSeen = [];
const enhancingSeen = [];
try {
  const result = await upscaleOnce(
    pngFile,
    { model: "general", scale: 2, faceEnhance: false },
    {
      onStage: (stage, detail) => {
        stagesSeen.push(stage);
        if (stage === "enhancing") enhancingSeen.push(detail);
      },
    },
  );
  check("upscaleOnce resolves with a blob", result.blob && result.blob.size === 6 && result.blob.type === "image/png");
  check("stage callbacks fired (download -> loading -> enhancing)",
    stagesSeen.includes("downloading-model") && stagesSeen.includes("loading-model") && stagesSeen.includes("enhancing"));
  check("ETA is null before the first tile, exact once tiles land",
    enhancingSeen.length === 3 &&
    enhancingSeen[0].etaMs === null &&
    enhancingSeen[1].done === 2 && enhancingSeen[1].total === 4 && enhancingSeen[1].etaMs === 2000);
  check("ETA reaches 0 when the last tile lands",
    enhancingSeen[2].done === 4 && enhancingSeen[2].etaMs === 0);
  check("worker was spawned lazily, once", FakeWorker.instances.length === 1);
  check("worker script is js/worker.js", FakeWorker.instances[0].url.endsWith("/js/worker.js"));
  check("run message carries the resolved model + scale",
    FakeWorker.lastRun.model.id === "general" && FakeWorker.lastRun.scale === 2);
  check("model sources were resolved to absolute URLs",
    FakeWorker.lastRun.model.sources.every((s) => /^https?:\/\//.test(s.url)));
  check("general model source is the bundled same-origin file",
    FakeWorker.lastRun.model.sources[0].url.endsWith("/assets/models/realesr-general-x4v3.onnx"));
} catch (err) {
  check(`upscaleOnce resolves (threw: ${err.message})`, false);
}

console.log("7) engine client: unknown model falls back, abort is honoured…");
try {
  await upscaleOnce(pngFile, { model: "does-not-exist", scale: 4, faceEnhance: false }, {});
  check("unknown model id fell back to general", FakeWorker.lastRun.model.id === "general");
} catch (err) {
  check(`unknown-model fallback (threw: ${err.message})`, false);
}
try {
  const controller = new AbortController();
  controller.abort();
  await upscaleOnce(pngFile, { model: "general", scale: 4, faceEnhance: false }, { signal: controller.signal });
  check("pre-aborted signal rejects", false);
} catch (err) {
  check("pre-aborted signal rejects with an aborted ApiError", err instanceof ApiError && err.code === "aborted");
}

console.log("7b) engine client: a two-pass job aggregates tiles + ETA across passes…");
try {
  // Pass 2's input (400x320) at the learned 256px tile size is exactly
  // 4 more tiles, so the whole job is 8 tiles from the first event on.
  const jobCtx = { id: "harness-job", passes: [{ width: 100, height: 80 }, { width: 400, height: 320 }] };
  const jobSeen = [];
  const collect = (pass) => (stage, detail) => {
    if (stage === "enhancing") jobSeen.push({ pass, ...detail });
  };
  await upscaleOnce(pngFile, { model: "general", scale: 4, faceEnhance: false }, { job: jobCtx, onStage: collect(1) });
  await upscaleOnce(pngFile, { model: "general", scale: 2, faceEnhance: false }, { job: jobCtx, onStage: collect(2) });
  const p1Mid = jobSeen.find((d) => d.pass === 1 && d.passDone === 2);
  const p2Mid = jobSeen.find((d) => d.pass === 2 && d.passDone === 2);
  check("pass 1 already counts pass 2's tiles in the job total",
    p1Mid && p1Mid.done === 2 && p1Mid.total === 8 && p1Mid.etaMs === 6000);
  check("pass 2 continues the same job counters and clock",
    p2Mid && p2Mid.done === 6 && p2Mid.total === 8 && p2Mid.etaMs === 2000);
  check("job ETA reaches 0 on the final tile of the final pass",
    jobSeen[jobSeen.length - 1].done === 8 && jobSeen[jobSeen.length - 1].etaMs === 0);
} catch (err) {
  check(`multi-pass job aggregation (threw: ${err.message})`, false);
}

console.log("8) tiling math: plan coverage, invariants, size helpers…");
const tiling = await import(pathToFileURL(join(root, "js/tiling.js")).href);
const { planTiles, scaledSize, outputPixels, outputCapFor, checkOutputBudget, sizeForLongEdge } = tiling;

function coverageOk(plan, W, H, scale) {
  const bands = new Map();
  for (const t of plan.tiles) {
    if (!bands.has(t.outY)) bands.set(t.outY, []);
    bands.get(t.outY).push(t);
  }
  let yCursor = 0;
  for (const y of [...bands.keys()].sort((a, b) => a - b)) {
    if (y !== yCursor) return false;
    const row = bands.get(y).sort((a, b) => a.outX - b.outX);
    const bandH = row[0].outH;
    let xCursor = 0;
    for (const t of row) {
      if (t.outX !== xCursor || t.outH !== bandH) return false;
      xCursor += t.outW;
    }
    if (xCursor !== W * scale) return false;
    yCursor += bandH;
  }
  return yCursor === H * scale;
}

const tileCases = [
  [100, 80], [256, 256], [300, 200], [1024, 768], [50, 50], [1, 1], [224, 223], [2048, 1536],
];
let allCoverage = true;
let allInvariants = true;
let areaOk = true;
for (const [W, H] of tileCases) {
  for (const tileSize of [256, 512]) {
    const plan = planTiles(W, H, { tileSize, margin: 16, scale: 4 });
    if (!coverageOk(plan, W, H, 4)) allCoverage = false;
    const area = plan.tiles.reduce((sum, t) => sum + t.outW * t.outH, 0);
    if (area !== W * H * 16) areaOk = false;
    for (const t of plan.tiles) {
      if (t.inX < 0 || t.inY < 0 || t.inX + t.inW > W || t.inY + t.inH > H) allInvariants = false;
      if (t.inW > tileSize || t.inH > tileSize) allInvariants = false;
      if (t.cropX + t.outW > t.inW * 4 || t.cropY + t.outH > t.inH * 4) allInvariants = false;
      if (t.cropX < 0 || t.cropY < 0 || t.outW <= 0 || t.outH <= 0) allInvariants = false;
    }
    if (plan.outputWidth !== W * 4 || plan.outputHeight !== H * 4 || plan.total !== plan.tiles.length) allInvariants = false;
  }
}
check("tile cores exactly cover the output (no gaps/overlaps) for all cases", allCoverage);
check("tile output areas sum to the full output area", areaOk);
check("tile input regions stay in-bounds and within tileSize", allInvariants);
check("interior tiles use the full tile size", (() => {
  const plan = planTiles(1024, 768, { tileSize: 256, margin: 16, scale: 4 });
  return plan.tiles.some((t) => t.inW === 256 && t.inH === 256 && t.cropX === 64 && t.cropY === 64);
})());
check("single-tile plan for a small image", (() => {
  const plan = planTiles(100, 80, { tileSize: 256, margin: 16, scale: 4 });
  return plan.total === 1 && plan.tiles[0].inW === 100 && plan.tiles[0].outW === 400;
})());
check("scaledSize / outputPixels math",
  scaledSize(120, 80, 4).width === 480 && scaledSize(120, 80, 4).height === 320 && outputPixels(100, 50, 4) === 80000);
check("sizeForLongEdge lands exact long edges",
  JSON.stringify(sizeForLongEdge(120, 80, 3840)) === JSON.stringify({ width: 3840, height: 2560 }) &&
  JSON.stringify(sizeForLongEdge(1920, 1080, 7680)) === JSON.stringify({ width: 7680, height: 4320 }) &&
  JSON.stringify(sizeForLongEdge(800, 600, 800)) === JSON.stringify({ width: 800, height: 600 }));
check("output caps order sanely (mobile/low-memory are stricter)",
  outputCapFor({}) > outputCapFor({ isMobile: true }) &&
  outputCapFor({ isMobile: true }) > outputCapFor({ deviceMemoryGB: 2 }) &&
  outputCapFor({ deviceMemoryGB: 8 }) === outputCapFor({}));
check("budget check allows normal work and refuses tab-killers",
  checkOutputBudget(1000, 800, 4, {}).ok === true &&
  checkOutputBudget(12000, 9000, 4, { isMobile: true }).ok === false &&
  checkOutputBudget(1920, 1080, 4, {}).ok === true);

console.log("9) pass planning + browser-version honesty…");
const { planPasses } = window.__scalepress;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check("planPasses: original scale mode", eq(planPasses({ originalWidth: 120, originalHeight: 80 }, { target: "original", scale: 2 }), [2]));
check("planPasses: 4K from 2000px needs one 2x pass", eq(planPasses({ originalWidth: 2000, originalHeight: 1000 }, { target: "4k" }), [2]));
check("planPasses: 4K from 1000px needs one 4x pass", eq(planPasses({ originalWidth: 1000, originalHeight: 800 }, { target: "4k" }), [4]));
check("planPasses: 8K from 500px chains 4x then 2x", eq(planPasses({ originalWidth: 500, originalHeight: 400 }, { target: "8k" }), [4, 2]));
check("planPasses: already at target means no passes", eq(planPasses({ originalWidth: 4000, originalHeight: 3000 }, { target: "4k" }), []));

const config = await import(pathToFileURL(join(root, "js/config.js")).href);
check("no server backends remain in config", !("BACKENDS" in config) && !("SPACE_BASE_URL" in config));
check("model registry has general/max/anime, all 4x",
  ["general", "max", "anime"].every((id) => config.MODELS[id] && config.MODELS[id].scale === 4));
check("max model: fp16 HF source first, fp32 fallback second in our own HF repo",
  config.MODELS.max.sources.length === 2 &&
  config.MODELS.max.sources[0].dtype === "fp16" &&
  config.MODELS.max.sources[0].url.includes("huggingface.co") &&
  config.MODELS.max.sources[1].dtype === "fp32" &&
  config.MODELS.max.sources[1].url.includes("codewithkrrish/scalepress-models"));
check("ORT version is pinned", /^\d+\.\d+\.\d+$/.test(config.ORT_VERSION) && config.ORT_BUNDLE_URL.includes(config.ORT_VERSION));
check("face restore is explicitly unavailable", config.FACE_RESTORE_AVAILABLE === false);

const faceToggle = window.document.querySelector("#faceToggle");
const faceHint = window.document.querySelector("#faceHint");
check("face toggle is disabled", faceToggle.disabled === true && faceToggle.checked === false);
check("face hint says it is not available in the browser version", /not available in the browser version/.test(faceHint.textContent));
const modelValues = [...window.document.querySelectorAll("#modelSelect option")].map((o) => o.value);
check("model select offers general/max/anime (no face model)", eq(modelValues, ["general", "max", "anime"]));
const bodyText = window.document.body.textContent;
check("page copy has no server-era claims",
  !/Hugging Face server|free server|backup server|server is waking|free GPU server/i.test(bodyText));
check("page copy says processing is on-device", /on your device/i.test(bodyText));

console.log("10) ETA math: projections, blending, clamping, formatting…");
const eta = await import(pathToFileURL(join(root, "js/eta.js")).href);
const { estimateRemainingMs, EtaTracker, decayedEtaMs, formatEta, MAX_ETA_MS } = eta;
check("ETA: null before the first unit lands", estimateRemainingMs({ elapsedMs: 5000, done: 0, total: 10 }) === null);
check("ETA: null with no elapsed time", estimateRemainingMs({ elapsedMs: 0, done: 1, total: 10 }) === null);
check("ETA: null for a nonsensical total", estimateRemainingMs({ elapsedMs: 1000, done: 1, total: 0 }) === null);
check("ETA: exactly 0 at completion", estimateRemainingMs({ elapsedMs: 5000, done: 10, total: 10 }) === 0);
check("ETA: plain average projection", estimateRemainingMs({ elapsedMs: 10000, done: 5, total: 10 }) === 10000);
check("ETA: recent rate blends 50/50 with the overall average",
  estimateRemainingMs({ elapsedMs: 10000, done: 5, total: 20, recent: { elapsedMs: 5000, done: 4 } }) === 42857);
check("ETA: absurd projections clamp to the one-hour ceiling",
  estimateRemainingMs({ elapsedMs: 1000, done: 1, total: 100000 }) === MAX_ETA_MS);
check("ETA: never negative", estimateRemainingMs({ elapsedMs: 1000, done: 9, total: 10 }) >= 0);
const tracker = new EtaTracker();
check("tracker: null on the zero sample", tracker.sample(0, 0, 10) === null);
check("tracker: projects from the running average", tracker.sample(10000, 5, 10) === 10000);
check("tracker: progress going backwards resets the warmup", tracker.sample(11000, 2, 10) === null);
check("tracker: after a reset the window re-anchors", tracker.sample(21000, 7, 10) === 6000);
check("tracker: completion is 0", (() => {
  const t2 = new EtaTracker();
  t2.sample(0, 0, 4);
  t2.sample(2000, 2, 4);
  return t2.sample(4000, 4, 4) === 0;
})());
check("decayedEtaMs counts an estimate down as it ages",
  decayedEtaMs(20000, 1000, 6000) === 15000 && decayedEtaMs(5000, 1000, 9000) === 0 && decayedEtaMs(null, 1000, 6000) === null);
check("formatEta speaks in ~seconds and ~minutes left",
  formatEta(24000) === "~24s left" &&
  formatEta(80000) === "~1m 20s left" &&
  formatEta(400) === "~1s left" &&
  formatEta(0) === "~0s left" &&
  formatEta(null) === "");
const { stageLabel } = await import(pathToFileURL(join(root, "js/ui.js")).href);
check("stage label shows the countdown once an ETA exists",
  stageLabel("enhancing", { done: 3, total: 12, etaMs: 18000, etaAt: 100000 }, 100000) ===
    "Enhancing on your device — tile 3 of 12 · ~18s left");
check("stage label counts the ETA down between progress updates",
  stageLabel("enhancing", { done: 3, total: 12, etaMs: 18000, etaAt: 100000 }, 105000) ===
    "Enhancing on your device — tile 3 of 12 · ~13s left");
check("stage label omits the countdown before the first tile",
  stageLabel("enhancing", { done: 0, total: 12, etaMs: null }) === "Enhancing on your device — tile 0 of 12…");

console.log(failures.length ? `\nRESULT: FAIL (${failures.length})` : "\nRESULT: PASS");
process.exit(failures.length ? 1 : 0);
