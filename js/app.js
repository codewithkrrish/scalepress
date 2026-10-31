/**
 * app.js — ScalePress application wiring and state.
 *
 * State model: a Map<id, Entry> is the single source of truth, same as
 * PixelPress. The work itself runs through api.js into the on-device
 * inference worker (js/engine.js): the AI model runs in the visitor's
 * own browser, nothing is uploaded anywhere. Entries are processed
 * strictly one at a time — there is exactly one worker and one
 * device GPU/CPU, and parallel jobs would only fight over it.
 *
 * Entry = {
 *   id, file,
 *   originalUrl, outputUrl, outputBlob,
 *   originalWidth, originalHeight, outputWidth, outputHeight,
 *   status: "pending" | "processing" | "done" | "error",
 *   stage, startedAt, elapsedMs, errorMessage,
 *   convertedCache: { key, blob, name } | null
 * }
 */

import { upscaleOnce, ApiError } from "./api.js";
import {
  isSupportedFile,
  formatBytes,
  buildOutputName,
  convertBlob,
  probeSize,
  resizeBlobToLongEdge,
  FORMAT_TO_MIME,
  MAX_FILE_BYTES,
  HARD_MAX_FILE_BYTES,
} from "./image.js";
import { buildCard, updateCard, updateStats, CompareModal, showToast } from "./ui.js";

const $ = (selector) => document.querySelector(selector);

const els = {
  dropzone: $("#dropzone"),
  fileInput: $("#fileInput"),
  model: $("#modelSelect"),
  scale: $("#scaleSelect"),
  target: $("#targetSelect"),
  face: $("#faceToggle"),
  faceHint: $("#faceHint"),
  format: $("#formatSelect"),
  enhanceBtn: $("#enhanceBtn"),
  grid: $("#resultsGrid"),
  emptyState: $("#emptyState"),
  toolbar: $("#resultsToolbar"),
  stats: $("#stats"),
  downloadAllBtn: $("#downloadAllBtn"),
  clearAllBtn: $("#clearAllBtn"),
  modalRoot: $("#compareModal"),
  modalDownloadBtn: $("#modalDownloadBtn"),
  toastRegion: $("#toastRegion"),
};

const ACCEPTED_LABEL = "JPG, PNG, WebP or BMP";
const TARGET_LONG_EDGE = { "4k": 3840, "8k": 7680 };

/** @type {Map<string, object>} */
const entries = new Map();
let modal = null;
let queueRunning = false;
let elapsedTimer = null;

function createId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getSettings() {
  const model = els.model.value;
  return {
    model,
    scale: Number(els.scale.value) || 2,
    target: els.target.value, // "original" | "4k" | "8k"
    // Face restore is not available in the browser version; the toggle
    // is disabled in the UI and this stays false (api.js ignores it).
    faceEnhance: els.face.checked,
    format: els.format.value, // download format: "png" | "jpeg" | "webp"
  };
}

function refreshChrome() {
  const hasEntries = entries.size > 0;
  els.emptyState.hidden = hasEntries;
  els.toolbar.classList.toggle("is-visible", hasEntries);
  const doneCount = [...entries.values()].filter((e) => e.status === "done").length;
  const pendingCount = [...entries.values()].filter((e) => e.status === "pending").length;
  els.downloadAllBtn.disabled = doneCount === 0;
  els.downloadAllBtn.textContent = doneCount > 1 ? `Download all (${doneCount})` : "Download all";
  els.enhanceBtn.disabled = pendingCount === 0;
  els.enhanceBtn.textContent = queueRunning
    ? "Enhancing…"
    : pendingCount > 0
      ? `Enhance ${pendingCount} image${pendingCount > 1 ? "s" : ""}`
      : "Enhance images";
  updateStats({ statsEl: els.stats, entries: [...entries.values()] });
}

function cardFor(entry) {
  return els.grid.querySelector(`[data-id="${CSS.escape(entry.id)}"]`);
}

function revokeEntryUrls(entry) {
  const urls = new Set([entry.originalUrl, entry.outputUrl].filter(Boolean));
  for (const url of urls) URL.revokeObjectURL(url);
  entry.originalUrl = null;
  entry.outputUrl = null;
}

/* ---------- Processing queue ---------- */

