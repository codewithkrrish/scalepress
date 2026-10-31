# Deploying ScalePress

**Current architecture: there is no backend.** ScalePress is a static
site that runs the AI entirely in the visitor's browser:

- ONNX Runtime Web (pinned, loaded from CDN) executes Real-ESRGAN
  ONNX models inside a module Web Worker (`js/worker.js`), using
  WebGPU where available and WASM otherwise.
- Models are ordinary files: two ship inside the site
  (`assets/models/`), and the Max Quality model's primary source is a
  verified file on Hugging Face (its fp32 fallback also ships in the
  site). Downloaded models are cached by the browser in Cache
  Storage, so repeat visits skip the download.
- The server architecture this replaced (Modal primary + Beam backup
  + the original Hugging Face Space plan) is documented at the
  bottom under **Superseded** — every one of those routes turned out
  to be paid, card-gated, or withdrawn, which is why the browser
  build exists.

Deploy = publish the static files. That's it.

---

## The deploy (Vercel)

Same flow as PixelPress/PagePress — static site, no build step:

1. Import the repo (or drag the project folder) into Vercel as a new
   project. Framework preset: **Other**. Build command: none. Output
   directory: the project root.
2. Deploy, then rename/assign the clean domain (project-name style,
   no team suffix) the way the other tools are set up.
3. No environment variables, no server settings, nothing else.
   (`vercel.json`/headers are not required: the worker falls back to
   single-threaded WASM when the page is not cross-origin isolated,
   and upgrades automatically if COOP/COEP headers are ever added.)

### Live test, in this order

- Page loads; the dropzone accepts a drag, a paste (Ctrl+V) and a
  browse.
- Add one small photo, press **Enhance**. On first use of the
  General Photo model you should see "Downloading the AI model"
  progress, then tile-by-tile "Enhancing on your device" progress,
  then a result card. A laptop-class device finishes a small photo
  in seconds to tens of seconds.
- Enhance the same model again: no download stage (Cache Storage
  hit), straight to loading/enhancing.
- Open Compare, drag the slider, zoom to 200%, check the detail.
- Switch to **Max Quality**: its fp16 file downloads from Hugging
  Face (progress shown); on a WebGPU browser it runs there. If a
  device cannot run the fp16 file, the engine automatically falls
  back to the bundled fp32 copy — the job still completes.
- Download the single image; add a second image, enhance, and use
  **Download all** to confirm the ZIP path works.
- Test one failure on purpose (e.g. a `.txt` file renamed `.png`)
  and confirm the card shows a readable error with a Retry button.
- Test the memory guard: a very large photo (e.g. 6000×4000) at 4x
  on a phone should be refused with the "more than this device can
  safely hold" message — not a crashed tab.
- Check the Face enhancement toggle: disabled, with the hint that
  face restore is not available in the browser version yet.

Before deploying, run the local gate:

```bash
bash tests/run.sh   # node --check on all JS + the jsdom harness
```

The harness covers startup, intake, the engine client against a
fake worker, the tiling math (exact output coverage, budget caps),
pass planning, and the honesty checks (no server-era copy, face
restore clearly off). It does **not** run real inference in a real
browser — the live test above is the gate for that, per the
PixelPress lesson.

---

## Models — sources and verification

All models are 4x networks taking NCHW float input in [0, 1] and
producing NCHW float output ~[0, 1], with dynamic H/W axes. Two were
converted locally from the official release weights; the third is a
hosted file that was verified *against* a local conversion of the
same weights before being trusted.

| UI model | File / URL | Bytes | Type | Source |
|---|---|---|---|---|
| General Photo | `assets/models/realesr-general-x4v3.onnx` | 4,866,422 | fp32 | Converted locally from the official `realesr-general-x4v3.pth` (xinntao/Real-ESRGAN release v0.2.5.0) |
| Anime | `assets/models/RealESRGAN_x4plus_anime_6B.onnx` | 17,939,969 | fp32 | Converted locally from the official `RealESRGAN_x4plus_anime_6B.pth` (release v0.2.2.4) |
| Max Quality (primary) | `https://huggingface.co/imgdesignart/realesrgan-x4-onnx/resolve/main/onnx/model_fp16.onnx` | 33,749,677 | fp16 | Community conversion, verified against the official weights (below) |
| Max Quality (fallback) | `assets/models/RealESRGAN_x4plus.onnx` | 67,051,644 | fp32 | Converted locally from the official `RealESRGAN_x4plus.pth` (release v0.1.0) |

SHA-256 (first 16) of the bundled files: x4v3 `804fb1eb89f6a566`,
anime `5273d9233398cc18`, x4plus fp32 `279c48a8e6a815c7`.

### How each model was verified (2026-10-31, local onnxruntime)

A model only ships if it has actually run here:

- **Converted models** — the architecture (RRDBNet / SRVGGNetCompact
  from the official `basicsr`/`realesrgan` packages) loaded the
  official checkpoint with `strict=True` (all keys matched), was
  exported with `torch.onnx.export` (opset 17, dynamic batch/H/W),
  and the ONNX output was diffed against the PyTorch model on fixed
  random inputs (64×64, 37×53, 128×128): max |diff| ≈ 1e-6
  (PSNR ≈ 136 dB) for all three — numerically identical.
  - One landmine found on the way: `realesr-general-x4v3`'s released
    checkpoint has 67 body entries, which under the pip arch equals
    **num_conv=32**, not the widely documented 16 (the server
    backend's x4v3 path used 16 and would have failed its strict
    load — it never ran, so nobody saw it). The independent
    cross-check below confirms 32 is right.
