# ScalePress

Most "free AI upscaler" sites give you three free images, then a paywall — or run your photos through a server you know nothing about. I wanted one that just works and keeps your pictures yours, so I built ScalePress: drop in a picture, get back a properly AI-upscaled version — 2x, 4x, or targeted at 4K / 8K.

The part I'm most pleased with: **the AI runs entirely in your browser.** No upload, no server, no queue, no account. Your photo never leaves your device; the model comes to it.

The catch, stated up front: the speed is your hardware's speed. A decent laptop GPU finishes in seconds; an older phone can take a few minutes. I'd rather tell you that on the homepage than pretend it's instant.

**Live:** (frontend URL goes here once deployed — see DEPLOY.md)

## What it does

- Upscale JPG, PNG, WebP and BMP images with Real-ESRGAN — a real AI model, not resize-and-sharpen
- Three models: General Photo (fast), Max Quality (the big x4plus network), and Anime
- 2x / 4x scaling, or target presets that land on a 4K (3840 px) or 8K (7680 px) long edge
- Batch queue — add a pile of images, they are enhanced one at a time
- Before/after comparison slider with zoom, so you can actually inspect what the AI did
- Download as PNG, JPG or WebP, singly or as one ZIP
- Models download once per browser and are cached, so repeat visits start instantly

## How it's built

One half, and it's the half you can read in this repo:

- **Frontend** — plain HTML/CSS/JS, no build step, same style as my other tools (PixelPress, PagePress). Intake, settings, comparison, downloads.
- **The AI** — ONNX Runtime Web running Real-ESRGAN ONNX models inside a Web Worker (`js/worker.js`), on WebGPU where the browser offers it and WASM everywhere else. Big images are processed in tiles with context margins (`js/tiling.js` — the stitching math is unit-tested), and a memory guard refuses jobs that would crash the tab instead of letting them try.
- **Models** — two ship inside the site (`assets/models/`, converted by me from the official release weights and verified numerically against them); Max Quality's first source is a verified fp16 file on Hugging Face, with a bundled fp32 fallback. Full sourcing and verification numbers are in DEPLOY.md.

There used to be a server design — a Gradio backend, two GPU hosts, a failover client. Every "free" GPU route turned out to be paid, card-gated, or quietly discontinued, in the space of about a week. The browser build has no such dependency: it works because the visitor's device does the work. The `backend/` and `deploy/` code from that design isn't in this repo — I kept it locally as a record, clearly marked superseded.

## Honest limitations

- **Speed is your device's speed.** First use of each model downloads it (4.9 MB for General Photo, up to ~34 MB for Max Quality) — cached afterwards. Phones without WebGPU run on CPU and feel it.
- **Big results are capped.** A pass whose output would exceed what your device can safely hold in memory (roughly 100 MP on a desktop, 40 MP on a phone) is refused with an explanation, not a crashed tab. Very large source files (over 50 MB) are refused outright.
- **8K is a size, not a promise.** The output really is 7680 px on the long edge, and the detail in it is AI reconstruction. Detail the original never captured cannot come back. A tiny blurry photo comes out bigger and cleaner, not magically sharp.
- **No face restoration in this version.** GFPGAN is a ~349 MB model with no trustworthy on-device build and a whole detection/alignment pipeline behind it. Rather than fake it, the toggle is disabled and says exactly that. Upscaling still sharpens faces; it just isn't face restoration.
- **Transparency is dropped.** The models are RGB; transparent pixels come back opaque. Same as most upscalers.

## Running it locally

```bash
cd scalepress
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` from disk won't work: ES modules and workers need HTTP. Everyone hits that once.

Checks (syntax + a jsdom harness that drives the real module graph, the engine client against a fake worker, and the tiling math):

```bash
bash tests/run.sh
```

## Layout

```
index.html, css/, js/     the static site (the whole product)
js/config.js              model registry + ONNX Runtime pin
js/api.js                 thin enhancement interface used by the app
js/engine.js              main-thread client for the worker
js/worker.js              ONNX sessions, model downloads, tiled inference
js/tiling.js              pure tiling/size math (unit-tested)
assets/models/            bundled ONNX models (see DEPLOY.md)
DEPLOY.md                 deployment + model verification record
```

## License

MIT for the code. The model weights are not mine — Real-ESRGAN is BSD-3-Clause (xinntao / Tencent ARC), and the bundled ONNX files are conversions of the official release weights under that licence.