function syncElapsedTicker() {
  const anyProcessing = [...entries.values()].some((e) => e.status === "processing");
  if (anyProcessing && !elapsedTimer) {
    elapsedTimer = window.setInterval(() => {
      for (const entry of entries.values()) {
        if (entry.status === "processing") updateCard(cardFor(entry), entry);
      }
      // Keep the stats bar's time-left estimate counting down too.
      updateStats({ statsEl: els.stats, entries: [...entries.values()] });
      syncElapsedTicker();
    }, 1000);
  } else if (!anyProcessing && elapsedTimer) {
    window.clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

/**
 * Decide the API passes for one entry.
 * - Plain scale mode: one pass at the chosen scale.
 * - Target mode (4K / 8K): enough passes to reach or pass the target long
 *   edge (4x, then a second 2x pass = 8x for 8K from small sources), then
 *   app.js lands the exact size with a final canvas resize. If the source
 *   already meets the target, no AI pass is wasted — the entry is marked
 *   honestly and skipped.
 */
function planPasses(entry, settings) {
  if (settings.target === "original") return [settings.scale];
  const targetLong = TARGET_LONG_EDGE[settings.target];
  const sourceLong = Math.max(entry.originalWidth || 0, entry.originalHeight || 0);
  if (!sourceLong || sourceLong >= targetLong) return [];
  const needed = targetLong / sourceLong;
  if (needed <= 2) return [2];
  if (needed <= 4) return [4];
  return [4, 2];
}

async function processEntry(entry, settings) {
  entry.status = "processing";
  entry.stage = "waiting";
  entry.stageDetail = null;
  entry.errorMessage = null;
  entry.startedAt = Date.now();
  entry.elapsedMs = null;
  updateCard(cardFor(entry), entry);
  refreshChrome();
  syncElapsedTicker();

  const setStage = (stage, detail) => {
    entry.stage = stage;
    // Stamp when an ETA was computed so the 1s ticker can count the
    // displayed value down between progress events (see js/eta.js
    // decayedEtaMs and ui.stageLabel).
    entry.stageDetail =
      detail && typeof detail.etaMs === "number" ? { ...detail, etaAt: Date.now() } : detail || null;
    updateCard(cardFor(entry), entry);
  };

  try {
    const passes = planPasses(entry, settings);
    if (!passes.length) {
      entry.status = "error";
      entry.errorMessage =
        "This image already meets the selected target size, so there is nothing to upscale. Pick a larger target or use a scale mode.";
      return;
    }

    // Job context for api.js's whole-job ETA: each pass's input size.
    // Pass i's output becomes pass i+1's input, at the requested scale.
    const jobPasses = [];
    let passW = entry.originalWidth;
    let passH = entry.originalHeight;
    for (const s of passes) {
      jobPasses.push({ width: passW, height: passH });
      passW = passW ? passW * s : null;
      passH = passH ? passH * s : null;
    }
    const job = { id: entry.id, passes: jobPasses };

    let currentBlob = entry.file;
    for (let i = 0; i < passes.length; i += 1) {
      const passLabel = passes.length > 1 ? ` (pass ${i + 1} of ${passes.length})` : "";
      const result = await upscaleOnce(
        currentBlob,
        { model: settings.model, scale: passes[i], faceEnhance: settings.faceEnhance },
        {
          onStage: (stage, detail) => setStage(stage, detail),
          job,
        },
      );
      currentBlob = result.blob;
      if (passLabel) showToast(els.toastRegion, `${entry.file.name}: ${passLabel.trim()} finished.`);
    }

    let finalBlob = currentBlob;
    let size = await probeSize(finalBlob).catch(() => ({ width: null, height: null }));

    if (settings.target !== "original") {
      const targetLong = TARGET_LONG_EDGE[settings.target];
      const longEdge = size.width ? Math.max(size.width, size.height) : 0;
      if (longEdge && longEdge !== targetLong) {
        setStage("resizing");
        const resized = await resizeBlobToLongEdge(finalBlob, targetLong);
        finalBlob = resized.blob;
        size = { width: resized.width, height: resized.height };
      }
    }

    if (entry.outputUrl) URL.revokeObjectURL(entry.outputUrl);
    entry.outputBlob = finalBlob;
    entry.outputUrl = URL.createObjectURL(finalBlob);
    entry.outputMime = finalBlob.type || "image/png";
    entry.outputWidth = size.width;
    entry.outputHeight = size.height;
    entry.convertedCache = null;
    entry.status = "done";
  } catch (err) {
    entry.status = "error";
    entry.outputBlob = null;
    entry.errorMessage =
      err instanceof ApiError || err instanceof Error
        ? err.message
        : "Enhancement failed for an unknown reason. Please retry.";
  } finally {
    entry.elapsedMs = entry.startedAt ? Date.now() - entry.startedAt : null;
    updateCard(cardFor(entry), entry);
    refreshChrome();
    syncElapsedTicker();
  }
}

async function runQueue() {
  if (queueRunning) return;
  const next = [...entries.values()].find((e) => e.status === "pending");
  if (!next) {
    refreshChrome();
    return;
  }
  queueRunning = true;
  refreshChrome();
  try {
    // Settings are read per entry, so a change mid-queue applies to the
    // images that have not started yet — the least surprising behaviour.
    await processEntry(next, getSettings());
  } finally {
    queueRunning = false;
    refreshChrome();
    // Sequential by design: one job on the device at a time.
    runQueue();
  }
}

/* ---------- Intake ---------- */

function filesFromDataTransfer(dt) {
  if (!dt) return [];
  if (dt.files?.length) return [...dt.files];
  return [...(dt.items || [])]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;

  let added = 0;
  let skipped = 0;
  let warnedLarge = 0;

  for (const file of files) {
    const entry = {
      id: createId(),
      file,
      originalUrl: null,
      outputUrl: null,
      outputBlob: null,
      outputMime: null,
      originalWidth: null,
      originalHeight: null,
      outputWidth: null,
      outputHeight: null,
      status: "pending",
      stage: "waiting",
      stageDetail: null,
      startedAt: null,
      elapsedMs: null,
      errorMessage: null,
      convertedCache: null,
    };

    if (!isSupportedFile(file)) {
      entry.status = "error";
      entry.errorMessage = `Unsupported file type. ScalePress accepts ${ACCEPTED_LABEL}.`;
      skipped += 1;
    } else if (file.size > HARD_MAX_FILE_BYTES) {
      entry.status = "error";
      entry.errorMessage = `This file is ${formatBytes(file.size)}. Files over ${formatBytes(HARD_MAX_FILE_BYTES)} are refused — a browser tab cannot safely decode them. Compress or resize it first (PixelPress works for that).`;
      skipped += 1;
    } else {
      if (file.size > MAX_FILE_BYTES) warnedLarge += 1;
      entry.originalUrl = URL.createObjectURL(file);
      try {
        const size = await probeSize(file);
        entry.originalWidth = size.width;
        entry.originalHeight = size.height;
      } catch {
        entry.status = "error";
        entry.errorMessage = "Could not read this image. The file may be corrupt or in an unsupported variant.";
      }
      added += 1;
    }

    entries.set(entry.id, entry);
    els.grid.appendChild(buildCard(entry, handlers));
  }

  refreshChrome();
  if (skipped) showToast(els.toastRegion, `${skipped} file${skipped > 1 ? "s were" : " was"} skipped — see the card for why.`);
  if (warnedLarge) {
    showToast(els.toastRegion, "Large files can take several minutes to enhance on your device. Smaller inputs are faster.");
  }
  if (added) {
    showToast(els.toastRegion, `${added} image${added > 1 ? "s" : ""} added. Press Enhance when you are ready.`, true);
  }
}

function removeEntry(id) {
  const entry = entries.get(id);
  if (!entry) return;
  if (entry.status === "processing") {
    showToast(els.toastRegion, "That image is being enhanced right now. Wait for it to finish before removing it.");
    return;
  }
  if (modal && modal.entryId === id) modal.close();
  revokeEntryUrls(entry);
  entries.delete(id);
  cardFor(entry)?.remove();
  refreshChrome();
}

function clearAll() {
  if ([...entries.values()].some((e) => e.status === "processing")) {
    showToast(els.toastRegion, "An image is being enhanced right now. Wait for it to finish before clearing.");
    return;
  }
  if (modal) modal.close();
  for (const entry of entries.values()) revokeEntryUrls(entry);
  entries.clear();
  els.grid.textContent = "";
  refreshChrome();
}

function retryEntry(id) {
  const entry = entries.get(id);
  if (!entry || entry.status !== "error") return;
  // A "nothing to upscale" error will fail again with the same settings;
  // retrying is still the user's call, so just requeue it.
  entry.status = "pending";
  entry.errorMessage = null;
  updateCard(cardFor(entry), entry);
  refreshChrome();
  runQueue();
}

/* ---------- Downloads ---------- */

function triggerDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Resolve the blob to actually download for an entry, applying the chosen
 * output format. Conversions are cached per entry+format so ZIP building
 * and repeat downloads do not re-encode every time.
 */
async function downloadBlobFor(entry) {
  const format = els.format.value;
  const mime = FORMAT_TO_MIME[format] || "image/png";
  if ((entry.outputBlob.type || "image/png") === mime) {
    return { blob: entry.outputBlob, name: buildOutputName(entry.file.name, mime) };
  }
  const key = format;
  if (entry.convertedCache?.key === key) return entry.convertedCache.value;
  const converted = await convertBlob(entry.outputBlob, format);
  const value = { blob: converted.blob, name: buildOutputName(entry.file.name, converted.mime) };
  entry.convertedCache = { key, value };
  return value;
}

async function downloadEntry(id) {
  const entry = entries.get(id);
  if (!entry || entry.status !== "done" || !entry.outputBlob) return;
  try {
    const { blob, name } = await downloadBlobFor(entry);
    const url = URL.createObjectURL(blob);
    triggerDownload(url, name);
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    showToast(els.toastRegion, err instanceof Error ? err.message : "Download failed.");
  }
}

async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return window.JSZip || null;
}

async function downloadAll() {
  const done = [...entries.values()].filter((e) => e.status === "done" && e.outputBlob);
  if (!done.length) return;
  if (done.length === 1) {
    downloadEntry(done[0].id);
    return;
  }
  els.downloadAllBtn.disabled = true;
  const originalLabel = els.downloadAllBtn.textContent;
  els.downloadAllBtn.textContent = "Preparing ZIP…";
  try {
    const JSZipCtor = await loadJSZip();
    if (!JSZipCtor) throw new Error("JSZip unavailable");
    const zip = new JSZipCtor();
    const usedNames = new Set();
    for (const entry of done) {
      const { blob, name: wanted } = await downloadBlobFor(entry);
      let name = wanted;
      let counter = 2;
      while (usedNames.has(name)) {
        name = wanted.replace(/(\.[^.]+)$/, `-${counter++}$1`);
      }
      usedNames.add(name);
      zip.file(name, blob);
    }
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, "scalepress-images.zip");
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast(els.toastRegion, `${done.length} images downloaded as a ZIP.`, true);
  } catch {
    showToast(els.toastRegion, "ZIP was unavailable, so the files will download one by one.");
    done.forEach((entry, index) => {
      window.setTimeout(() => downloadEntry(entry.id), index * 350);
    });
  } finally {
    els.downloadAllBtn.textContent = originalLabel;
    refreshChrome();
  }
}

