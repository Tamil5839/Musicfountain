// Onset picking, tempo estimation and dynamic-programming beat tracking (Ellis 2007),
// plus downbeat (bar start) estimation.

import type { Onset } from '../types';
import type { FrameFeatures } from './features';
import { clamp01, mean, movingAverage, percentile, std, toDb } from './util';

/**
 * Frames are centered on `f * hop`; the flux of a sharp onset peaks slightly before the
 * true attack because of the long window. Measured on synthetic material: this constant
 * shifts detected onsets back onto the attack.
 */
export const ONSET_LATENCY = 0.0;

export function frameTime(f: number, feat: FrameFeatures): number {
  return (f * feat.hop) / feat.sr + ONSET_LATENCY;
}

/** Adaptive-threshold peak picking on an onset detection function. */
export function pickOnsets(
  odf: Float32Array,
  feat: FrameFeatures,
  opts: { minGap: number; delta: number; window?: number },
): Onset[] {
  const fps = feat.fps;
  const n = odf.length;
  const smooth = movingAverage(odf, 3);
  const localMean = movingAverage(smooth, Math.round((opts.window ?? 0.3) * fps) | 1);
  const scale = Math.max(1e-6, percentile(smooth, 98));
  const sd = std(smooth);
  const minGapF = Math.round(opts.minGap * fps);
  const w = 3;
  const out: Onset[] = [];
  let last = -1e9;
  for (let i = w; i < n - w; i++) {
    const v = smooth[i];
    let isMax = true;
    for (let j = i - w; j <= i + w; j++) {
      if (smooth[j] > v || (smooth[j] === v && j < i)) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    if (v < localMean[i] + opts.delta * sd) continue;
    if (v < scale * 0.08) continue;
    if (i - last < minGapF) {
      // keep the stronger of two close peaks
      const prev = out[out.length - 1];
      const s = clamp01(v / scale);
      if (prev && s > prev.s) {
        prev.t = frameTime(i, feat);
        prev.s = s;
        last = i;
      }
      continue;
    }
    out.push({ t: frameTime(i, feat), s: clamp01(v / scale) });
    last = i;
  }
  return out;
}

export interface TempoResult {
  bpm: number;
  /** beat period in frames (float) */
  period: number;
  /** 0..1 autocorrelation peak prominence */
  prominence: number;
}

/** Onset strength envelope used for tempo + beat tracking: detrended, std-normalized. */
export function onsetEnvelope(feat: FrameFeatures): Float32Array {
  const n = feat.count;
  const raw = new Float32Array(n);
  const kScale = Math.max(1e-6, percentile(feat.fluxKick, 99));
  const aScale = Math.max(1e-6, percentile(feat.fluxAll, 99));
  for (let i = 0; i < n; i++) raw[i] = feat.fluxAll[i] / aScale + 1.0 * (feat.fluxKick[i] / kScale);
  const trend = movingAverage(raw, Math.round(feat.fps * 0.5) | 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(0, raw[i] - trend[i]);
  const sd = std(out) || 1;
  for (let i = 0; i < n; i++) out[i] /= sd;
  return out;
}

export function estimateTempo(env: Float32Array, fps: number): TempoResult {
  const n = env.length;
  const lagMin = Math.max(2, Math.floor((60 * fps) / 210));
  const lagMax = Math.min(n - 1, Math.ceil((60 * fps) / 55));
  const m = mean(env);
  const acf = new Float32Array(lagMax * 3 + 2);
  const maxLag = Math.min(acf.length - 1, n - 1);
  let a0 = 0;
  for (let i = 0; i < n; i++) a0 += (env[i] - m) * (env[i] - m);
  for (let L = 1; L <= maxLag; L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += (env[i] - m) * (env[i + L] - m);
    acf[L] = s / Math.max(1e-9, a0);
  }
  let best = -Infinity;
  let bestL = lagMin;
  const score = new Float32Array(lagMax + 1);
  for (let L = lagMin; L <= lagMax; L++) {
    const bpm = (60 * fps) / L;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    let s = acf[L];
    if (2 * L < acf.length) s += 0.5 * acf[2 * L];
    if (4 * L < acf.length) s += 0.25 * acf[4 * L];
    score[L] = prior * s;
    if (score[L] > best) {
      best = score[L];
      bestL = L;
    }
  }
  // parabolic refinement on the raw acf
  let period = bestL;
  if (bestL > lagMin && bestL < lagMax) {
    const y0 = acf[bestL - 1];
    const y1 = acf[bestL];
    const y2 = acf[bestL + 1];
    const d = y0 - 2 * y1 + y2;
    if (Math.abs(d) > 1e-9) period = bestL + (0.5 * (y0 - y2)) / d;
  }
  let bpm = (60 * fps) / period;
  // keep the choreography in a musical range
  if (bpm > 175) {
    bpm /= 2;
    period *= 2;
  } else if (bpm < 62) {
    const half = Math.round(bestL / 2);
    if (half >= 2 && acf[half] > 0.55 * acf[bestL]) {
      bpm *= 2;
      period /= 2;
    }
  }
  const slice: number[] = [];
  for (let L = lagMin; L <= lagMax; L++) slice.push(acf[L]);
  slice.sort((a, b) => a - b);
  const med = slice[slice.length >> 1] ?? 0;
  const prominence = clamp01((acf[bestL] - med) * 2.5);
  return { bpm, period, prominence };
}

/** Ellis-style DP beat tracker. Returns beat frame indices. */
export function trackBeats(env: Float32Array, period: number, tightness = 100): number[] {
  const n = env.length;
  if (n < period * 4) return [];
  // local score: onset env smoothed by a gaussian of width period/32
  const sigma = Math.max(1, period / 32);
  const half = Math.ceil(sigma * 3);
  const kern: number[] = [];
  for (let i = -half; i <= half; i++) kern.push(Math.exp(-0.5 * (i / sigma) ** 2));
  const local = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < n) s += env[j] * kern[k + half];
    }
    local[i] = s;
  }
  const cum = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const wMin = Math.round(period / 2);
  const wMax = Math.round(period * 2);
  const txCost = new Float32Array(wMax + 1);
  for (let d = wMin; d <= wMax; d++) txCost[d] = -tightness * Math.pow(Math.log(d / period), 2);
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let bi = -1;
    for (let d = wMin; d <= wMax; d++) {
      const j = i - d;
      if (j < 0) break;
      const v = cum[j] + txCost[d];
      if (v > best) {
        best = v;
        bi = j;
      }
    }
    cum[i] = local[i] + (bi >= 0 ? Math.max(0, best) : 0);
    back[i] = bi >= 0 && best > 0 ? bi : -1;
  }
  // last beat: last local max of cum above half the median of local maxima
  const maxima: number[] = [];
  for (let i = 1; i < n - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) maxima.push(cum[i]);
  maxima.sort((a, b) => a - b);
  const med = maxima.length ? maxima[maxima.length >> 1] : 0;
  let last = n - 1;
  for (let i = n - 2; i > 0; i--) {
    if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1] && 2 * cum[i] > med) {
      last = i;
      break;
    }
  }
  const beats: number[] = [];
  let b = last;
  while (b >= 0) {
    beats.push(b);
    b = back[b];
  }
  beats.reverse();
  return beats;
}

