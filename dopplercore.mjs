// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Doppler analysis core: a whitened low-band spectrogram, flyover detection, and view rendering.
//
// The spectrogram, whitening, detection and curve fitting are a port of dopplertrack
// (https://github.com/mjshiggins/dopplertrack, MIT, MacCallister Higgins), version 0.3.0:
// audio.py, doppler.py and tracks.py. Constants and defaults match the original, and on the
// same audio the port returns the same events and scores.

export const SR = 4000;          // analysis sample rate, Hz
export const NPERSEG = 8192;     // STFT length: 0.49 Hz bins
export const HOP = 1000;         // 0.25 s between frames
export const FMIN = 40;          // band kept, Hz
export const FMAX = 450;
const WHITEN_S = 600;            // running-median window for whitening, s
const CONTRAST_DF = 0.04;        // sideband offset for ridge contrast, fraction of frequency
const SWEEP_FLOOR = 0.15;        // weight of a curve's flat tails relative to its steepest part

// dopplertrack ranks events but does not call them. A flyover here is an event that clears noise:
// on synthetic noise and hum the best events score about 1.4 dB, real passes 6 dB and up. Events
// mostly inside a broadband burst are a vehicle near the microphone rather than an aircraft.
export const MIN_SCORE = 2.5;
export const MAX_BURST = 0.2;
export const isFlyover = e => e.score >= MIN_SCORE && e.burst < MAX_BURST;

export function speedOfSound(tempC = 15) {
  return 331.3 * Math.sqrt(1 + tempC / 273.15);
}

// ---------- Small numeric helpers (numpy equivalents) ----------

function linspace(a, b, n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = n === 1 ? a : a + (b - a) * i / (n - 1);
  return out;
}

function arange(a, b, step) {
  const n = Math.max(0, Math.ceil((b - a) / step));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = a + i * step;
  return out;
}

function geomspace(a, b, n) {
  const out = new Float64Array(n);
  const la = Math.log10(a), lb = Math.log10(b);
  for (let i = 0; i < n; i++) out[i] = 10 ** (la + (lb - la) * i / (n - 1));
  out[0] = a;
  out[n - 1] = b;
  return out;
}

function median(values) {
  const s = Float64Array.from(values).sort();
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// np.quantile with linear interpolation, on an already sorted array.
function quantileSorted(sorted, p) {
  const x = p * (sorted.length - 1), i = Math.floor(x), u = x - i;
  return i + 1 < sorted.length ? sorted[i] * (1 - u) + sorted[i + 1] * u : sorted[i];
}

// np.interp, but NaN outside [xp[0], xp[-1]]. xp must be increasing.
function interp(x, xp, fp) {
  if (!(x >= xp[0] && x <= xp[xp.length - 1])) return NaN;
  let lo = 0, hi = xp.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xp[mid] <= x) lo = mid; else hi = mid;
  }
  const span = xp[hi] - xp[lo];
  return span > 0 ? fp[lo] + (fp[hi] - fp[lo]) * (x - xp[lo]) / span : fp[lo];
}

// np.gradient(y, t): second-order central differences inside, first-order at the ends.
function gradient(y, t) {
  const n = y.length, g = new Float64Array(n);
  if (n < 2) return g;
  g[0] = (y[1] - y[0]) / (t[1] - t[0]);
  g[n - 1] = (y[n - 1] - y[n - 2]) / (t[n - 1] - t[n - 2]);
  for (let i = 1; i < n - 1; i++) {
    const h1 = t[i] - t[i - 1], h2 = t[i + 1] - t[i];
    g[i] = -h2 / (h1 * (h1 + h2)) * y[i - 1] + (h2 - h1) / (h1 * h2) * y[i] + h1 / (h2 * (h1 + h2)) * y[i + 1];
  }
  return g;
}

// ---------- Resampling ----------