const handlers = {
  onRemove: removeEntry,
  onDownload: downloadEntry,
  onRetry: retryEntry,
  onCompare: (id) => {
    const entry = entries.get(id);
    if (entry && entry.status === "done") modal.open(entry);
    else if (entry && entry.status === "error") {
      showToast(els.toastRegion, "This image could not be enhanced, so there is nothing to compare yet.");
    } else {
      showToast(els.toastRegion, "Still working on this one — compare opens once it is done.");
    }
  },
};

function syncFaceHint() {
  // Face restore (GFPGAN) is not available in the browser version —
  // the toggle stays disabled and the hint says so plainly. See
  // config.js / DEPLOY.md for the evidence behind that call.
  els.face.checked = false;
  els.face.disabled = true;
  els.faceHint.textContent =
    "Face restore is not available in the browser version yet — the GFPGAN model is too large and has no reliable on-device build. The upscale itself still sharpens faces.";
}

/* ---------- Wiring ---------- */

function init() {
  modal = new CompareModal(els.modalRoot);
  els.modalDownloadBtn.addEventListener("click", () => {
    if (modal.entryId) downloadEntry(modal.entryId);
  });

  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener("change", () => {
    addFiles(els.fileInput.files);
    els.fileInput.value = "";
  });

  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  for (const evt of ["dragenter", "dragover"]) {
    els.dropzone.addEventListener(evt, (e) => {
      stop(e);
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      els.dropzone.classList.add("is-dragover");
    });
  }
  els.dropzone.addEventListener("dragleave", (e) => {
    stop(e);
    if (e.relatedTarget && els.dropzone.contains(e.relatedTarget)) return;
    els.dropzone.classList.remove("is-dragover");
  });
  els.dropzone.addEventListener("drop", (e) => {
    stop(e);
    els.dropzone.classList.remove("is-dragover");
    document.body.classList.remove("is-dragging");
    const files = filesFromDataTransfer(e.dataTransfer);
    if (files.length) addFiles(files);
  });

  window.addEventListener("dragenter", () => document.body.classList.add("is-dragging"));
  window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) document.body.classList.remove("is-dragging");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.classList.remove("is-dragging");
    const files = filesFromDataTransfer(e.dataTransfer);
    if (files.length) addFiles(files);
  });
  document.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) addFiles(files);
  });

  els.model.addEventListener("change", syncFaceHint);
  els.enhanceBtn.addEventListener("click", runQueue);
  els.downloadAllBtn.addEventListener("click", downloadAll);
  els.clearAllBtn.addEventListener("click", clearAll);

  syncFaceHint();
  refreshChrome();

  window.__scalepress = { entries, runQueue, planPasses };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