export interface BeatGrid {
  bpm: number;
  confidence: number;
  beats: number[];
  downbeats: number[];
  beatsPerBar: number;
}

/**
 * Full beat pipeline. `outside(t)` tells whether a time is outside the audible part of the
 * song so we can trim beats that the DP tracker invents in leading / trailing silence.
 */
export function beatGrid(feat: FrameFeatures, outside: (t: number) => boolean): BeatGrid {
  const env = onsetEnvelope(feat);
  const tempo = estimateTempo(env, feat.fps);
  const frames = trackBeats(env, tempo.period);
  const correctedFrames = correctHalfBeatPhase(frames, feat, tempo.period);
  let beats = correctedFrames.map((f) => frameTime(f, feat));
  beats = beats.filter((t) => !outside(t));

  // --- confidence: how much onset energy sits on the beats vs. everywhere else
  let onBeat = 0;
  for (const f of correctedFrames) {
    let m = 0;
    for (let k = -2; k <= 2; k++) {
      const j = f + k;
      if (j >= 0 && j < env.length) m = Math.max(m, env[j]);
    }
    onBeat += m;
  }
  onBeat /= Math.max(1, correctedFrames.length);
  // expected max of 5 consecutive frames anywhere
  let offBeat = 0;
  let cnt = 0;
  for (let i = 2; i < env.length - 2; i += 7) {
    offBeat += Math.max(env[i - 2], env[i - 1], env[i], env[i + 1], env[i + 2]);
    cnt++;
  }
  offBeat /= Math.max(1, cnt);
  const ratio = onBeat / Math.max(1e-6, offBeat);
  const ibis: number[] = [];
  for (let i = 1; i < beats.length; i++) ibis.push(beats[i] - beats[i - 1]);
  const ibiMean = mean(ibis);
  const ibiCv = ibis.length ? std(ibis) / Math.max(1e-6, ibiMean) : 1;
  const confidence =
    clamp01((ratio - 1.15) / 1.3) * 0.55 + tempo.prominence * 0.3 + clamp01(1 - ibiCv * 8) * 0.15;

  const { downbeats, meter } = trackDownbeats(beats, feat, tempo.period);

  return {
    bpm: beats.length > 4 ? 60 / regressionPeriod(beats) : tempo.bpm,
    confidence: beats.length > 8 ? confidence : 0,
    beats,
    downbeats,
    beatsPerBar: meter,
  };
}