// Integer-factor decimation to SR with a Blackman windowed-sinc low-pass. Only 40-450 Hz is used,
// so a 1600 Hz cutoff leaves the band untouched and keeps aliases far above it.
export function decimate(x, rate) {
  if (rate === SR) return x;
  const factor = Math.round(rate / SR);
  if (factor < 1 || Math.abs(factor * SR - rate) > 1e-6) throw Error('Unsupported sample rate.');
  const taps = 24 * factor + 1, half = (taps - 1) / 2, fc = 1600 / rate;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const m = i - half;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    const blackman = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1));
    h[i] = sinc * blackman;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;

  const out = new Float32Array(Math.floor(x.length / factor));
  for (let o = 0; o < out.length; o++) {
    const centre = o * factor;
    const first = Math.max(0, half - centre), last = Math.min(taps, x.length - centre + half);
    let acc = 0;
    for (let i = first; i < last; i++) acc += h[i] * x[centre + i - half];
    out[o] = acc;
  }
  return out;
}

// ---------- FFT ----------

// Power spectrum of a real frame of N samples, computed as one complex FFT of N/2 points.
// Returns fn(x, offset, window, b0, b1, out) writing |X[k]|^2 for bins b0 <= k < b1 into out.
function makeRealPowerFft(N) {
  const M = N / 2, bits = Math.log2(M);
  const rev = new Uint32Array(M);
  for (let i = 0; i < M; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(M / 2), sin = new Float64Array(M / 2);
  for (let i = 0; i < M / 2; i++) {
    cos[i] = Math.cos(2 * Math.PI * i / M);
    sin[i] = Math.sin(2 * Math.PI * i / M);
  }
  const re = new Float64Array(M), im = new Float64Array(M);

  return function power(x, offset, win, b0, b1, out) {
    // pack even samples as real, odd as imaginary, in bit-reversed order
    for (let i = 0; i < M; i++) {
      const j = rev[i];
      re[j] = x[offset + 2 * i] * win[2 * i];
      im[j] = x[offset + 2 * i + 1] * win[2 * i + 1];
    }
    // iterative radix-2 butterflies
    for (let size = 2; size <= M; size <<= 1) {
      const halfSize = size >> 1, step = M / size;
      for (let start = 0; start < M; start += size) {
        for (let j = 0; j < halfSize; j++) {
          const wr = cos[j * step], wi = -sin[j * step];
          const a = start + j, b = a + halfSize;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    // unpack the real FFT: X[k] = E[k] + W^k O[k]
    for (let k = b0; k < b1; k++) {
      const a = k % M, b = (M - k) % M;
      const er = (re[a] + re[b]) / 2, ei = (im[a] - im[b]) / 2;
      const or = (im[a] + im[b]) / 2, oi = -(re[a] - re[b]) / 2;
      const wr = Math.cos(Math.PI * k / M), wi = -Math.sin(Math.PI * k / M);
      const xr = er + wr * or - wi * oi, xi = ei + wr * oi + wi * or;
      out[k - b0] = xr * xr + xi * xi;
    }
  };
}

// ---------- Spectrogram ----------
//
// A spectrogram is { off, boff, t0, dt, T, f0, df, F, S }. Row i is STFT frame off + i and column j
// is FFT bin boff + j; t0 and f0 are the time of the first row and frequency of the first column.
// S[i * F + j] is power in dB. Times and frequencies are computed from the absolute frame and bin
// numbers, as numpy does, so crops select exactly the cells the original selects.

const timeAt = (sp, i) => (NPERSEG / 2 + (sp.off + i) * HOP) / SR;
const freqAt = (sp, j) => (sp.boff + j) * (SR / NPERSEG);

// audio.compute_spectrogram: Hann STFT, dB, then whitening. progress(fraction) is optional.
export function spectrogram(x, progress) {
  const frames = Math.floor((x.length - NPERSEG) / HOP) + 1;
  if (frames < 2) throw Error('The audio is too short.');
  const df = SR / NPERSEG;
  const b0 = Math.ceil(FMIN / df), b1 = Math.floor(FMAX / df) + 1, F = b1 - b0;

  const win = new Float64Array(NPERSEG);
  let winSum = 0;
  for (let i = 0; i < NPERSEG; i++) {
    win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NPERSEG);   // periodic Hann, as scipy
    winSum += win[i];
  }
  const scale = 1 / (winSum * winSum);                           // scipy's 'spectrum' scaling
  const power = makeRealPowerFft(NPERSEG);
  const S = new Float32Array(frames * F), p = new Float64Array(F);
  for (let k = 0; k < frames; k++) {
    power(x, k * HOP, win, b0, b1, p);
    for (let j = 0; j < F; j++) S[k * F + j] = 10 * Math.log10(p[j] * scale + 1e-20);
    if (progress && k % 512 === 0) progress(k / frames);
  }
  const sp = { off: 0, boff: b0, t0: NPERSEG / 2 / SR, dt: HOP / SR, T: frames, f0: b0 * df, df, F, S };
  whiten(sp, WHITEN_S);
  return sp;
}

// Subtract from each bin its running median: medians over windowS blocks, blended linearly between
// block centres. This flattens mains hum and steady machinery so only changing tones stand out.
function whiten(sp, windowS) {
  const { T, F, S } = sp;
  const w = Math.floor(windowS / sp.dt);
  const column = new Float32Array(T);

  if (w >= T) {
    for (let j = 0; j < F; j++) {
      for (let i = 0; i < T; i++) column[i] = S[i * F + j];
      const m = median(column);
      for (let i = 0; i < T; i++) S[i * F + j] -= m;
    }
    return;
  }

  const blocks = Math.ceil(T / w);
  const centres = new Float64Array(blocks), blockMedian = new Float64Array(blocks * F);
  for (let b = 0; b < blocks; b++) {
    const start = b * w, end = Math.min((b + 1) * w, T);
    centres[b] = (start + end) / 2;
    for (let j = 0; j < F; j++) {
      for (let i = start; i < end; i++) column[i - start] = S[i * F + j];
      blockMedian[b * F + j] = median(column.subarray(0, end - start));
    }
  }
  // np.interp of the block medians at every frame, held flat beyond the first and last centre
  let b = 0;
  for (let i = 0; i < T; i++) {
    while (b < blocks - 2 && i >= centres[b + 1]) b++;
    const u = Math.min(1, Math.max(0, (i - centres[b]) / (centres[b + 1] - centres[b])));
    for (let j = 0; j < F; j++) S[i * F + j] -= blockMedian[b * F + j] * (1 - u) + blockMedian[(b + 1) * F + j] * u;
  }
}

// Spectrogram.crop: rows with tA <= t <= tB and columns with fA <= f <= fB, as a copy.
function crop(sp, tA, tB, fA, fB) {
  let i0 = 0, i1 = sp.T, j0 = 0, j1 = sp.F;
  while (i0 < sp.T && timeAt(sp, i0) < tA) i0++;
  while (i1 > i0 && timeAt(sp, i1 - 1) > tB) i1--;
  while (j0 < sp.F && freqAt(sp, j0) < fA) j0++;
  while (j1 > j0 && freqAt(sp, j1 - 1) > fB) j1--;
  const T = i1 - i0, F = j1 - j0, S = new Float32Array(T * F);
  for (let i = 0; i < T; i++) S.set(sp.S.subarray((i0 + i) * sp.F + j0, (i0 + i) * sp.F + j1), i * F);
  return { off: sp.off + i0, boff: sp.boff + j0, t0: timeAt(sp, i0), dt: sp.dt, T, f0: freqAt(sp, j0), df: sp.df, F, S };
}

// The crop a fit or scan works on: the window padded by 30 s, the band padded by 30 %.
function bandCrop(sp, tA, tB, fLo, fHi, harmonics) {
  const pad = 0.3 * (fHi - fLo);
  return crop(sp, tA, tB, Math.max(fLo - pad, sp.f0), Math.min(fHi * harmonics + pad, freqAt(sp, sp.F - 1)));
}

// tracks.local_whiten: remove tones steady over this window (per-bin median), clip below at 0. In place.
function localWhiten(sp) {
  const { T, F, S } = sp, column = new Float32Array(T);
  for (let j = 0; j < F; j++) {
    for (let i = 0; i < T; i++) column[i] = S[i * F + j];
    const m = median(column);
    for (let i = 0; i < T; i++) S[i * F + j] = Math.max(S[i * F + j] - m, 0);
  }
  return sp;
}

// scipy maximum_filter1d along frequency. Its reflect mode amounts to clamping the window for a max.
function maxFilterFreq(sp, size) {
  const { T, F, S } = sp, out = new Float32Array(S.length), before = size >> 1;
  for (let i = 0; i < T; i++) {
    for (let j = 0; j < F; j++) {
      let m = -Infinity;
      const lo = Math.max(0, j - before), hi = Math.min(F - 1, j + size - 1 - before);
      for (let k = lo; k <= hi; k++) if (S[i * F + k] > m) m = S[i * F + k];
      out[i * F + j] = m;
    }
  }
  return { ...sp, S: out };
}

// Spectrogram.sample: bilinear; 0 outside the grid or for non-finite coordinates.
function sample(sp, t, f) {
  const ti = (t - sp.t0) / sp.dt, fi = (f - sp.f0) / sp.df;
  if (!(ti >= 0 && ti <= sp.T - 1 && fi >= 0 && fi <= sp.F - 1)) return 0;
  const i0 = Math.floor(ti), j0 = Math.floor(fi);
  const i1 = Math.min(i0 + 1, sp.T - 1), j1 = Math.min(j0 + 1, sp.F - 1);
  const wt = ti - i0, wf = fi - j0, S = sp.S, F = sp.F;
  return S[i0 * F + j0] * (1 - wt) * (1 - wf) + S[i1 * F + j0] * wt * (1 - wf)
    + S[i0 * F + j1] * (1 - wt) * wf + S[i1 * F + j1] * wt * wf;
}

// tracks.curve_contrast: brightness on the curve minus the mean of two sidebands. A broadband burst
// is as bright off the curve as on it and scores about 0.
function contrast(sp, t, f) {
  return sample(sp, t, f) - 0.5 * (sample(sp, t, f * (1 + CONTRAST_DF)) + sample(sp, t, f * (1 - CONTRAST_DF)));
}

// ---------- Doppler physics ----------

// doppler.ideal_curve: frequency heard at times tObs from a straight, constant-speed pass with rest
// frequency f0, speed v (m/s), closest slant distance d (m) and emission-time CPA tCpa (s).
// Emission-time kinematics: what is heard at te + r/c was emitted at te. NaN outside the pass.
export function idealCurve(tObs, f0, v, d, tCpa, c = speedOfSound(), span = 600, n = 4001) {
  const heardAt = new Float64Array(n), freq = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const tau = -span + 2 * span * i / (n - 1);
    const r = Math.sqrt(d * d + (v * tau) ** 2), rangeRate = v * v * tau / r;
    freq[i] = f0 * c / (c + rangeRate);
    heardAt[i] = tCpa + tau + r / c;
  }
  return Float64Array.from(tObs, t => interp(t, heardAt, freq));
}

// tracks._shape: observation-time offsets and frequency ratios of a straight pass, relative to the
// emission-time CPA.
function passShape(v, d, c, span = 400, n = 161) {
  const offset = new Float64Array(n), ratio = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const tau = -span + 2 * span * i / (n - 1);
    const r = Math.sqrt(d * d + (v * tau) ** 2), rangeRate = v * v * tau / r;
    offset[i] = tau + r / c;
    ratio[i] = c / (c + rangeRate);
  }
  return [offset, ratio];
}

// tracks.sweep_weights for one curve: |d ratio / dt| normalised to a peak of 1, plus SWEEP_FLOOR.
// The sweeping part carries the information; flat tails would fit any steady tone.
function sweepWeights(ratio, t) {
  const g = gradient(ratio, t);
  let peak = 0;
  for (let i = 0; i < g.length; i++) {
    g[i] = Number.isFinite(g[i]) ? Math.abs(g[i]) : 0;
    if (g[i] > peak) peak = g[i];
  }
  peak = Math.max(peak, 1e-12);
  for (let i = 0; i < g.length; i++) g[i] = g[i] / peak + SWEEP_FLOOR;
  return g;
}

// ---------- Fitting ----------

// tracks.grid_search with the contrast objective: for each emission-CPA time t0, the best
// (f0, v, d) by sweep-weighted ridge contrast. The curve is always sampled at the same times tq, so
// the time half of each bilinear lookup is done once per tq and only frequency varies inside the loop.
// Returns { t0s, best: score per t0, params: [f0, v, d] per t0 }.
function gridSearch(win, tStart, tEnd, fLo, fHi, c, harmonics = 1, options = {}) {
  const sp = maxFilterFreq(win, options.fatBins ?? 5);
  const vGrid = options.vGrid ?? arange(30, 170, 10);
  const dGrid = options.dGrid ?? geomspace(300, 9000, 14);
  const [fA, fB] = options.f0Range ?? [fLo * 1.15, fHi * 0.85];
  const [tA, tB] = options.t0Range ?? [tStart, tEnd];
  const f0s = arange(fA, fB, options.f0Step ?? 1), t0s = arange(tA, tB, options.t0Step ?? 1);
  const nCurve = options.nCurve ?? 120, tq = linspace(tStart, tEnd, nCurve);
  const F = sp.F;

  const columns = Array.from(tq, t => {
    const ti = (t - sp.t0) / sp.dt;
    if (!(ti >= 0 && ti <= sp.T - 1)) return null;
    const i0 = Math.floor(ti), i1 = Math.min(i0 + 1, sp.T - 1), wt = ti - i0;
    const column = new Float64Array(F);
    for (let j = 0; j < F; j++) column[j] = sp.S[i0 * F + j] * (1 - wt) + sp.S[i1 * F + j] * wt;
    return column;
  });
  const at = (column, f) => {
    const fi = (f - sp.f0) / sp.df;
    if (!(fi >= 0 && fi <= F - 1)) return 0;
    const j0 = Math.floor(fi), j1 = Math.min(j0 + 1, F - 1), wf = fi - j0;
    return column[j0] * (1 - wf) + column[j1] * wf;
  };

  const best = new Float64Array(t0s.length).fill(-Infinity);
  const params = Array.from(t0s, () => [0, 0, 0]);
  const total = new Float64Array(f0s.length), ratio = new Float64Array(nCurve);
  for (const v of vGrid) {
    for (const d of dGrid) {
      const [offset, shapeRatio] = passShape(v, d, c);
      for (let a = 0; a < t0s.length; a++) {
        for (let n = 0; n < nCurve; n++) ratio[n] = interp(tq[n] - t0s[a], offset, shapeRatio);
        const w = sweepWeights(ratio, tq);
        let wSum = 0;
        for (let n = 0; n < nCurve; n++) {
          if (Number.isNaN(ratio[n])) w[n] = 0;
          wSum += w[n];
        }
        wSum = Math.max(wSum, 1e-12);
        total.fill(0);
        for (let n = 0; n < nCurve; n++) {
          const column = columns[n];
          if (w[n] === 0 || !column) continue;
          for (let h = 1; h <= harmonics; h++) {
            const hr = h * ratio[n];
            for (let k = 0; k < f0s.length; k++) {
              const f = f0s[k] * hr;
              total[k] += w[n] * (at(column, f) - 0.5 * (at(column, f * (1 + CONTRAST_DF)) + at(column, f * (1 - CONTRAST_DF))));
            }
          }
        }
        let kBest = 0, sBest = -Infinity;
        for (let k = 0; k < f0s.length; k++) {
          const s = total[k] / wSum / harmonics;
          if (s > sBest) { sBest = s; kBest = k; }
        }
        if (sBest > best[a]) {
          best[a] = sBest;
          params[a] = [f0s[kBest], v, d];
        }
      }
    }
  }
  return { t0s, best, params };
}

// scipy.optimize.minimize(method="Nelder-Mead") from a given initial simplex, as fit_event calls it.
function nelderMead(fn, initialSimplex, { xatol = 1e-2, fatol = 1e-4, maxiter = 4000 } = {}) {
  const N = initialSimplex[0].length;
  let sim = initialSimplex.map(p => Float64Array.from(p));
  let fsim = sim.map(fn);
  const combine = (a, xa, b, xb) => Float64Array.from(xa, (_, i) => a * xa[i] + b * xb[i]);
  const sortSimplex = () => {
    const order = fsim.map((_, i) => i).sort((p, q) => fsim[p] - fsim[q]);
    sim = order.map(i => sim[i]);
    fsim = order.map(i => fsim[i]);
  };

  sortSimplex();
  for (let iteration = 1; iteration < maxiter; iteration++) {
    let dx = 0, df = 0;
    for (let k = 1; k <= N; k++) {
      for (let i = 0; i < N; i++) dx = Math.max(dx, Math.abs(sim[k][i] - sim[0][i]));
      df = Math.max(df, Math.abs(fsim[0] - fsim[k]));
    }
    if (dx <= xatol && df <= fatol) break;

    const centroid = new Float64Array(N);
    for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) centroid[i] += sim[k][i] / N;
    const worst = sim[N];
    const reflected = combine(2, centroid, -1, worst), fReflected = fn(reflected);
    let shrink = false;

    if (fReflected < fsim[0]) {
      const expanded = combine(3, centroid, -2, worst), fExpanded = fn(expanded);
      if (fExpanded < fReflected) { sim[N] = expanded; fsim[N] = fExpanded; }
      else { sim[N] = reflected; fsim[N] = fReflected; }
    } else if (fReflected < fsim[N - 1]) {
      sim[N] = reflected; fsim[N] = fReflected;
    } else if (fReflected < fsim[N]) {
      const outside = combine(1.5, centroid, -0.5, worst), fOutside = fn(outside);
      if (fOutside <= fReflected) { sim[N] = outside; fsim[N] = fOutside; } else shrink = true;
    } else {
      const inside = combine(0.5, centroid, 0.5, worst), fInside = fn(inside);
      if (fInside < fsim[N]) { sim[N] = inside; fsim[N] = fInside; } else shrink = true;
    }
    if (shrink) {
      for (let k = 1; k <= N; k++) {
        sim[k] = combine(0.5, sim[0], 0.5, sim[k]);
        fsim[k] = fn(sim[k]);
      }
    }
    sortSimplex();
  }
  return { x: sim[0], fun: fsim[0] };
}

