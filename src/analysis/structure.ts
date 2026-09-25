// Song structure: self-similarity novelty -> sections -> labels, build-up / drop detection.

import type { BuildUp, Section, SectionLabel, TimeSpan } from '../types';
import type { FrameFeatures } from './features';
import { MFCC_COUNT } from './features';
import { clamp, clamp01, lowerBound, mean, nearestIndex, percentile, regression, std } from './util';

export interface Curves {
  rate: number;
  duration: number;
  energy: Float32Array;
  energySlow: Float32Array;
  rmsDb: Float32Array;
  lowDb: Float32Array;
  brightness: Float32Array;
  percussion: Float32Array;
  /** density of snare + hat onsets per second (unnormalized) */
  onsetRate: Float32Array;
}

export interface StructureContext {
  feat: FrameFeatures;
  curves: Curves;
  beats: number[];
  downbeats: number[];
  bpm: number;
  beatConfidence: number;
  beatsPerBar: number;
  silences: TimeSpan[];
  firstSound: number;
  lastSound: number;
  fadeOut: TimeSpan | null;
}

export interface StructureResult {
  sections: Section[];
  buildups: BuildUp[];
  /** novelty on the curve grid */
  novelty: Float32Array;
}

const curveAvg = (c: Float32Array, rate: number, t0: number, t1: number) =>
  mean(c, Math.floor(t0 * rate), Math.max(Math.floor(t0 * rate) + 1, Math.ceil(t1 * rate)));

