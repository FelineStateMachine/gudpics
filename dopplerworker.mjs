// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Doppler worker. The page runs two of these: one builds the spectrogram and renders views of it,
// the other scans a copy for flyovers, so panning stays responsive while a long recording is scanned.
//
// Messages are { type, id, ...args }. Replies are { id, result } or { id, error }; long operations
// also post { id, progress } with a fraction in [0, 1].

import { SR, decimate, spectrogram, detectEvents, renderView } from './dopplercore.mjs';

let sp = null;

function meta(s) {
  return { T: s.T, F: s.F, t0: s.t0, dt: s.dt, f0: s.f0, df: s.df };
}

const handlers = {
  // { pcm: Float32Array mono, rate } -> spectrogram metadata. Keeps the spectrogram for rendering.
  analyze({ pcm, rate }, progress) {
    sp = null;
    const x = decimate(pcm, rate);
    if (x.length < SR * 3) throw Error('The sound is too short. Use at least 3 seconds.');
    sp = spectrogram(x, progress);
    return { result: meta(sp) };
  },

  // A copy of the spectrogram, to hand to the scanning worker.
  copy() {
    if (!sp) throw Error('Open a video first.');
    const S = sp.S.slice();
    return { result: { ...sp, S }, transfer: [S.buffer] };
  },

  // { i0, i1, w, h, lo, hi } -> { w, h, data: RGBA }
  render({ i0, i1, w, h, lo, hi }) {
    if (!sp) throw Error('Open a video first.');
    const data = renderView(sp, i0, i1, w, h, lo, hi);
    return { result: { w, h, data }, transfer: [data.buffer] };
  },

  // { sp } -> events, strongest first. The spectrogram is dropped afterwards.
  detect({ sp: copy }, progress) {
    const events = detectEvents(copy, {}, progress);
    return { result: events };
  },

  close() {
    sp = null;
    return { result: { ok: true } };
  },
};

self.onmessage = ({ data }) => {
  const { type, id } = data;
  let lastPost = 0;
  const progress = fraction => {
    const now = performance.now();
    if (now - lastPost < 100) return;
    lastPost = now;
    self.postMessage({ id, progress: fraction });
  };
  try {
    const handler = handlers[type];
    if (!handler) throw Error('Unknown operation.');
    const { result, transfer = [] } = handler(data, progress);
    self.postMessage({ id, result }, transfer);
  } catch (e) {
    self.postMessage({ id, error: e.message || 'Analysis failed.' });
  }
};