// tracks.fit_event with the contrast objective, narrowed around init = [f0, v, d, t0Emit]: a local
// grid search, then Nelder-Mead on the unfiltered window.
function fitEvent(sp, tStart, tEnd, fLo, fHi, c, harmonics, init, vBounds, dBounds) {
  const win = localWhiten(bandCrop(sp, tStart - 30, tEnd + 30, fLo, fHi, harmonics));
  let [f0, v, d, t0] = init;
  const grid = gridSearch(win, tStart, tEnd, fLo, fHi, c, harmonics, {
    t0Range: [t0 - 30, t0 + 30],
    f0Range: [Math.max(f0 - 12, 1), f0 + 12],
  });
  if (grid.t0s.length) {
    let a = 0;
    for (let k = 1; k < grid.best.length; k++) if (grid.best[k] > grid.best[a]) a = k;
    [f0, v, d] = grid.params[a];
    t0 = grid.t0s[a];
  }

  const tt = linspace(tStart, tEnd, 400);
  const negScore = ([f0_, v_, d_, t0_]) => {
    if (!(vBounds[0] < v_ && v_ < vBounds[1] && dBounds[0] < d_ && d_ < dBounds[1])) return 1e3;
    const base = idealCurve(tt, f0_, v_, d_, t0_, c);
    const w = sweepWeights(base.map(f => f / f0_), tt);
    let s = 0;
    for (let h = 1; h <= harmonics; h++) {
      let num = 0, den = 0;
      for (let n = 0; n < tt.length; n++) {
        num += w[n] * contrast(win, tt[n], h * base[n]);
        den += w[n];
      }
      s += num / den;
    }
    return -s / harmonics;
  };
  const fit = nelderMead(negScore, [
    [f0, v, d, t0], [f0 + 2, v, d, t0], [f0, v + 10, d, t0], [f0, v, d * 1.3, t0], [f0, v, d, t0 + 2],
  ]);
  [f0, v, d, t0] = fit.x;
  return {
    t_cpa: t0 + d / c,        // heard CPA time in the recording, s
    t_cpa_emit: t0,           // emission-time CPA, s
    f0, v, d,                 // rest fundamental (Hz), speed (m/s), CPA slant distance (m)
    t_start: tStart, t_end: tEnd,
    score: -fit.fun,          // sweep-weighted ridge contrast, dB
    f_pre: f0 * c / (c - v), f_post: f0 * c / (c + v),
    burst: 0,
  };
}

