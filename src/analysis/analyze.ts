// Whole-song analysis. Pure function over mono PCM; runs in a Web Worker (see worker.ts)
// and in Node for the test harness.

import type { Analysis, Onset, TimeSpan } from '../types';
import { beatGrid, pickOnsets } from './beats';
import { computeFrames } from './features';
import { detectBuildups, findFadeOut, findSilences, segment, type Curves } from './structure';
import { clamp01, movingAverage, percentile, resample, resampleMean, toDb } from './util';

export const ANALYSIS_VERSION = 3;
export const CURVE_RATE = 50;

export type ProgressFn = (fraction: number, stage: string) => void;

export function analyzeSamples(x: Float32Array, sr: number, hash: string, onProgress: ProgressFn = () => {}): Analysis {
  const duration = x.length / sr;
  onProgress(0, 'Listening to your song…');
  const feat = computeFrames(x, sr, (p) => onProgress(p * 0.7, 'Listening to your song…'));
  const fps = feat.fps;

  // ---- loudness / silence
  onProgress(0.72, 'Measuring energy…');
  const frameDb = Float32Array.from(feat.rms, (v) => toDb(v));
  const loudDb = movingAverage(frameDb, Math.round(fps * 0.4) | 1);
  const peakDb = percentile(loudDb, 99.5);
  const silences = findSilences(frameDb, fps, peakDb);
  const silentAt = (t: number) => silences.some((s) => t >= s.start && t < s.end);
  let firstSound = 0;
  let lastSound = duration;
  if (silences.length && silences[0].start < 0.05) firstSound = silences[0].end;
  const lastSil = silences[silences.length - 1];
  if (lastSil && lastSil.end > duration - 0.1) lastSound = lastSil.start;
  if (lastSound <= firstSound) {
    firstSound = 0;
    lastSound = duration;
  }

  // ---- curves on a 50 Hz grid
  const rmsDb = resampleMean(frameDb, fps, CURVE_RATE, duration);
  const audible: number[] = [];
  for (let i = 0; i < rmsDb.length; i++) if (rmsDb[i] > peakDb - 45) audible.push(rmsDb[i]);
  const lo = percentile(audible, 8);
  const hi = percentile(audible, 97);
  const norm = (db: number) => clamp01((db - lo) / Math.max(3, hi - lo));
  const dbSmooth = movingAverage(rmsDb, Math.round(CURVE_RATE * 0.3) | 1);
  const dbSlow = movingAverage(rmsDb, Math.round(CURVE_RATE * 2) | 1);
  const energy = Float32Array.from(dbSmooth, norm);
  const energySlow = Float32Array.from(dbSlow, norm);

  const lowDbFrames = Float32Array.from(feat.lowE, (v) => 10 * Math.log10(v + 1e-12));
  const lowDb = movingAverage(resampleMean(lowDbFrames, fps, CURVE_RATE, duration), 11);

  const centroidC = movingAverage(resampleMean(feat.centroid, fps, CURVE_RATE, duration), 25);
  const cLo = percentile(centroidC, 5);
  const cHi = percentile(centroidC, 95);
  const brightness = Float32Array.from(centroidC, (v) => clamp01((v - cLo) / Math.max(1, cHi - cLo)));

  // ---- onsets
  onProgress(0.76, 'Finding the beat…');
  const notSilent = (o: Onset) => !silentAt(o.t);
  const kick = pickOnsets(feat.fluxKick, feat, { minGap: 0.1, delta: 0.45 }).filter(notSilent);
  const snare = pickOnsets(feat.fluxMid, feat, { minGap: 0.1, delta: 0.55 }).filter(notSilent);
  const hat = pickOnsets(feat.fluxHat, feat, { minGap: 0.06, delta: 0.45 }).filter(notSilent);

  // percussion density curve (absolute scale so a solo piano stays low)
  const nC = Math.ceil(duration * CURVE_RATE) + 1;
  const dens = new Float32Array(nC);
  const rateArr = new Float32Array(nC);
  // drum hits change the spectrum broadband; piano / voice onsets are peaky (harmonic)
  const drumness = (t: number) => {
    const f = Math.round(t * fps);
    let m = 0;
    for (let j = f - 1; j <= f + 1; j++) if (j >= 0 && j < feat.count) m = Math.max(m, feat.fluxFlat[j]);
    return clamp01((m - 0.1) / 0.15);
  };
  const addOn = (arr: Onset[], w: number, toRate: boolean) => {
    for (const o of arr) {
      const i = Math.round(o.t * CURVE_RATE);
      if (i >= 0 && i < nC) {
        const d = drumness(o.t);
        dens[i] += w * o.s * d;
        if (toRate) rateArr[i] += 0.3 + 0.7 * d;
      }
    }
  };
  addOn(kick, 1.0, false);
  addOn(snare, 0.45, true);
  addOn(hat, 0.8, true);
  const densS = movingAverage(dens, CURVE_RATE * 2 + 1);
  const percussion = Float32Array.from(densS, (v) => clamp01((v * CURVE_RATE) / 5));
  const onsetRate = Float32Array.from(movingAverage(rateArr, CURVE_RATE + 1), (v) => v * CURVE_RATE);

  // ---- beats
  // beats keep running through short in-song silences (a pre-drop gap is still "in time"),
  // only the leading / trailing silence is beat-free
  const grid = beatGrid(feat, (t) => t < firstSound - 0.05 || t > lastSound + 0.05);

  // ---- melody contour
  onProgress(0.84, 'Following the melody…');
  const pitchC = new Float32Array(nC).fill(-1);
  {
    const per = fps / CURVE_RATE;
    const vals: number[] = [];
    for (let i = 0; i < nC; i++) {
      const a = Math.floor((i - 0.5) * per);
      const b = Math.floor((i + 0.5) * per);
      const v: number[] = [];
      for (let f = Math.max(0, a); f < Math.min(feat.count, b); f++) if (Number.isFinite(feat.pitch[f])) v.push(feat.pitch[f]);
      if (v.length >= Math.max(1, (b - a) * 0.4)) {
        v.sort((p, q) => p - q);
        pitchC[i] = v[v.length >> 1];
        vals.push(pitchC[i]);
      }
    }
    const p5 = percentile(vals, 5);
    const p95 = percentile(vals, 95);
    // median filter + normalize
    const tmp = pitchC.slice();
    for (let i = 0; i < nC; i++) {
      if (tmp[i] < 0) continue;
      const w: number[] = [];
      for (let j = i - 3; j <= i + 3; j++) if (j >= 0 && j < nC && tmp[j] >= 0) w.push(tmp[j]);
      w.sort((p, q) => p - q);
      pitchC[i] = clamp01((w[w.length >> 1] - p5) / Math.max(1, p95 - p5));
    }
  }

  // ---- structure
  onProgress(0.9, 'Mapping the structure…');
  const fadeOut = findFadeOut(dbSlow, CURVE_RATE, lastSound);
  const curves: Curves = {
    rate: CURVE_RATE,
    duration,
    energy,
    energySlow,
    rmsDb: dbSmooth,
    lowDb,
    brightness,
    percussion,
    onsetRate,
  };
  const ctx = {
    feat,
    curves,
    beats: grid.beats,
    downbeats: grid.downbeats,
    bpm: grid.bpm,
    beatConfidence: grid.confidence,
    beatsPerBar: grid.beatsPerBar,
    silences,
    firstSound,
    lastSound,
    fadeOut,
  };
  const buildups = detectBuildups(ctx);
  const structure = segment(ctx, buildups);

  onProgress(1, 'Done');
  const innerSilences: TimeSpan[] = silences;
  return {
    version: ANALYSIS_VERSION,
    hash,
    duration,
    bpm: grid.bpm,
    beatConfidence: grid.confidence,
    beatsPerBar: grid.beatsPerBar,
    beats: grid.beats,
    downbeats: grid.downbeats,
    onsets: { kick, snare, hat },
    curveRate: CURVE_RATE,
    energy,
    energySlow,
    brightness,
    pitch: pitchC,
    percussion,
    novelty: structure.novelty,
    sections: structure.sections,
    buildups: structure.buildups,
    silences: innerSilences,
    fadeOut,
    firstSound,
    lastSound,
    peakDb,
  };
}

/** Resample helper re-exported for callers that want a curve at another rate. */
export { resample };
