# gud.pics

A mobile-first, installable photo toolkit. Source: https://github.com/FelineStateMachine/gudpics Every tool runs locally in the browser; Cloudflare serves static files and photos never leave the device.

Tools:

- `/fuji`: develops a Fujifilm RAF in the browser with LibRaw (WebAssembly) and applies any of 16 film simulation looks via 3D LUTs, then saves a JPEG. The in-camera JPEG can be viewed and saved too. See NOTICE.md for where the LUTs come from and how close they are.
- `/perspective`: straightens converging verticals and horizontals using darktable's C algorithms (LSD line detection, RANSAC, perspective fit, homography) compiled to WebAssembly.

## Run

The checked-in `assets/core.mjs` and `assets/core.wasm` are ready to use.

```sh
python3 scripts/package.py
python3 scripts/serve.py 8765
```

Open http://localhost:8765. The dev server maps extensionless routes such as `/perspective` to `perspective.html`, matching Cloudflare's asset handling. Service workers require localhost or HTTPS.

## Rebuild

Requires Python 3, Emscripten (`emcc`, built here with 6.0.9), Node.js for tests, and Pillow only to regenerate icons. No network is needed for extraction.

```sh
sh scripts/build.sh
node scripts/test-core.mjs
python3 scripts/package.py
```

If Emscripten's installed cache is read-only, set `EM_CACHE` to a writable directory when running the build.

`scripts/extract.py` documents each source adaptation. Original source at the pinned revision is in `native/upstream`; retain original notices. See NOTICE.md and LICENSES before redistributing.

## Cloudflare deployment

```sh
npx wrangler@4 deploy --dry-run
npx wrangler@4 deploy
```

The config serves only `dist/`; it has no backend, secrets, storage bindings, analytics, photo upload endpoint, or runtime npm dependencies. Packaging writes scripts, styles and wasm to `dist/static/` under content-hashed names and rewrites references, so hashed files are cached forever while pages are fetched network-first. Re-run packaging after changes. Existing open tabs finish using their cached version; close all app tabs and reopen to activate an update.

## Layout

- `index.html` + `home.mjs`: landing grid of tools, install and about.
- `fuji.html` + `fuji.mjs` + `rawworker.mjs` + `raf.mjs`: the Fuji tool. `rawworker.mjs` runs LibRaw (`assets/raw.wasm`, built by `native/raw/build.sh`) and the LUTs off the main thread. `raf.mjs` parses the RAF container and the Fuji makernote. `scripts/neutral-lut.py` regenerates the neutral LUTs with darktable-cli.
- `perspective.html` + `app.mjs`: the perspective tool UI. `worker.mjs` runs the WebAssembly core off the main thread.
- `style.css`: shared styles. Dark, system font, safe-area aware; the tool page never scrolls.

## Perspective tool

Photo import; original orientation via browser decoding; LSD structure detection; RANSAC outlier rejection; vertical, horizontal, or both-axis fit (including shear for both); color-coded accepted/rejected line overlays and counts; rotation and correction strength; crop modes; grid; before/after (tap the compare button or press and hold the photo); JPG/PNG export; install manifest and offline cache.


## Prototype limits

- JPEG/PNG only, 60 MB file limit. Imported images are flattened onto white and reduced to at most 4 MP / 2560 px. Analysis uses a 960 px preview.
- Browser 8-bit color handling; exports omit EXIF and source ICC metadata. No RAW or lens distortion profiles.
- Generic lens model, approximate crop, bilinear resampling. Not a full darktable pipeline or a reproduction of Lightroom's proprietary Auto mode.
- No manual line drawing/selection yet. Overlay colors: green vertical accepted, blue horizontal accepted, red vertical rejected, yellow horizontal rejected, gray other edges.
- Real-device iOS/Android memory, installation, photo picker, and sharing behavior still need hands-on validation. A desktop browser with a phone-sized viewport cannot establish those guarantees.
- LSD's inherited error routine can terminate its WASM instance on allocation failure; the UI catches worker errors, but reload may be required after memory exhaustion.
