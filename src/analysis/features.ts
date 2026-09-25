// Short-time spectral features computed in a single pass over the song.
// Everything here is plain math on typed arrays so it runs in a worker (or Node for tests).

import { FFT } from './fft';

export const ANALYSIS_SR = 22050;
export const FRAME = 2048;
export const HOP = 256;

export interface FrameFeatures {
  sr: number;
  hop: number;
  /** frames per second */
  fps: number;
  count: number;
  /** RMS of the (unwindowed) frame, linear */
  rms: Float32Array;
  /** Log-magnitude spectral flux, whole spectrum up to 8 kHz */
  fluxAll: Float32Array;
  /**
   * Band-limited onset functions: kick (<150 Hz, linear amplitude rise so a loud kick beats a
   * sustained bass line), body/snare (150 Hz–2 kHz) and hats/air (>6 kHz) as log-magnitude flux.
   */
  fluxKick: Float32Array;
  fluxMid: Float32Array;
  fluxHat: Float32Array;
  /** 0..1 how broadband ("noisy", drum-like) the spectral change of the frame is */
  fluxFlat: Float32Array;
  /** Band power (linear) */
  lowE: Float32Array;
  midE: Float32Array;
  highE: Float32Array;
  /** Spectral centroid (Hz) */
  centroid: Float32Array;
  /** 12 chroma bins per frame */
  chroma: Float32Array;
  /** 13 MFCCs per frame */
  mfcc: Float32Array;
  /** Dominant pitch in 200 Hz–2 kHz as MIDI note, NaN where unvoiced */
  pitch: Float32Array;
  pitchConf: Float32Array;
}

const N_MEL = 26;
const N_MFCC = 13;

function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

function hzToMel(f: number): number {
  return 2595 * Math.log10(1 + f / 700);
}
function melToHz(m: number): number {
  return 700 * (Math.pow(10, m / 2595) - 1);
}

interface MelBank {
  start: Int32Array;
  weights: Float32Array[];
}

function melBank(nBins: number, sr: number, fMin: number, fMax: number): MelBank {
  const mMin = hzToMel(fMin);
  const mMax = hzToMel(fMax);
  const pts: number[] = [];
  for (let i = 0; i < N_MEL + 2; i++) pts.push(melToHz(mMin + ((mMax - mMin) * i) / (N_MEL + 1)));
  const binHz = sr / 2 / (nBins - 1);
  const start = new Int32Array(N_MEL);
  const weights: Float32Array[] = [];
  for (let m = 0; m < N_MEL; m++) {
    const lo = pts[m];
    const mid = pts[m + 1];
    const hi = pts[m + 2];
    const b0 = Math.max(0, Math.floor(lo / binHz));
    const b1 = Math.min(nBins - 1, Math.ceil(hi / binHz));
    start[m] = b0;
    const w = new Float32Array(b1 - b0 + 1);
    for (let b = b0; b <= b1; b++) {
      const f = b * binHz;
      let v = 0;
      if (f >= lo && f <= mid) v = (f - lo) / Math.max(1e-6, mid - lo);
      else if (f > mid && f <= hi) v = (hi - f) / Math.max(1e-6, hi - mid);
      w[b - b0] = v;
    }
    weights.push(w);
  }
  return { start, weights };
}

