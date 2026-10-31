/**
 * tiling.js — Pure tiling and size math for the on-device upscaler.
 *
 * No DOM, no worker APIs, no imports: everything here is plain
 * arithmetic so tests/harness.mjs can verify it exhaustively in Node.
 *
 * The model is a fixed 4x network. Large images cannot go through it
 * in one shot (a 4x output of a 24 MP photo would need hundreds of MB
 * of tensor memory), so the image is processed in square input tiles.
 * Each tile is responsible for a "core" rectangle of the image; the
 * cores partition the image exactly. Around its core, a tile also
 * reads a margin of neighbouring pixels (clamped at the image edges)
 * so the network has context at the seams — the margin's output is
 * discarded, only the core's output is kept. Because the kept regions
 * partition the output exactly, stitching is a plain drawImage per
 * tile with no blending weights and no double-painted pixels.
 */

/** Every model ScalePress ships is a 4x network. */
export const MODEL_SCALE = 4;

/**
 * Plan the tiles for one image.
 *
 * @param {number} width   input width in px (>= 1)
 * @param {number} height  input height in px (>= 1)
 * @param {{tileSize?: number, margin?: number, scale?: number}} [opts]
 *   tileSize — max input-side length of a tile, margins included.
 *   margin   — input-space context margin around each core
 *              (>= 4 input px = >= 16 output px of overlap between
 *              neighbouring tile outputs; 16 is the default).
 *   scale    — model upscale factor (4 for all current models).
 * @returns {{tiles: Array<object>, cols: number, rows: number,
 *            total: number, stride: number, outputWidth: number,
 *            outputHeight: number}}
 * Each tile: {
 *   inX, inY, inW, inH,        // input region fed to the model
 *   cropX, cropY,              // offset into the tile's output where
 *                              // the kept (core) region starts
 *   outX, outY, outW, outH     // destination rect in the output image
 * }
 * Invariants (all unit-tested):
 *  - the out rects are disjoint and exactly cover the output image;
 *  - in regions stay inside the image;
 *  - cropX + outW <= inW * scale and cropY + outH <= inH * scale.
 */
export function planTiles(width, height, { tileSize = 256, margin = 16, scale = MODEL_SCALE } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`planTiles: bad image size ${width}x${height}`);
  }
  if (!(tileSize > 2 * margin) || margin < 0) {
    throw new RangeError(`planTiles: tileSize ${tileSize} must exceed 2*margin ${margin}`);
  }
  const stride = tileSize - 2 * margin;
  const cols = Math.ceil(width / stride);
  const rows = Math.ceil(height / stride);
  const tiles = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const coreX0 = col * stride;
      const coreY0 = row * stride;
      const coreX1 = Math.min(width, coreX0 + stride);
      const coreY1 = Math.min(height, coreY0 + stride);
      const inX = Math.max(0, coreX0 - margin);
      const inY = Math.max(0, coreY0 - margin);
      const inX1 = Math.min(width, coreX1 + margin);
      const inY1 = Math.min(height, coreY1 + margin);
      tiles.push({
        inX,
        inY,
        inW: inX1 - inX,
        inH: inY1 - inY,
        cropX: (coreX0 - inX) * scale,
        cropY: (coreY0 - inY) * scale,
        outX: coreX0 * scale,
        outY: coreY0 * scale,
        outW: (coreX1 - coreX0) * scale,
        outH: (coreY1 - coreY0) * scale,
      });
    }
  }
  return {
    tiles,
    cols,
    rows,
    total: tiles.length,
    stride,
    outputWidth: width * scale,
    outputHeight: height * scale,
  };
}

/** Output dimensions of one model pass at the given scale factor. */
export function scaledSize(width, height, scale) {
  return { width: width * scale, height: height * scale };
}

/** Pixels in the output of one pass — the number the memory cap checks. */
export function outputPixels(width, height, scale) {
  return width * scale * height * scale;
}

/**
 * Device-safe cap on the pixels of a single pass's output canvas.
 * The output canvas costs ~4 bytes/px in the browser (plus a second
 * buffer while encoding), and a mid-range phone tab dies somewhere
 * between 100 and 200 MB of canvas. These caps keep the worst case
 * comfortably below that while leaving 8K (33 MP) reachable on
 * everything and a 4x pass on a 12 MP photo (192 MP) refused with a
 * clear message instead of a silent tab crash.
 *
 * @param {{deviceMemoryGB?: number|null, isMobile?: boolean}} hints
 * @returns {number} max output pixels for one pass
 */
export function outputCapFor({ deviceMemoryGB = null, isMobile = false } = {}) {
  let cap = 100 * 1024 * 1024; // ~100 MP — roomy desktop default
  if (isMobile) cap = Math.min(cap, 40 * 1024 * 1024);
  if (deviceMemoryGB != null) {
    if (deviceMemoryGB <= 2) cap = Math.min(cap, 25 * 1024 * 1024);
    else if (deviceMemoryGB <= 4) cap = Math.min(cap, 50 * 1024 * 1024);
  }
  return cap;
}

/**
 * Check a planned pass against the cap.
 * @returns {{ok: boolean, pixels: number, cap: number}}
 */
export function checkOutputBudget(width, height, scale, hints) {
  const pixels = outputPixels(width, height, scale);
  const cap = outputCapFor(hints);
  return { ok: pixels <= cap, pixels, cap };
}

/**
 * Dimensions after landing an image on an exact long-edge target
 * (the 4K / 8K presets): scale so the long edge is exactly
 * `targetLongEdge`, aspect preserved, never below 1 px per side.
 */
export function sizeForLongEdge(width, height, targetLongEdge) {
  const longEdge = Math.max(width, height);
  if (longEdge === targetLongEdge) return { width, height };
  const ratio = targetLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}