// tracks.burst_mask: frames where the whole band is loud at once (a passing truck or train, whose
// engine tone also sweeps). The per-frame median over frequency, smoothed, above median + 3 sigma.
function burstMask(sp, smoothS = 10, nSigma = 3) {
  const { T, F, S } = sp;
  const level = new Float64Array(T);
  for (let i = 0; i < T; i++) level[i] = median(S.subarray(i * F, (i + 1) * F));
  const k = Math.max(Math.round(smoothS / sp.dt), 1), left = k >> 1;   // np.convolve(..., "same")
  const smooth = new Float64Array(T);
  for (let i = 0; i < T; i++) {
    let s = 0;
    for (let m = i - left; m < i - left + k; m++) if (m >= 0 && m < T) s += level[m];
    smooth[i] = s / k;
  }
  const sorted = Float64Array.from(smooth).sort();
  const sigma = (quantileSorted(sorted, 0.84) - quantileSorted(sorted, 0.16)) / 2;
  const threshold = quantileSorted(sorted, 0.5) + nSigma * sigma;
  return Uint8Array.from(smooth, v => (v > threshold ? 1 : 0));
}

// tracks.detect_events: scan the recording for Doppler-shaped curves whose fundamental lies in
// [fLo, fHi]. A coarse grid search runs in sliding windows; the best local maxima are merged (one per
// minSepS), refined with fitEvent, and the best `top` returned by score. progress(fraction) is optional.
export function detectEvents(sp, options = {}, progress) {
  const {
    fLo = 60, fHi = 300, harmonics = 1, windowS = 240, stepS = 120,
    top = 10, perWindow = 3, minSepS = 60, c = speedOfSound(),
  } = options;
  const vGrid = arange(40, 170, 13), dGrid = geomspace(400, 9000, 10);
  const tFirst = sp.t0, tLast = timeAt(sp, sp.T - 1);
  const starts = arange(tFirst, Math.max(tLast - windowS, tFirst) + 1e-9, stepS);
  const steps = starts.length + 2 * top;

  // coarse scan: up to perWindow maxima per window, separated by minSepS
  const candidates = [];   // [score, f0, v, d, t0]
  starts.forEach((t, s) => {
    const tEnd = Math.min(t + windowS, tLast);
    const win = localWhiten(bandCrop(sp, t - 30, tEnd + 30, fLo, fHi, harmonics));
    const { t0s, best, params } = gridSearch(win, t, tEnd, fLo, fHi, c, harmonics,
      { vGrid, dGrid, f0Step: 2, t0Step: 2, nCurve: 80 });
    const order = Array.from(best.keys()).sort((a, b) => best[b] - best[a]);
    const found = [];
    for (const i of order) {
      if (found.every(o => Math.abs(t0s[i] - o[4]) >= minSepS)) found.push([best[i], ...params[i], t0s[i]]);
      if (found.length >= perWindow) break;
    }
    candidates.push(...found);
    progress?.((s + 1) / steps);
  });

  // merge across windows (Python sorts the tuples descending), keep twice as many as wanted
  candidates.sort((a, b) => {
    for (let k = 0; k < 5; k++) if (a[k] !== b[k]) return b[k] - a[k];
    return 0;
  });
  const keep = [];
  for (const cand of candidates) {
    if (keep.every(k => Math.abs(cand[4] - k[4]) >= minSepS)) keep.push(cand);
    if (keep.length >= 2 * top) break;
  }

  // refine, then drop fits that converged onto the same event
  const fits = keep.map(([, f0, v, d, t0], i) => {
    const fit = fitEvent(sp, Math.max(t0 - 120, tFirst), Math.min(t0 + 120, tLast), fLo, fHi, c, harmonics,
      [f0, v, d, t0], [35, 200], [200, 15000]);
    progress?.((starts.length + i + 1) / steps);
    return fit;
  });
  fits.sort((a, b) => b.score - a.score);
  const events = [];
  for (const e of fits) {
    if (events.every(f => Math.abs(e.t_cpa - f.t_cpa) >= minSepS)) events.push(e);
    if (events.length >= top) break;
  }

  // share of the 3 minutes around each CPA that is a broadband burst
  const mask = burstMask(sp);
  for (const e of events) {
    let n = 0, hits = 0;
    for (let i = 0; i < sp.T; i++) {
      const t = timeAt(sp, i);
      if (t >= e.t_cpa - 90 && t <= e.t_cpa + 90) { n++; hits += mask[i]; }
    }
    e.burst = n ? hits / n : 0;
  }
  return events;
}

