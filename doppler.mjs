// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Doppler tool: decode the sound of a video or audio file, show a whitened 40-450 Hz spectrogram,
// and mark aircraft flyovers found in it. Everything runs on the device.

import { idealCurve, isFlyover } from './dopplercore.mjs';

const $ = id => document.getElementById(id);
const tool = $('tool'), stage = $('stage'), wrap = $('wrap'), canvas = $('canvas');
const ctx = canvas.getContext('2d');

const MAX_BYTES = 1024 ** 3;        // the whole file is read into memory to decode it
const MAX_SECONDS = 2 * 3600;       // longer recordings are cut, to bound memory
const MIN_SPAN = 20;                // seconds visible at full zoom
const RANGE_DEFAULT = 16;           // dB above the median shown as the brightest colour
const FLOOR_DB = 2;                 // dB above the median shown as black; most noise falls below
const MARK_GAP = 0.06;              // flyover marks sit this fraction above and below the curve
const MAX_PIXEL_RATIO = 2;
const TINT = '#f0c04a', TINT_INK = '#1a1400';

// ---------- Workers ----------

// A worker with promise calls. restart() cancels whatever it is doing.
function createEngine() {
  let worker, nextId = 0;
  const pending = new Map();
  const failAll = (message, name) => {
    for (const p of pending.values()) {
      const error = Error(message);
      if (name) error.name = name;
      p.reject(error);
    }
    pending.clear();
  };
  const start = () => {
    worker = new Worker(new URL('./dopplerworker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      if ('progress' in data) return p.onProgress?.(data.progress);
      pending.delete(data.id);
      if (data.error) p.reject(Error(data.error)); else p.resolve(data.result);
    };
    worker.onerror = () => failAll('The analysis engine stopped. Reload to try again.');
  };
  start();
  return {
    call(type, args = {}, transfer = [], onProgress) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject, onProgress });
        worker.postMessage({ type, id, ...args }, transfer);
      });
    },
    restart() {
      worker.terminate();
      failAll('Cancelled.', 'AbortError');
      start();
    },
  };
}

const viewer = createEngine();   // spectrogram and rendering
const scanner = createEngine();  // flyover detection on a copy

// ---------- State ----------

let current = null;   // { name, meta, truncated, scan: fraction or null, events, flyovers }
let view = { start: 0, span: 1 };   // visible time window, seconds on the recording's clock
let busy = false, marks = true, focus = -1;

const tMin = () => current.meta.t0;
const tMax = () => current.meta.t0 + (current.meta.T - 1) * current.meta.dt;
const fullSpan = () => tMax() - tMin();
const minSpan = () => Math.min(MIN_SPAN, fullSpan());

function clampView() {
  view.span = Math.min(fullSpan(), Math.max(minSpan(), view.span));
  view.start = Math.min(tMax() - view.span, Math.max(tMin(), view.start));
}

// The zoom slider is logarithmic in the visible span.
function spanFromSlider(value) {
  return fullSpan() * (minSpan() / fullSpan()) ** (value / 1000);
}
function sliderFromSpan(span) {
  const k = Math.log(minSpan() / fullSpan());
  return k ? Math.round(1000 * Math.log(span / fullSpan()) / k) : 0;
}

// ---------- Formatting ----------

function formatTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function describe(e) {
  const knots = Math.round(e.v * 1.94384);
  const km = (e.d / 1000).toFixed(1);
  return `${formatTime(e.t_cpa)}, ${Math.round(e.f0)} Hz, about ${knots} kn, ${km} km away`;
}

// ---------- Status and controls ----------

let toastTimer;
function status(message, error = false, persist = false) {
  clearTimeout(toastTimer);
  const el = $('status');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.hidden = !message;
  if (message && !persist) toastTimer = setTimeout(() => { el.hidden = true; }, error ? 5000 : 3500);
}

function chipText() {
  const parts = [formatTime(fullSpan())];
  if (current.truncated) parts.push('first 2 h');
  if (current.scan !== null) parts.push(`Scanning ${Math.round(current.scan * 100)}%`);
  else if (current.events) parts.push(current.flyovers.length ? plural(current.flyovers.length, 'flyover') : 'No flyovers');
  return parts.join('  ');
}

