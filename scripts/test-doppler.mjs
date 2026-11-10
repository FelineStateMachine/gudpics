// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Doppler detection on synthetic recordings: a close propeller pass in noise must be found with its
// parameters, also after decimation from 16 kHz; noise with mains hum and a passing truck must not be
// called a flyover. Run: node scripts/test-doppler.mjs

import assert from 'node:assert/strict';
import { SR, decimate, spectrogram, detectEvents, idealCurve, isFlyover, speedOfSound } from '../dopplercore.mjs';

function rng(seed) {
  let s = seed >>> 0;
  const uniform = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

function noise(seconds, rate, seed, sigma = 0.4) {
  const normal = rng(seed), x = new Float32Array(Math.round(seconds * rate));
  let a = 0, b = 0;
  for (let i = 0; i < x.length; i++) {   // three-tap smoothing tilts it towards pink
    const n = normal();
    x[i] = sigma * (a + b + n) / 3;
    a = b; b = n;
  }
  return x;
}

// A pass heard by the microphone: fundamental and second harmonic, louder near closest approach.
function addFlyover(x, rate, { f0, v, d, t0, amp }) {
  const c = speedOfSound(), times = Float64Array.from({ length: x.length }, (_, i) => i / rate);
  const freq = idealCurve(times, f0, v, d, t0, c, 900, 20001);
  let phase = 0;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(freq[i])) continue;
    phase += 2 * Math.PI * freq[i] / rate;
    const env = Math.sqrt(Math.max(0, 1 - Math.abs(times[i] - (t0 + d / c)) / 400));
    x[i] += amp * env * (Math.sin(phase) + 0.4 * Math.sin(2 * phase));
  }
}

function addHum(x, rate, f, amp) {
  for (let i = 0; i < x.length; i++) x[i] += amp * Math.sin(2 * Math.PI * f * i / rate);
}

function addBurst(x, rate, from, to, sigma, seed) {
  const normal = rng(seed);
  for (let i = Math.round(from * rate); i < Math.round(to * rate); i++) x[i] += sigma * normal();
}

const pass = { f0: 130, v: 55, d: 600, t0: 40, amp: 0.04 };
const heardCpa = pass.t0 + pass.d / speedOfSound();

function checkPass(events, label) {
  const found = events.filter(isFlyover);
  assert.equal(found.length, 1, `${label}: expected one flyover, got ${JSON.stringify(found)}`);
  const e = found[0];
  assert.ok(Math.abs(e.t_cpa - heardCpa) < 3, `${label}: CPA ${e.t_cpa} vs ${heardCpa}`);
  assert.ok(Math.abs(e.f0 - pass.f0) < 2, `${label}: f0 ${e.f0}`);
  assert.ok(Math.abs(e.v - pass.v) < 10, `${label}: speed ${e.v}`);
  assert.ok(Math.abs(e.d - pass.d) / pass.d < 0.3, `${label}: distance ${e.d}`);
  console.log(`${label}: CPA ${e.t_cpa.toFixed(1)} s, ${e.f0.toFixed(1)} Hz, ${e.v.toFixed(1)} m/s, ${e.d.toFixed(0)} m, score ${e.score.toFixed(2)} dB`);
}

// 90 s clip with one close pass, analysed at 4 kHz
{
  const x = noise(90, SR, 1);
  addFlyover(x, SR, pass);
  checkPass(detectEvents(spectrogram(x)), '4 kHz clip');
}

// the same pass recorded at 16 kHz and decimated
{
  const rate = 16000, x = noise(90, rate, 2, 0.4 * 2);   // same noise power per Hz in the band
  addFlyover(x, rate, pass);
  checkPass(detectEvents(spectrogram(decimate(x, rate))), '16 kHz clip');
}

// 4 minutes of noise, hum and a truck: nothing should be called a flyover
{
  const x = noise(240, SR, 3);
  addHum(x, SR, 60, 0.05);
  addHum(x, SR, 120, 0.03);
  addBurst(x, SR, 100, 125, 1.2, 4);
  const events = detectEvents(spectrogram(x));
  const best = Math.max(...events.map(e => e.score));
  assert.equal(events.filter(isFlyover).length, 0, `noise: ${JSON.stringify(events.filter(isFlyover))}`);
  console.log(`noise, hum and a truck: no flyovers (best event ${best.toFixed(2)} dB)`);
}

console.log('ok');