/** Least-squares beat period that ignores the occasional dropped/extra beat. */
function regressionPeriod(beats: number[]): number {
  const ibis: number[] = [];
  for (let i = 1; i < beats.length; i++) ibis.push(beats[i] - beats[i - 1]);
  const med = median(ibis);
  // accumulate only "clean" intervals
  let sum = 0;
  let c = 0;
  for (const d of ibis) {
    if (Math.abs(d - med) < 0.2 * med) {
      sum += d;
      c++;
    }
  }
  return c ? sum / c : med;
}

/**
 * The DP tracker can lock onto off-beats when an off-beat bass line has sharper attacks than
 * the kick. In windows of 8 beats, compare kick-band energy on the beat vs. half a beat later
 * and shift the window by half a period when the off-beat is clearly the kick.
 */
function correctHalfBeatPhase(frames: number[], feat: FrameFeatures, period: number): number[] {
  if (frames.length < 16) return frames;
  const half = Math.round(period / 2);
  const kickAt = (f: number) => {
    let m = 0;
    for (let k = -2; k <= 2; k++) {
      const j = f + k;
      if (j >= 0 && j < feat.count) m = Math.max(m, feat.fluxKick[j] * (0.5 + feat.fluxFlat[j]));
    }
    return m;
  };
  const onK = frames.map((f) => kickAt(f));
  const offK = frames.map((f) => kickAt(f + half));
  const shift = new Array(frames.length).fill(false);
  const W = 8;
  for (let i = 0; i < frames.length; i++) {
    let on = 0;
    let off = 0;
    for (let j = Math.max(0, i - W / 2); j < Math.min(frames.length, i + W / 2); j++) {
      on += onK[j];
      off += offK[j];
    }
    shift[i] = off > 1.6 * on && off > 1e-3;
  }
  // only shift runs of at least 8 beats to avoid jitter
  const out = frames.slice();
  let i = 0;
  while (i < frames.length) {
    if (!shift[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < frames.length && shift[j]) j++;
    if (j - i >= 8) for (let k = i; k < j; k++) out[k] = Math.min(feat.count - 1, frames[k] + half);
    i = j;
  }
  // keep strictly increasing
  for (let k = 1; k < out.length; k++) if (out[k] <= out[k - 1]) out[k] = out[k - 1] + 1;
  return out;
}

/**
 * Downbeats with a small Viterbi over "position in bar". Each beat gets a downbeat score from
 * harmonic change + kick + bass − backbeat snare; the path may re-phase (e.g. after a dropped
 * beat) at a cost. Tries 4/4 and 3/4.
 */
function trackDownbeats(beats: number[], feat: FrameFeatures, period: number): { downbeats: number[]; meter: number } {
  if (beats.length < 8) return { downbeats: beats.filter((_, i) => i % 4 === 0), meter: 4 };
  const fr = beats.map((t) => Math.round(t * feat.fps));
  const chromaSpan = (f0: number, f1: number) => {
    const c = new Float32Array(12);
    for (let f = Math.max(0, f0); f < Math.min(feat.count, f1); f++) for (let k = 0; k < 12; k++) c[k] += feat.chroma[f * 12 + k];
    let nrm = 0;
    for (let k = 0; k < 12; k++) nrm += c[k] * c[k];
    nrm = Math.sqrt(nrm) || 1;
    for (let k = 0; k < 12; k++) c[k] /= nrm;
    return c;
  };
  const P = Math.round(period);
  const change: number[] = [];
  const kick: number[] = [];
  const low: number[] = [];
  const snare: number[] = [];
  for (let i = 0; i < fr.length; i++) {
    const f = fr[i];
    // harmony just after vs just before this beat (one beat each side)
    const after = chromaSpan(f, f + P);
    const before = chromaSpan(f - P, f);
    let dot = 0;
    for (let k = 0; k < 12; k++) dot += after[k] * before[k];
    change.push(1 - dot);
    let kk = 0;
    let ll = 0;
    let ss = 0;
    for (let j = Math.max(0, f - 2); j <= Math.min(feat.count - 1, f + 3); j++) {
      kk = Math.max(kk, feat.fluxKick[j]);
      ll = Math.max(ll, feat.lowE[j]);
      ss = Math.max(ss, feat.fluxMid[j] * feat.fluxFlat[j]);
    }
    kick.push(kk);
    low.push(toDb(Math.sqrt(ll)));
    snare.push(ss);
  }
  const z = (arr: number[]) => {
    const m = mean(arr);
    const s = std(arr) || 1;
    return arr.map((v) => (v - m) / s);
  };
  const zc = z(change);
  const zk = z(kick);
  const zl = z(low);
  const zs = z(snare);
  const score = beats.map((_, i) => zc[i] + 0.45 * zk[i] + 0.35 * zl[i] - 0.35 * zs[i]);

  const run = (M: number) => {
    const n = beats.length;
    const J = 7; // cost of a re-phase
    let prev = new Float64Array(M);
    const back: Int8Array[] = [];
    for (let p = 0; p < M; p++) prev[p] = p === 0 ? score[0] : -score[0] / (M - 1);
    for (let i = 1; i < n; i++) {
      const cur = new Float64Array(M);
      const bk = new Int8Array(M);
      for (let p = 0; p < M; p++) {
        let best = -Infinity;
        let bi = 0;
        for (let q = 0; q < M; q++) {
          const v = prev[q] - ((q + 1) % M === p ? 0 : J);
          if (v > best) {
            best = v;
            bi = q;
          }
        }
        cur[p] = best + (p === 0 ? score[i] : -score[i] / (M - 1));
        bk[p] = bi;
      }
      back.push(bk);
      prev = cur;
    }
    let p = 0;
    for (let q = 1; q < M; q++) if (prev[q] > prev[p]) p = q;
    const total = prev[p];
    const pos = new Array(n).fill(0);
    pos[n - 1] = p;
    for (let i = n - 1; i > 0; i--) {
      p = back[i - 1][p];
      pos[i - 1] = p;
    }
    return { total: total / n, pos };
  };
  const r4 = run(4);
  const r3 = run(3);
  const use3 = r3.total > r4.total + 0.25;
  const best = use3 ? r3 : r4;
  return { downbeats: beats.filter((_, i) => best.pos[i] === 0), meter: use3 ? 3 : 4 };
}

function median(a: number[]): number {
  if (!a.length) return 0.5;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