// ---------- Rendering ----------

// Inferno, sampled at tenths of matplotlib's table.
const INFERNO = [
  [0, 0, 4], [22, 11, 57], [66, 10, 104], [106, 23, 110], [147, 38, 103], [188, 55, 84],
  [221, 81, 58], [243, 120, 25], [252, 165, 10], [246, 215, 70], [252, 255, 164],
];
const LUT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
  const x = i / 255 * 10, k = Math.min(9, Math.floor(x)), u = x - k;
  for (let ch = 0; ch < 3; ch++) LUT[i * 3 + ch] = Math.round(INFERNO[k][ch] * (1 - u) + INFERNO[k + 1][ch] * u);
}

// RGBA pixels (w x h) of rows [i0, i1) (fractional) across the whole band, high frequencies at the
// top. Each pixel is the mean of the cells it covers; lo..hi dB spans the colour scale.
export function renderView(sp, i0, i1, w, h, lo, hi) {
  const { T, F, S } = sp;
  const out = new Uint8ClampedArray(w * h * 4);
  const scale = 255 / Math.max(hi - lo, 1e-6);
  const binFrom = new Int32Array(h), binTo = new Int32Array(h);
  for (let y = 0; y < h; y++) {
    binFrom[y] = Math.min(F - 1, Math.floor((h - 1 - y) * F / h));
    binTo[y] = Math.max(binFrom[y] + 1, Math.min(F, Math.floor((h - y) * F / h)));
  }
  const column = new Float64Array(F), perPixel = (i1 - i0) / w;
  for (let x = 0; x < w; x++) {
    const a = i0 + x * perPixel;
    const from = Math.max(0, Math.floor(a)), to = Math.min(T, Math.max(Math.floor(a) + 1, Math.floor(a + perPixel)));
    if (to <= from) {   // outside the recording: black
      for (let y = 0; y < h; y++) out[(y * w + x) * 4 + 3] = 255;
      continue;
    }
    column.fill(0);
    for (let i = from; i < to; i++) for (let j = 0; j < F; j++) column[j] += S[i * F + j];
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let j = binFrom[y]; j < binTo[y]; j++) s += column[j];
      s /= (to - from) * (binTo[y] - binFrom[y]);
      const v = Math.max(0, Math.min(255, Math.round((s - lo) * scale)));
      const p = (y * w + x) * 4;
      out[p] = LUT[v * 3]; out[p + 1] = LUT[v * 3 + 1]; out[p + 2] = LUT[v * 3 + 2]; out[p + 3] = 255;
    }
  }
  return out;
}