- **Hosted fp16 x4plus** — loaded and run locally; diffed against
  the PyTorch x4plus reference at 64×64 and 37×53 (so its dynamic
  axes are genuinely dynamic): max |diff| ≈ 2.4e-3, PSNR ≈ 72 dB —
  exactly fp16 rounding, i.e. it is the real x4plus in fp16.
  CORS: the HF resolve URL answers with
  `Access-Control-Allow-Origin: *` on the final CDN hop (verified
  with curl, 2026-10-31).
  - The same repo's fp32 file (and AXERA-TECH's conversion) are
    fixed-shape 64×64 exports — genuine (the fp32 diff vs the
    reference is ≈ 8e-7) but unusable for arbitrary tiles, which
    is why our own fp32 conversion is the fallback instead.
- **Hosted x4v3 candidate** (`tamnvcc/Real-ESRGAN-General-x4v3_float`,
  fixed 128×128) — diffed against the local conversion at 128×128:
  max |diff| ≈ 9e-7. Not shipped (fixed shape, and ours is small
  enough to bundle), but it independently confirms the local
  conversion's architecture.
- **Hosted anime candidate** — the only dynamic anime ONNX found
  (`xiongjie/lightweight-real-ESRGAN-anime`) is a different,
  lightweight 4-block/32-feature network, not anime_6B; rejected.
  No trustworthy hosted anime_6B ONNX exists, so ours ships
  same-origin despite its size.

Licences: Real-ESRGAN and its release weights are BSD-3-Clause
(xinntao / Tencent ARC). The bundled ONNX files are conversions of
those weights and travel under the same licence; attribution is in
README.md.

### Engine behaviour worth knowing

- Execution providers are tried in order **WebGPU → WASM**, per
  model source, and a source/provider combo that fails at session
  creation *or on its first tile* is blacklisted for the session and
  the engine moves down the chain (see `js/worker.js`). WASM thread
  count is `min(4, hardwareConcurrency)` when the page is
  cross-origin isolated, else 1.
- Tiles: 512 px input tiles on WebGPU, 256 px on WASM, 16 px
  input-space margin around each tile core (see `js/tiling.js` for
  the exact-coverage math and its unit tests).
- Memory guard: a pass is refused up front when its output would
  exceed a device-based cap (~100 MP desktop, ~40 MP mobile,
  less on low-memory devices) instead of crashing the tab.
- Alpha: input alpha is dropped (the models are RGB), so results
  are opaque PNGs — same as the old server behaved.

## Face restore — not in the browser version (yet)

GFPGAN face restoration is **off**, deliberately, and the UI says
so. Evidence gathered 2026-10-31:

- A sweep of Hugging Face (seven query families, ~135 repos checked,
  including the obvious candidates) found **no GFPGAN ONNX file at
  all**; GitHub demo repos ship conversion scripts, not a hosted
  model, and their demos consume pre-cropped, pre-aligned faces.
- A browser feature needs the whole pipeline: face detector +
  landmarks, affine alignment to 512×512, the GFPGAN generator
  (~349 MB checkpoint), inverse-warp paste-back with blending.
  Only the generator's weights are readily available; the rest has
  no verified on-device supply.
- Faking it (e.g. quietly running plain upscale and calling it
  face restore) was not an option. The toggle is disabled with an
  explanation; `config.FACE_RESTORE_AVAILABLE` is the single switch
  if a verified pipeline ever lands.

---

## If it breaks later

- **"The AI engine (ONNX Runtime) could not be loaded"** — the CDN
  bundle (`js/config.js` → `ORT_BUNDLE_URL`) is unreachable or the
  pinned version was yanked. Check the URL; bump `ORT_VERSION` +
  both URLs together.
- **Max Quality fails on one device but works on another** — the
  fallback chain should have caught it; reproduce and check the
  browser console for which source/provider combos were blacklisted
  (`js/worker.js`, `badCombos`).
- **Everything is slow on a phone** — expected physics: WASM,
  single-threaded unless COOP/COEP headers are added. Adding
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` headers on Vercel
  unlocks multi-threaded WASM — but audit the page's cross-origin
  assets (fonts, JSZip CDN, the HF model fetch needs CORS, which it
  has) before enabling them.
- **A model file 404s after a repo change** — the bundled models
  live in `assets/models/`; the registry in `js/config.js` is the
  only place their paths appear.

---

## Superseded — the server architecture (do not deploy)

> **Status: superseded on 2026-10-31 by the browser build above.**
> The code is preserved in the repo for reference — `backend/`
> (the Gradio app), `deploy/modal/`, `deploy/beam/`,
> `deploy/README-versions.md` — and is **not** part of the live
> path. Nothing in `js/` references it.

Why each route died, briefly (all verified at the time):

- **Hugging Face Spaces** — the original plan. The Space
  (`codewithkrrish/scalepress`) exists with the backend files, but
  HF now requires a paid PRO plan for Gradio Spaces and ZeroGPU,
  and even a CPU restart is quota-blocked on the free account. The
  Space is paused and cannot serve.
- **Modal** (was primary) — the deploy was built and the CLI
  authenticated, but Modal refuses to deploy GPU functions at all
  without a payment method on file, and only $1 of the $30/month
  free credits is usable before adding one. The user's rule is
  free-only, no card — so Modal is out despite the ready deploy.
- **Beam** (was backup) — withdrew its $30/month free credits
  (2026-09-09); current pricing starts at $20/month and its terms
  require a payment method on file for paid plans.

The frontend failover client built for Modal/Beam was removed with
this pivot; its history lives in git.