function sync() {
  tool.dataset.state = current ? 'detected' : 'empty';
  const ready = Boolean(current) && !busy;
  for (const id of ['save', 'share', 'reset', 'range']) $(id).disabled = !ready;
  $('zoom').disabled = !ready || fullSpan() <= MIN_SPAN;
  $('open').disabled = busy;
  $('open-empty').disabled = busy;
  $('busy').hidden = !busy;
  $('range-value').value = `${$('range').value} dB`;
  const flyovers = current?.flyovers ?? [];
  $('marks').disabled = !flyovers.length;
  $('marks').setAttribute('aria-pressed', String(marks));
  $('info').disabled = !flyovers.length;
  if (current) {
    $('info').textContent = chipText();
    $('zoom-value').value = view.span >= fullSpan() - 1e-6 ? 'All' : formatTime(view.span);
  }
}

// ---------- Drawing ----------

// Maps between the recording clock / frequency and pixels for one rendered view. A pixel column
// covers whole spectrogram frames, so the view is extended by half a frame on each side.
function geometry(v, w, h) {
  const { t0, dt, f0, df, F } = current.meta;
  const i0 = (v.start - t0) / dt, i1 = i0 + v.span / dt + 1;
  return {
    i0, i1, w, h,
    x: t => ((t - t0) / dt + 0.5 - i0) / (i1 - i0) * w,
    t: x => t0 + (i0 + x / w * (i1 - i0) - 0.5) * dt,
    y: f => h - ((f - f0) / df + 0.5) / F * h,
  };
}

function tickStep(span, maxTicks) {
  for (const step of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]) {
    if (span / step <= maxTicks) return step;
  }
  return 14400;
}

// Grid, labels and flyover marks over a rendered spectrogram. s is device pixels per CSS pixel.
function drawOverlay(g, v, ctx2, s) {
  const { w, h } = g;
  ctx2.save();
  ctx2.font = `500 ${11 * s}px -apple-system, system-ui, sans-serif`;
  ctx2.textBaseline = 'alphabetic';

  // frequency grid
  for (const f of [100, 200, 300, 400]) {
    const y = Math.round(g.y(f)) + 0.5;
    ctx2.fillStyle = 'rgba(255,255,255,.14)';
    ctx2.fillRect(0, y, w, Math.max(1, s * 0.75));
    ctx2.fillStyle = 'rgba(255,255,255,.75)';
    ctx2.fillText(`${f} Hz`, 6 * s, y - 4 * s);
  }

  // time ticks along the top
  const step = tickStep(v.span, Math.max(2, Math.floor(w / (s * 72))));
  ctx2.fillStyle = 'rgba(255,255,255,.75)';
  for (let t = Math.ceil(v.start / step) * step; t <= v.start + v.span; t += step) {
    const x = Math.round(g.x(t));
    ctx2.fillRect(x, 0, Math.max(1, s), 6 * s);
    ctx2.fillText(formatTime(t), x + 4 * s, 15 * s);
  }

  // flyovers: two lines bracketing the fitted fundamental, so the ridge itself stays visible between
  // them, and a numbered badge above the closest approach. The focused one is solid.
  if (marks && current.flyovers.length) {
    current.flyovers.forEach((e, k) => {
      const a = Math.max(v.start, e.t_cpa - 300), b = Math.min(v.start + v.span, e.t_cpa + 300);
      if (b <= a) return;
      const n = Math.max(2, Math.ceil((g.x(b) - g.x(a)) / (2 * s)));
      const times = Float64Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));
      const freqs = idealCurve(times, e.f0, e.v, e.d, e.t_cpa_emit);
      ctx2.beginPath();
      for (const side of [1 + MARK_GAP, 1 - MARK_GAP]) {
        let drawing = false;
        for (let i = 0; i < n; i++) {
          if (!Number.isFinite(freqs[i])) { drawing = false; continue; }
          const x = g.x(times[i]), y = g.y(freqs[i] * side);
          if (drawing) ctx2.lineTo(x, y); else ctx2.moveTo(x, y);
          drawing = true;
        }
      }
      ctx2.strokeStyle = TINT;
      ctx2.globalAlpha = k === focus ? 1 : 0.85;
      ctx2.lineWidth = 1.25 * s;
      ctx2.setLineDash(k === focus ? [] : [6 * s, 5 * s]);
      ctx2.stroke();
      ctx2.setLineDash([]);
      ctx2.globalAlpha = 1;

      const x = g.x(e.t_cpa), y = Math.max(28 * s, g.y(e.f0 * (1 + MARK_GAP)) - 16 * s), r = 9 * s;
      if (x < -r || x > w + r) return;
      ctx2.beginPath();
      ctx2.arc(x, y, r, 0, 2 * Math.PI);
      ctx2.fillStyle = TINT;
      ctx2.fill();
      ctx2.fillStyle = TINT_INK;
      ctx2.textAlign = 'center';
      ctx2.textBaseline = 'middle';
      ctx2.font = `700 ${11 * s}px -apple-system, system-ui, sans-serif`;
      ctx2.fillText(String(k + 1), x, y + 0.5 * s);
      ctx2.textAlign = 'start';
      ctx2.textBaseline = 'alphabetic';
      ctx2.font = `500 ${11 * s}px -apple-system, system-ui, sans-serif`;
    });
  }
  ctx2.restore();
}

