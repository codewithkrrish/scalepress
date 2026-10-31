/**
 * ui.js — All DOM rendering for ScalePress.
 *
 * app.js owns state, api.js owns the network, this module owns markup.
 * User-controlled text (file names) always goes through textContent.
 */

import { formatBytes, formatDuration } from "./image.js";
import { formatEta, decayedEtaMs } from "./eta.js";

export function createElement(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

const STAGE_LABELS = {
  waiting: "Waiting in your queue…",
  "downloading-model": "Downloading the AI model (first time only)…",
  "loading-model": "Loading the AI model on your device…",
  enhancing: "Enhancing on your device…",
  finalizing: "Finishing up…",
  resizing: "Adjusting to the exact target size…",
};

/**
 * The live time-left text for a stage detail, or "" when there is no
 * honest estimate yet. detail.etaMs is the estimate api.js computed;
 * detail.etaAt is when it was computed (stamped by app.js), so the
 * value counts down between progress events instead of freezing.
 * While work remains it never displays below ~1s.
 */
function etaText(detail, now) {
  const etaMs = decayedEtaMs(detail?.etaMs, detail?.etaAt, now);
  if (etaMs == null) return "";
  return formatEta(Math.max(1000, etaMs));
}

export function stageLabel(stage, detail, now = Date.now()) {
  if (stage === "enhancing" && detail && detail.total > 0) {
    const eta = etaText(detail, now);
    return eta
      ? `Enhancing on your device — tile ${detail.done} of ${detail.total} · ${eta}`
      : `Enhancing on your device — tile ${detail.done} of ${detail.total}…`;
  }
  if (stage === "downloading-model" && detail && detail.total > 0 && detail.loaded > 0) {
    const pct = Math.min(99, Math.round((detail.loaded / detail.total) * 100));
    const eta = etaText(detail, now);
    return eta
      ? `Downloading the AI model — ${pct}% · ${eta} (first time only)…`
      : `Downloading the AI model — ${pct}% (first time only)…`;
  }
  return STAGE_LABELS[stage] || "Enhancing on your device…";
}

export function buildCard(entry, { onRemove, onDownload, onCompare, onRetry }) {
  const card = createElement("article", "card");
  card.dataset.id = entry.id;
  if (entry.status === "error") card.classList.add("is-error");

  const thumbBtn = createElement("button", "card-thumb");
  thumbBtn.type = "button";
  thumbBtn.setAttribute("aria-label", `Compare original and enhanced for ${entry.file.name}`);
  const thumbImg = document.createElement("img");
  thumbImg.alt = "";
  thumbImg.loading = "lazy";
  if (entry.thumbnailUrl) thumbImg.src = entry.thumbnailUrl;
  thumbBtn.append(thumbImg, createElement("span", "compare-hint", "Compare"));
  thumbBtn.addEventListener("click", () => onCompare(entry.id));
  card.appendChild(thumbBtn);

  const body = createElement("div", "card-body");

  const titleWrap = document.createElement("div");
  const name = createElement("div", "card-name", entry.file.name);
  name.title = entry.file.name;
  const meta = createElement("div", "card-meta");
  meta.dataset.role = "meta";
  titleWrap.append(name, meta);
  body.appendChild(titleWrap);

  const sizeRow = createElement("div", "size-row");
  const beforeBox = createElement("div", "size-box");
  beforeBox.append(createElement("span", "", "Original"), createElement("strong", "", formatBytes(entry.file.size)));
  const arrow = createElement("div", "size-arrow", "→");
  arrow.setAttribute("aria-hidden", "true");
  const afterBox = createElement("div", "size-box");
  afterBox.append(createElement("span", "", "Enhanced"), createElement("strong", "", "—"));
  afterBox.dataset.role = "output-size";
  const gain = createElement("div", "savings is-neutral", "…");
  gain.dataset.role = "gain";
  sizeRow.append(beforeBox, arrow, afterBox);
  const sizeWrap = document.createElement("div");
  sizeWrap.append(sizeRow, gain);
  gain.style.marginTop = "0.45rem";
  gain.style.textAlign = "right";
  body.appendChild(sizeWrap);

  const status = createElement("div", "card-status");
  status.dataset.role = "status";
  body.appendChild(status);

  const actions = createElement("div", "card-actions");
  const retryBtn = createElement("button", "btn btn-secondary btn-small", "Retry");
  retryBtn.type = "button";
  retryBtn.dataset.role = "retry";
  retryBtn.addEventListener("click", () => onRetry(entry.id));
  const downloadBtn = createElement("button", "btn btn-primary btn-small", "Download");
  downloadBtn.type = "button";
  downloadBtn.dataset.role = "download";
  downloadBtn.addEventListener("click", () => onDownload(entry.id));
  const removeBtn = createElement("button", "icon-btn", "×");
  removeBtn.type = "button";
  removeBtn.title = "Remove image";
  removeBtn.setAttribute("aria-label", `Remove ${entry.file.name}`);
  removeBtn.addEventListener("click", () => onRemove(entry.id));
  actions.append(retryBtn, downloadBtn, removeBtn);
  body.appendChild(actions);

  card.appendChild(body);
  updateCard(card, entry);
  return card;
}

export function updateCard(card, entry) {
  if (!card) return;
  card.classList.toggle("is-error", entry.status === "error");

  const meta = card.querySelector('[data-role="meta"]');
  if (meta) {
    if (entry.originalWidth && entry.originalHeight) {
      const out =
        entry.outputWidth && entry.outputHeight && entry.status === "done"
          ? ` · Output ${entry.outputWidth} × ${entry.outputHeight}`
          : "";
      meta.textContent = `${entry.originalWidth} × ${entry.originalHeight}${out}`;
    } else {
      meta.textContent = entry.status === "error" ? "Could not be processed" : "Reading image…";
    }
  }

  const outputSize = card.querySelector('[data-role="output-size"] strong');
  if (outputSize) outputSize.textContent = entry.outputBlob ? formatBytes(entry.outputBlob.size) : "—";

  const gain = card.querySelector('[data-role="gain"]');
  if (gain) {
    if (entry.status === "done" && entry.originalWidth && entry.outputWidth) {
      const factor = entry.outputWidth / entry.originalWidth;
      gain.textContent = `${factor.toFixed(1)}x larger`;
      gain.className = "savings is-positive";
    } else if (entry.status === "error") {
      gain.textContent = "—";
      gain.className = "savings is-neutral";
    } else {
      gain.textContent = "…";
      gain.className = "savings is-neutral";
    }
  }

  const status = card.querySelector('[data-role="status"]');
  if (status) {
    status.textContent = "";
    status.classList.toggle("is-error", entry.status === "error");
    if (entry.status === "processing") {
      const spinner = createElement("span", "spinner");
      spinner.setAttribute("aria-hidden", "true");
      const elapsed = entry.startedAt ? formatDuration(Date.now() - entry.startedAt) : "";
      status.append(spinner, document.createTextNode(stageLabel(entry.stage, entry.stageDetail)));
      if (elapsed) {
        const time = createElement("span", "card-elapsed", elapsed);
        status.appendChild(time);
      }
    } else if (entry.status === "error") {
      status.textContent = entry.errorMessage || "Something went wrong with this file.";
    } else if (entry.status === "done") {
      const took = entry.elapsedMs ? ` · took ${formatDuration(entry.elapsedMs)}` : "";
      status.textContent = `Ready${took}`;
    } else {
      status.textContent = "Waiting…";
    }
  }

  const downloadBtn = card.querySelector('[data-role="download"]');
  if (downloadBtn) downloadBtn.disabled = entry.status !== "done";
  const retryBtn = card.querySelector('[data-role="retry"]');
  if (retryBtn) retryBtn.hidden = entry.status !== "error";

  const thumbImg = card.querySelector(".card-thumb img");
  const preferred = entry.outputUrl || entry.thumbnailUrl;
  if (thumbImg && preferred && thumbImg.src !== preferred) thumbImg.src = preferred;
}

export function updateStats({ statsEl, entries }) {
  if (!statsEl) return;
  const done = entries.filter((e) => e.status === "done" && e.outputBlob);
  statsEl.textContent = "";
  const mk = (label, value, cls) => {
    const span = document.createElement("span");
    span.append(document.createTextNode(`${label} `));
    span.appendChild(createElement("strong", cls || "", value));
    return span;
  };
  const processing = entries.filter((e) => e.status === "processing").length;
  statsEl.append(mk("Images", String(entries.length)), mk("Enhanced", String(done.length)));
  if (processing) {
    statsEl.appendChild(mk("Working on", String(processing)));
    // Jobs run one at a time, so at most one entry carries a live ETA.
    const active = entries.find((e) => e.status === "processing");
    const eta = active?.stageDetail ? etaText(active.stageDetail, Date.now()) : "";
    if (eta) {
      const span = document.createElement("span");
      span.textContent = `· ${eta}`;
      statsEl.appendChild(span);
    }
  }
}

/* ---------- Comparison modal (with zoom) ---------- */

export class CompareModal {
  constructor(root) {
    this.root = root;
    this.backdrop = root;
    this.imageOriginal = root.querySelector("[data-compare-original]");
    this.imageEnhanced = root.querySelector("[data-compare-enhanced]");
    this.afterWrap = root.querySelector("[data-compare-after]");
    this.divider = root.querySelector("[data-compare-divider]");
    this.handle = root.querySelector("[data-compare-handle]");
    this.range = root.querySelector("[data-compare-range]");
    this.title = root.querySelector("[data-modal-title]");
    this.sub = root.querySelector("[data-modal-sub]");
    this.stage = root.querySelector("[data-compare-stage]");
    this.zoomRange = root.querySelector("[data-zoom-range]");
    this.zoomLabel = root.querySelector("[data-zoom-label]");
    this.entryId = null;
    this.position = 50;
    this._bind();
  }

  _bind() {
    this.range.addEventListener("input", () => this.setPosition(Number(this.range.value)));

    let dragging = false;
    const moveFromEvent = (event) => {
      const rect = this.stage.getBoundingClientRect();
      const x = (event.touches ? event.touches[0].clientX : event.clientX) - rect.left;
      const pct = Math.min(100, Math.max(0, (x / rect.width) * 100));
      this.setPosition(pct);
      this.range.value = String(Math.round(pct));
    };
    this.stage.addEventListener("pointerdown", (e) => {
      dragging = true;
      this.stage.setPointerCapture?.(e.pointerId);
      moveFromEvent(e);
    });
    this.stage.addEventListener("pointermove", (e) => dragging && moveFromEvent(e));
    this.stage.addEventListener("pointerup", () => (dragging = false));
    this.stage.addEventListener("pointercancel", () => (dragging = false));

    if (this.zoomRange) {
      this.zoomRange.addEventListener("input", () => this.setZoom(Number(this.zoomRange.value)));
    }

    this.backdrop.addEventListener("click", (e) => {
      if (e.target === this.backdrop) this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.backdrop.classList.contains("is-open")) this.close();
    });
    this.root.querySelectorAll("[data-close-modal]").forEach((btn) => btn.addEventListener("click", () => this.close()));
  }

  setPosition(pct) {
    this.position = pct;
    this.afterWrap.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    this.divider.style.left = `${pct}%`;
    this.handle.style.left = `${pct}%`;
  }

  setZoom(percent) {
    // Zoom widens the stage inside a scrolling wrap, so the comparison
    // slider geometry stays proportional while detail gets inspectable.
    this.stage.style.width = `${percent}%`;
    if (this.zoomLabel) this.zoomLabel.textContent = `${percent}%`;
  }

  open(entry) {
    if (!entry || !entry.originalUrl || !entry.outputUrl) return;
    this.entryId = entry.id;
    this.title.textContent = entry.file.name;
    this.sub.textContent =
      `${entry.originalWidth} × ${entry.originalHeight} original · ` +
      `${entry.outputWidth} × ${entry.outputHeight} enhanced`;
    this.imageOriginal.src = entry.originalUrl;
    this.imageEnhanced.src = entry.outputUrl;
    this.setPosition(50);
    this.range.value = "50";
    if (this.zoomRange) this.zoomRange.value = "100";
    this.setZoom(100);
    this.backdrop.classList.add("is-open");
    this.backdrop.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    this.handle.focus();
  }

  close() {
    this.backdrop.classList.remove("is-open");
    this.backdrop.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    this.imageOriginal.removeAttribute("src");
    this.imageEnhanced.removeAttribute("src");
  }
}

export function showToast(region, message, isSuccess = false) {
  if (!region) return;
  const toast = createElement("div", `toast${isSuccess ? " is-success" : ""}`, message);
  toast.setAttribute("role", "status");
  region.appendChild(toast);
  window.setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s";
    window.setTimeout(() => toast.remove(), 320);
  }, 4200);
}