// ---------------------------------------------------------------------------------------------
// Build-ups: sustained rise over 4-16 bars followed by a jump (the drop) on a downbeat.
// ---------------------------------------------------------------------------------------------
export function detectBuildups(ctx: StructureContext): BuildUp[] {
  const { curves, downbeats, bpm, beatsPerBar } = ctx;
  if (downbeats.length < 8 || ctx.beatConfidence < 0.2) return [];
  const rate = curves.rate;
  const bar = (beatsPerBar * 60) / bpm;
  // "build feature": loudness + brightness + onset density, z-scored
  const zs = (c: Float32Array) => {
    const m = mean(c);
    const s = std(c) || 1;
    return Float32Array.from(c, (v) => (v - m) / s);
  };
  const zE = zs(curves.rmsDb);
  const zB = zs(curves.brightness);
  const zO = zs(curves.onsetRate);
  const feature = new Float32Array(zE.length);
  for (let i = 0; i < feature.length; i++) feature[i] = 0.45 * zE[i] + 0.3 * zB[i] + 0.25 * zO[i];

  type Cand = BuildUp & { score: number };
  const cands: Cand[] = [];
  for (const D of downbeats) {
    if (D < 6 * bar || D > ctx.lastSound - 2 * bar) continue;
    const lowAfter = curveAvg(curves.lowDb, rate, D + 0.03, D + 2 * bar);
    const lowBefore = curveAvg(curves.lowDb, rate, D - 2 * bar, D - 0.03);
    const rmsAfter = curveAvg(curves.rmsDb, rate, D + 0.03, D + 2 * bar);
    const rmsBefore = curveAvg(curves.rmsDb, rate, D - 2 * bar, D - 0.03);
    // drop energy must also be high relative to the song
    const eAfter = curveAvg(curves.energy, rate, D, D + 4 * bar);
    const lowJump = lowAfter - lowBefore;
    const rmsJump = rmsAfter - rmsBefore;
    if (!(lowJump > 5 || rmsJump > 3)) continue;
    if (eAfter < 0.55) continue;
    let bestBuild = 0;
    let bestW = 0;
    for (const W of [4, 8, 16]) {
      const s = D - W * bar;
      if (s < 0) continue;
      const a = Math.floor(s * rate);
      const b = Math.floor((D - 0.25 * bar) * rate);
      const { slope, r } = regression(feature, a, b, 1 / rate);
      const rise = slope * (W * bar); // total rise in std units
      if (r < 0.35 || rise <= 0) continue;
      const sc = rise * (0.6 + 0.4 * r) * (W === 16 ? 0.9 : 1);
      if (sc > bestBuild) {
        bestBuild = sc;
        bestW = W;
      }
    }
    if (bestBuild < 0.7 || bestW === 0) continue;
    const score = lowJump / 6 + rmsJump / 4 + 0.7 * bestBuild;
    // the build really starts where the sustained rise begins: the latest point before the
    // build peak that is still near the valley ...
    const smooth = (i: number) => mean(feature, i - Math.round(rate), i + Math.round(rate));
    let minV = Infinity;
    let peakV = -Infinity;
    let peakT = D - 2 * bar;
    for (let t = D - 16 * bar; t <= D - bar; t += bar / 4) {
      if (t < 0) continue;
      const v = smooth(Math.floor(t * rate));
      minV = Math.min(minV, v);
      if (v > peakV) {
        peakV = v;
        peakT = t;
      }
    }
    let riseT = D - bestW * bar;
    for (let t = peakT; t >= D - 16 * bar && t >= 0; t -= bar / 4) {
      if (smooth(Math.floor(t * rate)) <= minV + 0.15 * (peakV - minV)) {
        riseT = t;
        break;
      }
    }
    // ... moved back onto the bar where the arrangement changes (e.g. the kick drops out)
    let start = riseT;
    let bestChange = 3;
    for (const d of downbeats) {
      if (d < riseT - 4 * bar || d > riseT + 0.5 * bar) continue;
      const change =
        Math.abs(curveAvg(curves.lowDb, rate, d, d + 2 * bar) - curveAvg(curves.lowDb, rate, d - 2 * bar, d)) +
        Math.abs(curveAvg(curves.rmsDb, rate, d, d + 2 * bar) - curveAvg(curves.rmsDb, rate, d - 2 * bar, d));
      if (change > bestChange) {
        bestChange = change;
        start = d;
      }
    }
    if (start === riseT) {
      const di = nearestIndex(downbeats, start);
      if (di >= 0 && Math.abs(downbeats[di] - start) < bar * 0.75) start = downbeats[di];
    }
    cands.push({ start, drop: D, strength: clamp01(score / 4), score });
  }
  // non-max suppression within 8 bars
  cands.sort((a, b) => b.score - a.score);
  const picked: Cand[] = [];
  for (const c of cands) {
    if (picked.some((p) => Math.abs(p.drop - c.drop) < 8 * bar)) continue;
    if (picked.length && c.score < 0.35 * picked[0].score) continue;
    picked.push(c);
  }
  picked.sort((a, b) => a.drop - b.drop);
  // builds must not overlap a previous drop
  for (let i = 1; i < picked.length; i++) {
    if (picked[i].start < picked[i - 1].drop + bar) picked[i].start = picked[i - 1].drop + bar;
  }
  return picked.filter((p) => p.drop - p.start >= 3.5 * bar).map(({ start, drop, strength }) => ({ start, drop, strength }));
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------
export function segment(ctx: StructureContext, buildups: BuildUp[]): StructureResult {
  const { feat, curves, beats, downbeats, bpm, beatsPerBar } = ctx;
  const duration = curves.duration;
  const rate = curves.rate;
  const useBeats = ctx.beatConfidence >= 0.25 && beats.length >= 32;

  // ---- units
  let unitT: number[] = [];
  if (useBeats) {
    unitT = beats.slice();
  } else {
    for (let t = Math.max(0, ctx.firstSound); t < ctx.lastSound; t += 0.5) unitT.push(t);
  }
  if (unitT.length < 8) {
    return {
      sections: [mkSection(0, duration, 'verse', curves, ctx)],
      buildups,
      novelty: new Float32Array(curves.energy.length),
    };
  }
  unitT.push(Math.min(duration, unitT[unitT.length - 1] + (unitT[unitT.length - 1] - unitT[unitT.length - 2])));
  const U = unitT.length - 1;
  const D = 12 + 12;
  const vec = new Float32Array(U * D);
  const unitE = new Float32Array(U);
  const mf = new Float32Array(U * 12);
  for (let u = 0; u < U; u++) {
    const f0 = Math.max(0, Math.floor(unitT[u] * feat.fps));
    const f1 = Math.min(feat.count, Math.max(f0 + 1, Math.floor(unitT[u + 1] * feat.fps)));
    const c = new Float32Array(12);
    for (let f = f0; f < f1; f++) {
      for (let k = 0; k < 12; k++) c[k] += feat.chroma[f * 12 + k];
      for (let k = 1; k <= 12; k++) mf[u * 12 + k - 1] += feat.mfcc[f * MFCC_COUNT + k] / (f1 - f0);
    }
    let n = 0;
    for (let k = 0; k < 12; k++) n += c[k] * c[k];
    n = Math.sqrt(n) || 1;
    for (let k = 0; k < 12; k++) vec[u * D + k] = c[k] / n;
    unitE[u] = curveAvg(curves.energy, rate, unitT[u], unitT[u + 1]);
  }
  // z-score MFCC dims across units
  for (let k = 0; k < 12; k++) {
    let m = 0;
    for (let u = 0; u < U; u++) m += mf[u * 12 + k];
    m /= U;
    let s = 0;
    for (let u = 0; u < U; u++) s += (mf[u * 12 + k] - m) ** 2;
    s = Math.sqrt(s / U) || 1;
    for (let u = 0; u < U; u++) vec[u * D + 12 + k] = (mf[u * 12 + k] - m) / s / Math.sqrt(12);
  }
  for (let u = 0; u < U; u++) {
    let n = 0;
    for (let k = 0; k < D; k++) n += vec[u * D + k] ** 2;
    n = Math.sqrt(n) || 1;
    for (let k = 0; k < D; k++) vec[u * D + k] /= n;
  }
  const S = new Float32Array(U * U);
  for (let a = 0; a < U; a++) {
    for (let b = a; b < U; b++) {
      let d = 0;
      for (let k = 0; k < D; k++) d += vec[a * D + k] * vec[b * D + k];
      S[a * U + b] = d;
      S[b * U + a] = d;
    }
  }

  // ---- checkerboard novelty
  const K = useBeats ? 4 * beatsPerBar : 16;
  const sig = K / 2;
  const nov = new Float32Array(U);
  for (let u = 0; u < U; u++) {
    let s = 0;
    for (let i = -K; i < K; i++) {
      const a = u + i;
      if (a < 0 || a >= U) continue;
      for (let j = -K; j < K; j++) {
        const b = u + j;
        if (b < 0 || b >= U) continue;
        const g = Math.exp(-((i + 0.5) ** 2 + (j + 0.5) ** 2) / (2 * sig * sig));
        const sign = (i < 0) === (j < 0) ? 1 : -1;
        s += sign * g * S[a * U + b];
      }
    }
    nov[u] = Math.max(0, s);
  }
  const enNov = new Float32Array(U);
  for (let u = 0; u < U; u++) {
    enNov[u] = Math.abs(mean(unitE, u, u + K) - mean(unitE, u - K, u));
  }
  const nMax = Math.max(1e-9, ...nov);
  const eMaxN = Math.max(1e-9, ...enNov);
  const combined = new Float32Array(U);
  for (let u = 0; u < U; u++) combined[u] = 0.55 * (nov[u] / nMax) + 0.45 * (enNov[u] / eMaxN);

  // ---- peak picking
  const bar = useBeats ? (beatsPerBar * 60) / bpm : 2;
  const minDist = clamp(4 * bar, 7, 14);
  const m = mean(combined);
  const s = std(combined);
  const peaks: { t: number; v: number }[] = [];
  const w = Math.max(2, Math.floor(K / 2));
  for (let u = 1; u < U - 1; u++) {
    let isMax = true;
    for (let j = Math.max(0, u - w); j <= Math.min(U - 1, u + w); j++) {
      if (combined[j] > combined[u]) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    if (combined[u] < m + 0.25 * s || combined[u] < 0.2) continue;
    peaks.push({ t: unitT[u], v: combined[u] });
  }
  peaks.sort((a, b) => b.v - a.v);
  const maxCount = Math.max(2, Math.floor(duration / 9));
  let bounds: number[] = [];
  // forced boundaries
  const forced: number[] = [];
  for (const b of buildups) {
    forced.push(b.drop);
    forced.push(b.start);
  }
  for (const sil of ctx.silences) {
    if (sil.end - sil.start >= 1.0 && sil.start > ctx.firstSound + 2 && sil.end < ctx.lastSound - 2) forced.push(sil.end);
  }
  for (const f of forced) bounds.push(f);
  const insideBuild = (t: number) => buildups.some((b) => t > b.start + 1 && t < b.drop - 1);
  for (const p of peaks) {
    if (bounds.length >= maxCount + forced.length) break;
    if (p.t < ctx.firstSound + 4 || p.t > ctx.lastSound - 4) continue;
    if (insideBuild(p.t)) continue;
    if (bounds.some((b) => Math.abs(b - p.t) < (forced.includes(b) ? 4 : minDist))) continue;
    bounds.push(p.t);
  }
  // snap non-forced boundaries to downbeats
  bounds = bounds.map((b) => {
    if (forced.includes(b) || !downbeats.length) return b;
    const i = nearestIndex(downbeats, b);
    return Math.abs(downbeats[i] - b) < 0.6 * bar ? downbeats[i] : b;
  });
  bounds.sort((a, b) => a - b);
  // dedupe / merge very short sections (keep forced)
  const merged: number[] = [];
  for (const b of bounds) {
    if (b <= 1 || b >= duration - 1) continue;
    const prev = merged.length ? merged[merged.length - 1] : 0;
    if (b - prev < 4.5) {
      if (forced.includes(b) && !forced.includes(prev) && merged.length) merged[merged.length - 1] = b;
      continue;
    }
    merged.push(b);
  }
  if (merged.length && duration - merged[merged.length - 1] < 4) merged.pop();
  const edges = [0, ...merged, duration];

  // ---- sections + labels
  const sections: Section[] = [];
  for (let i = 0; i < edges.length - 1; i++) sections.push(mkSection(edges[i], edges[i + 1], 'verse', curves, ctx));

  // repetition via mean unit vectors
  const secVec = sections.map((sec) => {
    const v = new Float32Array(D);
    const a = lowerBound(unitT, sec.start);
    const b = lowerBound(unitT, sec.end);
    for (let u = a; u < Math.min(b, U); u++) for (let k = 0; k < D; k++) v[k] += vec[u * D + k];
    let n = 0;
    for (let k = 0; k < D; k++) n += v[k] * v[k];
    n = Math.sqrt(n) || 1;
    for (let k = 0; k < D; k++) v[k] /= n;
    return v;
  });
  sections.forEach((sec, i) => {
    let best = 0.9;
    for (let j = 0; j < i; j++) {
      let d = 0;
      for (let k = 0; k < D; k++) d += secVec[i][k] * secVec[j][k];
      if (d > best) {
        best = d;
        sec.repeatOf = sections[j].repeatOf >= 0 ? sections[j].repeatOf : j;
      }
    }
  });

  labelSections(sections, buildups, ctx);

  // novelty on the curve grid
  const novelty = new Float32Array(curves.energy.length);
  for (let i = 0; i < novelty.length; i++) {
    const t = i / rate;
    const u = Math.min(U - 1, Math.max(0, lowerBound(unitT, t) - 1));
    novelty[i] = combined[u];
  }
  return { sections, buildups, novelty };
}

function mkSection(start: number, end: number, label: SectionLabel, curves: Curves, ctx: StructureContext): Section {
  const rate = curves.rate;
  const a = Math.floor(start * rate);
  const b = Math.max(a + 2, Math.floor(end * rate));
  const energy = mean(curves.energy, a, b);
  const db = mean(curves.rmsDb, a, b);
  const perc = mean(curves.percussion, a, b);
  const bright = mean(curves.brightness, a, b);
  const loudAbs = clamp01((db + 34) / 22);
  const { slope } = regression(curves.energySlow, a, b, 1 / rate);
  const beatFactor = clamp01(ctx.beatConfidence * 1.6);
  const intensity = clamp01(
    (0.4 * energy + 0.35 * perc + 0.15 * loudAbs + 0.1 * bright) * (0.65 + 0.35 * beatFactor) + 0.08 * beatFactor,
  );
  return { start, end, label, energy, intensity, slope, repeatOf: -1 };
}

function labelSections(sections: Section[], buildups: BuildUp[], ctx: StructureContext): void {
  const n = sections.length;
  const duration = ctx.curves.duration;
  const Es = sections.map((s) => s.energy);
  const eHi = percentile(Es, 66);
  const eLo = percentile(Es, 34);
  const eMax = Math.max(...Es);
  const near = (a: number, b: number) => Math.abs(a - b) < 0.75;
  for (let i = 0; i < n; i++) {
    const s = sections[i];
    const len = s.end - s.start;
    const prev = i > 0 ? sections[i - 1] : null;
    const next = i < n - 1 ? sections[i + 1] : null;
    const isDrop = buildups.some((b) => near(b.drop, s.start));
    const inBuild = buildups.some((b) => {
      const ov = Math.min(b.drop, s.end) - Math.max(b.start, s.start);
      return ov > 0.6 * len;
    });
    let label: SectionLabel = 'verse';
    if (isDrop) label = 'drop';
    else if (inBuild) label = 'build';
    else if (i === 0 && n >= 3 && s.energy < 0.85 * eMax && (s.energy < eHi || len < 0.2 * duration)) label = 'intro';
    else if (i === n - 1 && n >= 3 && (s.energy < eHi || ctx.fadeOut !== null) && (prev ? s.energy <= prev.energy + 0.05 : true))
      label = 'outro';
    else if (s.energy >= eHi && s.energy >= 0.55 * eMax) label = 'chorus';
    else if (s.slope > 0.012 && next && next.energy > s.energy + 0.1 && len < 40) label = 'build';
    else if (prev && s.energy <= eLo && prev.energy > s.energy + 0.12) label = 'breakdown';
    s.label = label;
  }
  // in songs with real drops, "choruses" clearly below the drops are verses / grooves
  const drops = sections.filter((s) => s.label === 'drop');
  if (drops.length) {
    const dropE = drops.reduce((a, s) => a + s.energy, 0) / drops.length;
    for (const s of sections) if (s.label === 'chorus' && s.energy < 0.9 * dropE) s.label = 'verse';
  }
  // a quiet section right after a drop/chorus that is much quieter than it is a breakdown
  for (let i = 1; i < n - 1; i++) {
    const s = sections[i];
    const prev = sections[i - 1];
    if (s.label === 'verse' && (prev.label === 'drop' || prev.label === 'chorus') && s.energy < prev.energy - 0.2)
      s.label = 'breakdown';
  }
}

// ---------------------------------------------------------------------------------------------
// Silence / fade-out
// ---------------------------------------------------------------------------------------------
export function findSilences(rmsDb: Float32Array, fps: number, peakDb: number): TimeSpan[] {
  const thr = Math.max(-62, peakDb - 45);
  const out: TimeSpan[] = [];
  let start = -1;
  for (let i = 0; i <= rmsDb.length; i++) {
    const silent = i < rmsDb.length && rmsDb[i] < thr;
    if (silent && start < 0) start = i;
    if (!silent && start >= 0) {
      const a = start / fps;
      const b = i / fps;
      if (b - a >= 0.3) out.push({ start: a, end: b });
      start = -1;
    }
  }
  return out;
}

export function findFadeOut(energySlowDb: Float32Array, rate: number, lastSound: number): TimeSpan | null {
  const end = Math.floor((lastSound - 0.3) * rate);
  const a = Math.max(0, Math.floor((lastSound - 30) * rate));
  if (end - a < rate * 4) return null;
  let peak = -Infinity;
  let peakI = a;
  for (let i = a; i < end - rate * 2; i++) {
    if (energySlowDb[i] > peak) {
      peak = energySlowDb[i];
      peakI = i;
    }
  }
  if (energySlowDb[end] > peak - 12) return null;
  let down = 0;
  let total = 0;
  const step = Math.max(1, Math.floor(rate / 4));
  for (let i = peakI + step; i <= end; i += step) {
    total++;
    if (energySlowDb[i] <= energySlowDb[i - step] + 0.3) down++;
  }
  if (total < 8 || down / total < 0.75) return null;
  return { start: peakI / rate, end: lastSound };
}