async function paint(v, w, h, target, s) {
  const g = geometry(v, w, h);
  const range = Number($('range').value);
  const img = await viewer.call('render', { i0: g.i0, i1: g.i1, w, h, lo: FLOOR_DB, hi: range });
  if (target.canvas.width !== w || target.canvas.height !== h) {
    target.canvas.width = w;
    target.canvas.height = h;
  }
  target.putImageData(new ImageData(img.data, w, h), 0, 0);
  drawOverlay(g, v, target, s);
}

// Renders are coalesced: at most one in flight, and the latest view wins.
let rendering = false, renderAgain = false, frameRequested = false;
function requestRender() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => { frameRequested = false; render(); });
}

async function render() {
  if (!current) return;
  if (rendering) { renderAgain = true; return; }
  rendering = true;
  try {
    do {
      renderAgain = false;
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      const w = Math.max(1, Math.round(wrap.clientWidth * ratio)), h = Math.max(1, Math.round(wrap.clientHeight * ratio));
      await paint({ ...view }, w, h, ctx, ratio);
    } while (renderAgain && current);
    scheduleExport();
  } catch (e) {
    status(e.message, true);
  } finally {
    rendering = false;
  }
}

new ResizeObserver(requestRender).observe(wrap);

// ---------- Export ----------

// The saved PNG is the current view at up to one pixel per frame, keeping the screen's aspect.
let exportCache = null, exportTimer, exportId = 0;
function scheduleExport() {
  exportCache = null;
  clearTimeout(exportTimer);
  const id = ++exportId;
  exportTimer = setTimeout(async () => {
    try {
      const blob = await exportPng();
      if (id === exportId) exportCache = blob;
    } catch { /* made again on demand */ }
  }, 800);
}

async function exportPng() {
  const v = { ...view };
  const w = Math.min(4096, Math.max(1600, Math.round(v.span / current.meta.dt) + 1));
  const h = Math.min(2400, Math.max(840, Math.round(w * wrap.clientHeight / Math.max(1, wrap.clientWidth))));
  const off = new OffscreenCanvas(w, h);
  await paint(v, w, h, off.getContext('2d'), w / Math.max(1, wrap.clientWidth) * 1.25);
  return off.convertToBlob({ type: 'image/png' });
}

const fileName = () => `${current.name}-doppler.png`;

function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

$('save').onclick = async () => {
  if (!current) return;
  busy = true; sync();
  try {
    download(exportCache ?? await exportPng(), fileName());
    status('Saved');
  } catch (e) {
    status(e.message || 'Could not save the PNG.', true);
  } finally {
    busy = false; sync();
  }
};

