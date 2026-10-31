/**
 * image.js — Small local image helpers.
 *
 * The AI work happens in the inference worker (js/worker.js). The
 * helpers here only do cheap, exact things the browser is good at:
 * reading dimensions, resizing a finished result to an exact target
 * size, and converting the download format (PNG / JPG / WebP). A plain
 * canvas resize is labelled as exactly that in the UI copy — it is
 * never passed off as AI upscaling.
 */

export const SUPPORTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/x-ms-bmp",
]);

export const FORMAT_TO_MIME = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export const MIME_TO_EXTENSION = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/gif": "gif",
};

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB — warn above this, still try.
export const HARD_MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB — reject; a browser tab cannot safely decode more.

export function isSupportedFile(file) {
  if (!file) return false;
  if (SUPPORTED_TYPES.has(file.type)) return true;
  // Some browsers hand back an empty MIME type for BMP files.
  return /\.(jpe?g|png|webp|bmp)$/i.test(file.name || "");
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function buildOutputName(originalName, outputMime, suffix = "enhanced") {
  const base = (originalName || "image").replace(/\.[^.]+$/, "");
  const ext = MIME_TO_EXTENSION[outputMime] || "png";
  return `${base}-${suffix}.${ext}`;
}

/**
 * Decode a Blob/File into a drawable source + intrinsic size.
 * Mirrors the PixelPress approach: createImageBitmap first, <img> fallback.
 */
export async function decodeBlob(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, cleanup: () => bitmap.close?.() };
    } catch {
      // Fall through — some variants decode in an Image element but not here.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not read this image. The file may be corrupt or unsupported."));
      el.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      cleanup: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error(`Your browser could not encode this image as ${mime.replace("image/", "").toUpperCase()}.`));
          return;
        }
        resolve(blob);
      },
      mime,
      quality,
    );
  });
}

function drawToCanvas(source, width, height, mime) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");
  if (mime === "image/jpeg") {
    // JPEG has no alpha; flatten onto white instead of black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

/**
 * Resize a finished image so its long edge is exactly `targetLongEdge`,
 * preserving aspect ratio. Used only to land a target preset (4K / 8K) on
 * an exact size after the AI passes — it does not add detail by itself.
 */
export async function resizeBlobToLongEdge(blob, targetLongEdge) {
  const decoded = await decodeBlob(blob);
  try {
    const longEdge = Math.max(decoded.width, decoded.height);
    if (longEdge === targetLongEdge) {
      return { blob, width: decoded.width, height: decoded.height };
    }
    const ratio = targetLongEdge / longEdge;
    const width = Math.max(1, Math.round(decoded.width * ratio));
    const height = Math.max(1, Math.round(decoded.height * ratio));
    const canvas = drawToCanvas(decoded.source, width, height, "image/png");
    const out = await canvasToBlob(canvas, "image/png", undefined);
    return { blob: out, width, height };
  } finally {
    decoded.cleanup();
  }
}

/**
 * Convert a blob to the requested download format. Returns the original
 * blob untouched when it already matches, so PNG stays byte-identical.
 */
export async function convertBlob(blob, format) {
  const mime = FORMAT_TO_MIME[format] || "image/png";
  if ((blob.type || "image/png") === mime) return { blob, mime };
  const decoded = await decodeBlob(blob);
  try {
    const canvas = drawToCanvas(decoded.source, decoded.width, decoded.height, mime);
    const quality = mime === "image/png" ? undefined : 0.92;
    const out = await canvasToBlob(canvas, mime, quality);
    return { blob: out, mime };
  } finally {
    decoded.cleanup();
  }
}

/** Read just the pixel dimensions of a blob, then release the decode. */
export async function probeSize(blob) {
  const decoded = await decodeBlob(blob);
  try {
    return { width: decoded.width, height: decoded.height };
  } finally {
    decoded.cleanup();
  }
}