export function computeFrames(
  x: Float32Array,
  sr: number,
  onProgress?: (p: number) => void,
): FrameFeatures {
  const N = FRAME;
  const hop = HOP;
  const nBins = N / 2 + 1;
  const binHz = sr / N;
  const count = Math.max(1, Math.floor(x.length / hop) + 1);
  const fft = new FFT(N);
  const win = hann(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const mag = new Float32Array(nBins);
  const logMag = new Float32Array(nBins);
  // SuperFlux style: compare against frame n-2, max-filtered over neighbouring bins
  const hist = [new Float32Array(nBins), new Float32Array(nBins)];
  let histIdx = 0;

  const out: FrameFeatures = {
    sr,
    hop,
    fps: sr / hop,
    count,
    rms: new Float32Array(count),
    fluxAll: new Float32Array(count),
    fluxKick: new Float32Array(count),
    fluxMid: new Float32Array(count),
    fluxHat: new Float32Array(count),
    fluxFlat: new Float32Array(count),
    lowE: new Float32Array(count),
    midE: new Float32Array(count),
    highE: new Float32Array(count),
    centroid: new Float32Array(count),
    chroma: new Float32Array(count * 12),
    mfcc: new Float32Array(count * N_MFCC),
    pitch: new Float32Array(count),
    pitchConf: new Float32Array(count),
  };

  const kickHi = Math.round(150 / binHz);
  const midHi = Math.round(2000 / binHz);
  const hatLo = Math.round(6000 / binHz);
  const allHi = Math.min(nBins - 1, Math.round(8000 / binHz));

  // chroma mapping for 55 Hz .. 5 kHz
  const chromaLo = Math.ceil(55 / binHz);
  const chromaHi = Math.min(nBins - 1, Math.floor(5000 / binHz));
  const pcOf = new Int8Array(nBins).fill(-1);
  for (let b = chromaLo; b <= chromaHi; b++) {
    const midi = 69 + 12 * Math.log2((b * binHz) / 440);
    pcOf[b] = ((Math.round(midi) % 12) + 12) % 12;
  }

  const mel = melBank(nBins, sr, 40, Math.min(8000, sr / 2));
  const melE = new Float32Array(N_MEL);
  // DCT-II basis
  const dct: Float32Array[] = [];
  for (let k = 0; k < N_MFCC; k++) {
    const row = new Float32Array(N_MEL);
    for (let m = 0; m < N_MEL; m++) row[m] = Math.cos((Math.PI * k * (m + 0.5)) / N_MEL);
    dct.push(row);
  }

  // pitch candidates: MIDI 55 (≈196 Hz) .. 95 (≈1976 Hz) in third-semitone steps
  const candMidi: number[] = [];
  for (let m = 55; m <= 95; m += 1 / 3) candMidi.push(m);
  const candHz = candMidi.map((m) => 440 * Math.pow(2, (m - 69) / 12));
  const sal = new Float32Array(candMidi.length);
  const comp = new Float32Array(nBins);
  const HARM = 6;
  const hw = new Float32Array(HARM);
  for (let h = 0; h < HARM; h++) hw[h] = Math.pow(0.82, h);

  const norm = 4 / N; // sine of amplitude A -> magnitude ≈ A
  const half = N / 2;
  let lastReport = 0;

  for (let f = 0; f < count; f++) {
    const center = f * hop;
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const idx = center - half + i;
      const v = idx >= 0 && idx < x.length ? x[idx] : 0;
      sumSq += v * v;
      re[i] = v * win[i];
      im[i] = 0;
    }
    out.rms[f] = Math.sqrt(sumSq / N);
    fft.transform(re, im);

    let cNum = 0;
    let cDen = 0;
    let lowE = 0;
    let midE = 0;
    let highE = 0;
    for (let b = 0; b < nBins; b++) {
      const m = Math.sqrt(re[b] * re[b] + im[b] * im[b]) * norm;
      mag[b] = m;
      logMag[b] = Math.log1p(100 * m);
      const p = m * m;
      if (b <= kickHi) lowE += p;
      else if (b <= midHi) midE += p;
      else if (b >= hatLo) highE += p;
      if (b <= allHi) {
        cNum += b * binHz * m;
        cDen += m;
      }
    }
    out.lowE[f] = lowE;
    out.midE[f] = midE;
    out.highE[f] = highE;
    out.centroid[f] = cDen > 1e-9 ? cNum / cDen : 0;

    // flux vs frame f-2
    const prev = hist[histIdx];
    if (f >= 2) {
      let fa = 0;
      let fm = 0;
      let fh = 0;
      let s1 = 0;
      let s2 = 0;
      let nb = 0;
      for (let b = 1; b < nBins; b++) {
        const ref = Math.max(prev[b - 1], prev[b], b + 1 < nBins ? prev[b + 1] : prev[b]);
        const d = logMag[b] - ref;
        const dp = d > 0 ? d : 0;
        if (b <= allHi) fa += dp;
        if (b <= kickHi) continue;
        if (b <= midHi) fm += dp;
        else if (b >= hatLo) fh += dp;
        s1 += dp;
        s2 += dp * dp;
        nb++;
      }
      out.fluxFlat[f] = s2 > 1e-9 ? (s1 * s1) / (nb * s2) : 0;
      out.fluxAll[f] = fa;
      out.fluxMid[f] = fm;
      out.fluxHat[f] = fh;
    }
    prev.set(logMag);
    histIdx = 1 - histIdx;

    // chroma
    const cOff = f * 12;
    for (let b = chromaLo; b <= chromaHi; b++) {
      out.chroma[cOff + pcOf[b]] += mag[b] * mag[b];
    }

    // MFCC
    for (let m = 0; m < N_MEL; m++) {
      const w = mel.weights[m];
      const s0 = mel.start[m];
      let e = 0;
      for (let i = 0; i < w.length; i++) e += w[i] * mag[s0 + i] * mag[s0 + i];
      melE[m] = Math.log10(e + 1e-10);
    }
    const mOff = f * N_MFCC;
    for (let k = 0; k < N_MFCC; k++) {
      let s = 0;
      const row = dct[k];
      for (let m = 0; m < N_MEL; m++) s += row[m] * melE[m];
      out.mfcc[mOff + k] = s;
    }

    // melody salience every other frame (holds for the odd frames)
    if ((f & 1) === 0) {
      for (let b = 0; b < nBins; b++) comp[b] = Math.sqrt(mag[b]);
      let best = 0;
      let bestI = -1;
      let total = 0;
      for (let c = 0; c < candHz.length; c++) {
        let s = 0;
        for (let h = 0; h < HARM; h++) {
          const fh = candHz[c] * (h + 1);
          if (fh > 5000) break;
          const pos = fh / binHz;
          const i0 = Math.floor(pos);
          const fr = pos - i0;
          const v0 = comp[i0];
          const v1 = comp[i0 + 1];
          // take the local max around the fractional bin, tolerant to slight detuning
          s += hw[h] * Math.max(v0 * (1 - fr) + v1 * fr, Math.max(v0, v1) * 0.9);
        }
        sal[c] = s;
        total += s;
        if (s > best) {
          best = s;
          bestI = c;
        }
      }
      const mean = total / candHz.length;
      const conf = mean > 1e-6 ? best / mean : 0;
      const voiced = bestI >= 0 && conf > 1.35 && out.rms[f] > 1e-3;
      out.pitch[f] = voiced ? candMidi[bestI] : NaN;
      out.pitchConf[f] = conf;
    } else {
      out.pitch[f] = out.pitch[f - 1];
      out.pitchConf[f] = out.pitchConf[f - 1];
    }

    if (onProgress && f - lastReport > 400) {
      lastReport = f;
      onProgress(f / count);
    }
  }
  for (let f = 2; f < count; f++) {
    out.fluxKick[f] = Math.max(0, Math.sqrt(out.lowE[f]) - Math.sqrt(out.lowE[f - 2]));
  }
  return out;
}

export const MFCC_COUNT = N_MFCC;