if (navigator.canShare && navigator.share) $('share').hidden = false;
$('share').onclick = () => {
  if (!current) return;
  // Sharing must start inside the tap, so it uses the PNG made after the last render.
  if (!exportCache) {
    busy = true; sync();
    exportPng()
      .then(blob => { download(blob, fileName()); status('Saved. Share it from your files.'); })
      .catch(e => status(e.message, true))
      .finally(() => { busy = false; sync(); });
    return;
  }
  const file = new File([exportCache], fileName(), { type: 'image/png' });
  if (!navigator.canShare({ files: [file] })) return status('Sharing files is not supported here.', true);
  navigator.share({ files: [file] }).catch(e => {
    if (e.name === 'AbortError') return;
    download(exportCache, fileName());
    status('Saved. Share it from your files.');
  });
};

// ---------- Opening a file ----------

// Decodes the file's sound to mono. The browser resamples while decoding; the lowest rate it accepts
// that is a multiple of 4 kHz keeps memory down, and the worker takes it the rest of the way.
async function decodeAudio(file) {
  const bytes = await file.arrayBuffer();
  let audioCtx = null;
  for (const rate of [4000, 8000, 16000, 48000]) {
    try { audioCtx = new OfflineAudioContext(1, 1, rate); break; } catch { /* rate not supported */ }
  }
  if (!audioCtx) throw Error('This browser cannot decode sound.');
  let audio;
  try {
    audio = await audioCtx.decodeAudioData(bytes);
  } catch {
    throw Error('No sound found. The file may have no sound track, or this browser cannot decode it.');
  }
  const channels = audio.numberOfChannels, pcm = new Float32Array(audio.length);
  for (let c = 0; c < channels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < pcm.length; i++) pcm[i] += data[i] / channels;
  }
  return { pcm, rate: audio.sampleRate };
}

function isSilent(pcm) {
  for (let i = 0; i < pcm.length; i++) if (Math.abs(pcm[i]) > 1e-5) return false;
  return true;
}

async function openFile(file) {
  if (busy) return;
  busy = true;
  scanner.restart();
  sync();
  try {
    if (file.size > MAX_BYTES) throw Error('Choose a file under 1 GB.');
    status('Reading the sound', false, true);
    let { pcm, rate } = await decodeAudio(file);
    const truncated = pcm.length > MAX_SECONDS * rate;
    if (truncated) pcm = pcm.slice(0, MAX_SECONDS * rate);
    if (!pcm.length || isSilent(pcm)) throw Error('This file has no sound.');
    status('Building the spectrogram', false, true);
    const meta = await viewer.call('analyze', { pcm, rate }, [pcm.buffer]);
    current = { name: file.name.replace(/\.[^.]+$/, '') || 'recording', meta, truncated, scan: 0, events: null, flyovers: [] };
    view = { start: tMin(), span: fullSpan() };
    focus = -1;
    marks = true;
    $('range').value = RANGE_DEFAULT;
    $('zoom').value = 0;
    status(truncated ? 'Showing the first 2 hours.' : '');
    requestRender();
    scan(current);
  } catch (e) {
    status(e.message || 'Could not open this file.', true);
  } finally {
    busy = false;
    sync();
  }
}

// Detection runs on a copy in the second worker while the spectrogram stays interactive.
async function scan(target) {
  try {
    const copy = await viewer.call('copy');
    const events = await scanner.call('detect', { sp: copy }, [copy.S.buffer], fraction => {
      if (current !== target) return;
      target.scan = fraction;
      sync();
    });
    if (current !== target) return;
    target.events = events;
    target.flyovers = events.filter(isFlyover).sort((a, b) => a.t_cpa - b.t_cpa);
    target.scan = null;
    sync();
    requestRender();
  } catch (e) {
    if (e.name === 'AbortError' || current !== target) return;
    target.scan = null;
    target.events = [];
    status(e.message || 'The flyover scan failed.', true);
    sync();
  }
}

// ---------- Controls ----------

$('range').oninput = () => { sync(); requestRender(); };

$('zoom').oninput = () => {
  const centre = view.start + view.span / 2;
  view.span = spanFromSlider(Number($('zoom').value));
  view.start = centre - view.span / 2;
  clampView();
  sync();
  requestRender();
};

function viewChanged() {
  clampView();
  $('zoom').value = sliderFromSpan(view.span);
  sync();
  requestRender();
}

$('reset').onclick = () => {
  view = { start: tMin(), span: fullSpan() };
  focus = -1;
  marks = true;
  $('range').value = RANGE_DEFAULT;
  viewChanged();
};

$('marks').onclick = () => {
  marks = !marks;
  sync();
  requestRender();
};

// The chip steps through the flyovers, centring each one.
$('info').onclick = () => {
  const flyovers = current?.flyovers ?? [];
  if (!flyovers.length) return;
  focus = (focus + 1) % flyovers.length;
  const e = flyovers[focus];
  view.span = Math.min(view.span, 360);
  view.start = e.t_cpa - view.span / 2;
  marks = true;
  viewChanged();
  status(`${focus + 1} of ${flyovers.length}: ${describe(e)}`);
};

// Drag to pan, pinch to zoom around the fingers.
const pointers = new Map();
let gesture = null;
const localX = clientX => clientX - wrap.getBoundingClientRect().left;

function beginGesture() {
  gesture = pointers.size ? { xs: [...pointers.values()], view: { ...view } } : null;
}

stage.addEventListener('pointerdown', e => {
  if (!current || e.target.closest('button')) return;
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, localX(e.clientX));
  beginGesture();
});

stage.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, localX(e.clientX));
  const xs = [...pointers.values()], width = Math.max(1, wrap.clientWidth), from = gesture.view;
  if (xs.length === 1 && gesture.xs.length === 1) {
    view.start = from.start - (xs[0] - gesture.xs[0]) / width * from.span;
  } else if (xs.length >= 2 && gesture.xs.length >= 2) {
    const before = Math.max(8, Math.abs(gesture.xs[1] - gesture.xs[0])), after = Math.max(8, Math.abs(xs[1] - xs[0]));
    const midBefore = (gesture.xs[0] + gesture.xs[1]) / 2, midAfter = (xs[0] + xs[1]) / 2;
    const anchor = from.start + midBefore / width * from.span;
    view.span = Math.min(fullSpan(), Math.max(minSpan(), from.span * before / after));
    view.start = anchor - midAfter / width * view.span;
  }
  viewChanged();
});

for (const type of ['pointerup', 'pointercancel']) {
  stage.addEventListener(type, e => {
    if (pointers.delete(e.pointerId)) beginGesture();
  });
}

// Trackpad and mouse: scroll to pan, pinch (or ctrl + wheel) to zoom.
stage.addEventListener('wheel', e => {
  if (!current) return;
  e.preventDefault();
  const width = Math.max(1, wrap.clientWidth);
  if (e.ctrlKey || e.metaKey) {
    const fx = localX(e.clientX) / width, anchor = view.start + fx * view.span;
    view.span = Math.min(fullSpan(), Math.max(minSpan(), view.span * Math.exp(e.deltaY * 0.01)));
    view.start = anchor - fx * view.span;
  } else {
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    view.start += delta / width * view.span;
  }
  viewChanged();
}, { passive: false });

// ---------- File input ----------

$('file').onchange = () => {
  const f = $('file').files[0];
  if (f) openFile(f);
  $('file').value = '';
};
$('open').onclick = () => $('file').click();
$('open-empty').onclick = () => $('file').click();
stage.addEventListener('dragover', e => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  $('open-empty').classList.add('over');
});
stage.addEventListener('dragleave', () => $('open-empty').classList.remove('over'));
stage.addEventListener('drop', e => {
  e.preventDefault();
  $('open-empty').classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});
stage.addEventListener('contextmenu', e => e.preventDefault());

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !current) location.reload();
    hadController = true;
  });
}

sync();
