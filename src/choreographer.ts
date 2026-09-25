// Choreographer: turns the whole-song analysis into a designed show, the way a human
// fountain designer would — one "look" per section, hits on the music, big moments on drops.
// Deterministic: the seed comes from the file hash, so a song always gets the same show.

import { FAMILY_MAX, FAN, JETS, OARSMEN, RING, SHOOTERS } from './fountain/layout';
import { fallTimeFromApex, riseTime } from './fountain/physics';
import { FAN_POOLS, OARS_POOLS, RING_POOLS, SHOOTER_POOLS, shooterSteps } from './patterns';
import { Rng } from './prng';
import type {
  Analysis,
  CameraPreset,
  ColorMode,
  JetEvent,
  LaserCue,
  LaserMode,
  Marker,
  MistCue,
  MistMode,
  Onset,
  SectionPlan,
  Shot,
  SnapEvent,
  Tier,
} from './types';

export const PALETTE_COUNT = 6;

export interface ShowCurves {
  rate: number;
  /** jet height scale 0..1 (section level × energy, build ramps, silences, outro taper) */
  height: Float32Array;
  /** master light level */
  light: Float32Array;
  /** color saturation (builds desaturate toward white) */
  saturation: Float32Array;
  /** mist density 0..1 */
  mist: Float32Array;
  /** mist screen self-glow 0..1 */
  glow: Float32Array;
  /** light flashes 0..1 */
  flash: Float32Array;
  /** continuous melody contour 0..1 */
  melody: Float32Array;
  /** 0..1 progress inside build-ups, 0 elsewhere */
  build: Float32Array;
}

export interface ShowData {
  seed: number;
  duration: number;
  bpm: number;
  beatsPerBar: number;
  beats: number[];
  downbeats: number[];
  sections: SectionPlan[];
  /** per jet, sorted by peak time */
  events: JetEvent[][];
  snaps: SnapEvent[];
  shots: Shot[];
  mistCues: MistCue[];
  laserCues: LaserCue[];
  markers: Marker[];
  curves: ShowCurves;
  wake: { start: number; end: number };
  finale: { cut: number; lightsOut: number };
  drops: number[];
  /** how drum-driven the song is overall, 0..1 */
  songDrive: number;
}

const COLOR_MODES: ColorMode[] = ['solid', 'alternate', 'gradient', 'chase', 'split'];

const CAMERA_POOLS: Record<Tier | 'build', CameraPreset[]> = {
  calm: ['wide', 'low', 'dolly', 'orbit', 'high'],
  medium: ['dolly', 'low', 'close', 'orbit', 'wide'],
  intense: ['close', 'low', 'orbit', 'dolly', 'high'],
  build: ['low', 'close'],
};

const MIST_POOLS: Record<Tier | 'build', MistMode[]> = {
  calm: ['glow', 'spots'],
  medium: ['lines', 'spots', 'rings'],
  intense: ['rings', 'bars', 'lines'],
  build: ['lines'],
};

const LASER_POOL: LaserMode[] = ['sweep', 'tunnel', 'strobe'];

export function choreograph(a: Analysis): ShowData {
  const rng = Rng.fromHash(a.hash, 7);
  const seed = rng.seed();
  const duration = a.duration;
  const bpb = a.beatsPerBar || 4;
  const beatDur = 60 / (a.bpm || 120);
  const barDur = beatDur * bpb;
  const rate = a.curveRate;
  const nC = a.energy.length;
  const curveAt = (c: Float32Array, t: number) => c[Math.max(0, Math.min(nC - 1, Math.round(t * rate)))];

  // Beat grid (fall back to a steady grid when the song has no usable beat)
  const beats = a.beats.length >= 8 ? a.beats : steadyGrid(a.firstSound, a.lastSound, beatDur);
  const downbeats = a.downbeats.length >= 2 ? a.downbeats : beats.filter((_, i) => i % bpb === 0);

  // How drum-driven is the song?
  let percSum = 0;
  let percN = 0;
  for (let i = Math.floor(a.firstSound * rate); i < Math.min(nC, a.lastSound * rate); i++) {
    percSum += a.percussion[i];
    percN++;
  }
  const songDrive = Math.min(1, (percSum / Math.max(1, percN)) * 1.6);
  const hasDrops = a.sections.some((s) => s.label === 'drop');
  const drops = a.sections.filter((s) => s.label === 'drop').map((s) => s.start);

  // ---------------------------------------------------------------- 1. section plans
  const plans: SectionPlan[] = [];
  let prev: SectionPlan | null = null;
  let prevShot: CameraPreset | null = null;
  a.sections.forEach((sec, index) => {
    const perc = meanCurve(a.percussion, rate, sec.start, sec.end);
    const drums = perc > 0.12 && a.beatConfidence > 0.3;
    let tier: Tier;
    if (sec.label === 'drop') tier = 'intense';
    else if (sec.label === 'build') tier = 'medium';
    else if (sec.label === 'intro' || sec.label === 'outro' || sec.label === 'breakdown')
      tier = sec.intensity > 0.78 && drums ? 'medium' : 'calm';
    else if (!drums) tier = sec.intensity > 0.6 ? 'medium' : 'calm';
    else tier = sec.intensity >= 0.7 ? 'intense' : sec.intensity >= 0.42 ? 'medium' : 'calm';
    // with real drops in the song, only the drops get the full treatment
    if (hasDrops && sec.label !== 'drop' && tier === 'intense') tier = 'medium';

    const poolKey: Tier | 'build' = sec.label === 'build' ? 'build' : tier;
    const calmSong = !drums;
    let pace = tier === 'calm' ? 0.25 : tier === 'medium' ? 0.5 : 1;
    if (calmSong) pace *= 0.6;
    if (a.bpm > 140) pace *= 140 / a.bpm;

    const maxE = Math.max(...a.sections.map((s) => s.energy), 0.01);
    const rel = sec.energy / maxE;
    let level = tier === 'calm' ? 0.38 + 0.25 * rel : tier === 'medium' ? 0.55 + 0.25 * rel : 0.68 + 0.32 * rel * rel;
    if (sec.label === 'drop') level = 1;
    if (sec.label === 'breakdown') level = Math.min(level, 0.5);

    const oars = rng.pick(OARS_POOLS[poolKey], prev ? prev.oars : undefined);
    const fan = rng.pick(FAN_POOLS[poolKey], prev ? prev.fan : undefined);
    const ring = rng.pick(RING_POOLS[poolKey], prev ? prev.ring : undefined);
    let shooters: SectionPlan['shooters'] = null;
    let shooterEvery = 1;
    if (poolKey === 'intense') shooters = rng.pick(SHOOTER_POOLS.intense, prev?.shooters ?? undefined);
    else if (poolKey === 'medium' && drums) {
      shooters = rng.pick(SHOOTER_POOLS.medium, prev?.shooters ?? undefined);
      shooterEvery = 2;
    }
    const palette = pickPalette(rng, prev?.palette ?? -1);
    const colorMode = rng.pick(COLOR_MODES, prev?.colorMode);
    let mist: MistMode = rng.pick(MIST_POOLS[poolKey], prev?.mist);
    if (sec.label === 'breakdown') mist = 'glow';
    if (sec.label === 'intro' && index === 0) mist = 'dim';
    let laser: LaserMode = 'off';
    if (sec.label === 'build') laser = 'fanRise';
    else if (tier === 'intense') laser = rng.pick(LASER_POOL, prev?.laser);
    else if (tier === 'medium' && drums && rng.next() < 0.35) laser = rng.pick(LASER_POOL, prev?.laser);
    const spring =
      tier === 'calm'
        ? { omega: calmSong ? 1.6 : 2.2, max: calmSong ? 0.45 : 0.6 }
        : tier === 'medium'
          ? { omega: calmSong ? 3 : 5, max: calmSong ? 1.0 : 1.8 }
          : { omega: 11, max: 4.5 };
    const plan: SectionPlan = {
      index,
      start: sec.start,
      end: sec.end,
      label: sec.label,
      tier,
      pace,
      level,
      oars,
      fan,
      ring,
      shooters,
      shooterEvery,
      palette,
      colorMode,
      mist,
      laser,
      snareTarget: prev?.snareTarget === 'ring' ? 'snap' : 'ring',
      hats: tier !== 'calm' && drums && sec.label !== 'build',
      springOmega: spring.omega,
      maxAngularSpeed: spring.max,
      swing: tier === 'calm' ? 0.55 : tier === 'medium' ? 0.8 : 1,
      seed: rng.seed(),
    };
    plans.push(plan);
    prev = plan;
  });

  const planAt = (t: number) => {
    for (let i = plans.length - 1; i >= 0; i--) if (t >= plans[i].start) return plans[i];
    return plans[0];
  };

  // ---------------------------------------------------------------- 2. intro wake / finale timing
  const first = plans[0];
  const wakeLen = first.label === 'intro' ? clamp(0.7 * (first.end - first.start), 5, 12) : 3;
  const wake = { start: a.firstSound, end: a.firstSound + wakeLen };
  const tEnd = a.lastSound;
  const lastPlan = plans[plans.length - 1];
  const outroStart = lastPlan.label === 'outro' ? lastPlan.start : Math.max(tEnd - 10, lastPlan.start);
  const cut = Math.max(wake.end + 1, tEnd - 0.9);
  let lightsOut = Math.max(tEnd + 0.5, cut + 2.8);

  // ---------------------------------------------------------------- 3. curves
  const curves: ShowCurves = {
    rate,
    height: new Float32Array(nC),
    light: new Float32Array(nC),
    saturation: new Float32Array(nC),
    mist: new Float32Array(nC),
    glow: new Float32Array(nC),
    flash: new Float32Array(nC),
    melody: melodyCurve(a.pitch, rate),
    build: new Float32Array(nC),
  };
  const innerSilences = a.silences.filter((s) => s.start > a.firstSound + 0.5 && s.end < a.lastSound - 0.5);
  for (let i = 0; i < nC; i++) {
    const t = i / rate;
    const p = planAt(t);
    const e = 0.55 * a.energySlow[i] + 0.45 * a.energy[i];
    let h = p.level * (0.42 + 0.58 * e);
    let light = p.tier === 'calm' ? 0.8 : p.tier === 'medium' ? 0.95 : 1;
    let sat = p.tier === 'calm' ? 0.82 : 1;
    let mist = p.tier === 'calm' ? 0.8 : p.tier === 'medium' ? 0.55 : 0.65;
    let glow = p.tier === 'calm' ? 0.65 : p.tier === 'medium' ? 0.32 : 0.22;
    if (p.label === 'breakdown') {
      light = 0.75;
      mist = 1;
      glow = 1;
      sat = 0.75;
    }
    if (p.mist === 'dim') {
      mist = 0.45;
      glow = 0.3;
    }
    for (const b of a.buildups) {
      if (t >= b.start && t < b.drop) {
        const prog = (t - b.start) / (b.drop - b.start);
        curves.build[i] = prog;
        h = 0.32 + 0.6 * prog;
        light = 0.82 + 0.3 * prog;
        sat = 1 - 0.9 * Math.pow(prog, 1.2);
        mist = 0.45 + 0.55 * prog;
        glow = 0.2 + 0.65 * prog;
      }
    }
    if (innerSilences.some((s) => t >= s.start - 0.05 && t < s.end)) {
      h = 0;
      light *= 0.3;
    }
    if (t > outroStart) h *= 1 - 0.8 * smoothstep(outroStart, tEnd, t);
    if (t >= cut) h = 0;
    if (t < a.firstSound) h = 0;
    curves.height[i] = h;
    curves.light[i] = light;
    curves.saturation[i] = sat;
    curves.mist[i] = mist;
    curves.glow[i] = glow;
  }
  smoothInPlace(curves.height, Math.round(rate * 0.5));
  smoothInPlace(curves.light, Math.round(rate * 0.6));
  smoothInPlace(curves.mist, Math.round(rate * 1.5));
  smoothInPlace(curves.glow, Math.round(rate * 1.0));
  // saturation snaps back at drops, so only smooth outside builds
  smoothInPlace(curves.saturation, Math.round(rate * 0.3));

  // ---------------------------------------------------------------- 4. events
  const events: JetEvent[][] = JETS.map(() => []);
  const markers: Marker[] = [];
  const snaps: SnapEvent[] = [];
  const heightAt = (t: number) => curveAt(curves.height, t);
  const burst = (jet: number, peak: number, height: number, hold: number, kind: JetEvent['kind'], extra: Partial<JetEvent> = {}) => {
    if (height < 0.5 || peak < a.firstSound - 0.2) return;
    events[jet].push({ jet, peak, height, hold, kind, ...extra });
  };
  const beatTime = beatTimeFn(beats, beatDur);
  const beatIndexOf = (t: number) => {
    let lo = 0;
    let hi = beats.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (beats[m] <= t) lo = m;
      else hi = m;
    }
    return Math.abs(beats[lo] - t) < Math.abs(beats[hi] - t) ? lo : hi;
  };
  const nearOnset = (list: Onset[], t: number, tol: number) => {
    let best: Onset | null = null;
    for (const o of list) {
      if (o.t < t - tol) continue;
      if (o.t > t + tol) break;
      if (!best || o.s > best.s) best = o;
    }
    return best;
  };
  const dropSet = new Set(drops.map((d) => Math.round(d * 10)));
  const isDropTime = (t: number) => dropSet.has(Math.round(t * 10));

  for (const p of plans) {
    const secRng = new Rng(p.seed);
    const secDown = downbeats.filter((d) => d >= p.start - 0.05 && d < p.end - 0.1);

    // 4a. shooters on kicked downbeats
    if (p.shooters) {
      secDown.forEach((d, barIdx) => {
        if (barIdx % p.shooterEvery !== 0) return;
        if (isDropTime(d)) return; // the drop has its own blast
        const kick = nearOnset(a.onsets.kick, d, 0.09);
        if (!kick || kick.s < 0.2) return;
        const bi = beatIndexOf(d);
        const cap = hasDrops && p.label !== 'drop' ? 0.72 : 1;
        for (const st of shooterSteps(p.shooters!, barIdx, bpb)) {
          const peak = beatTime(bi + st.beat);
          if (peak >= p.end) continue;
          const h = FAMILY_MAX.shooter * heightAt(peak) * st.hf * cap * (0.8 + 0.2 * kick.s);
          const hold = Math.min(0.5, 0.45 * beatDur * (1 + st.hf));
          burst(SHOOTERS[st.i].id, peak, Math.max(14, h), hold, 'shooter');
        }
        markers.push({ t: d, kind: 'shooter' });
      });
    }

    // 4b. snares -> ring ripple or oarsmen snap
    const calm = p.tier === 'calm';
    const minGap = calm ? 1.2 : p.tier === 'medium' ? (songDrive > 0.2 ? 0.3 : 0.6) : 0.28;
    const minS = calm ? 0.4 : 0.25;
    let lastSn = -1e9;
    let snapSign = 1;
    let rippleStart = secRng.int(16);
    const snapMode = secRng.pick(['alt', 'all', 'wave', 'center'] as const);
    if (p.label !== 'build' || songDrive > 0.2) {
      const onGrid = a.beatConfidence > 0.5 && songDrive > 0.2;
      for (const o of a.onsets.snare) {
        if (o.t < p.start || o.t >= p.end || o.t >= cut) continue;
        if (o.s < minS || o.t - lastSn < minGap) continue;
        // with a solid beat, only snares that land on the grid (backbeats) drive the ring
        if (onGrid && Math.abs(beatTime(beatIndexOf(o.t)) - o.t) > 0.07) continue;
        if (drops.some((d) => Math.abs(d - o.t) < 0.3)) continue;
        lastSn = o.t;
        if (p.snareTarget === 'ring' || calm) {
          const dir = snapSign;
          const step = calm ? 0.065 : Math.min(0.03, beatDur / 20);
          const hRing = FAMILY_MAX.ring * (calm ? 0.35 + 0.25 * o.s : 0.55 + 0.45 * o.s) * Math.max(0.5, heightAt(o.t));
          for (let k = 0; k < 16; k++) {
            const j = (rippleStart + dir * k + 32) % 16;
            burst(RING[j].id, o.t + k * step, hRing, calm ? 0.3 : 0.1, 'ring');
          }
          rippleStart = (rippleStart + 5) % 16;
          snapSign = -snapSign;
          markers.push({ t: o.t, kind: 'ring' });
        } else {
          snaps.push({ t: o.t - 0.03, mode: snapMode, sign: snapSign, amount: 0.75 * p.swing * (0.7 + 0.3 * o.s) });
          snapSign = -snapSign;
          markers.push({ t: o.t, kind: 'snap' });
        }
      }
    }

    // 4c. hats -> small quick bursts on alternating oarsmen
    if (p.hats) {
      const gap = p.tier === 'intense' ? 0.11 : 0.2;
      let lastH = -1e9;
      let group = 0;
      for (const o of a.onsets.hat) {
        if (o.t < p.start || o.t >= p.end || o.t >= cut) continue;
        if (o.t - lastH < gap || o.s < 0.2) continue;
        lastH = o.t;
        for (const j of OARSMEN) {
          if (j.famIndex % 2 !== group) continue;
          burst(j.id, o.t, 2.5 + 4 * o.s, 0.07, 'hat', { boost: true });
        }
        group = 1 - group;
        markers.push({ t: o.t, kind: 'hat' });
      }
    }

    // 4d. build-ups: accelerating oarsmen snaps with the music
    if (p.label === 'build') {
      markers.push({ t: p.start, kind: 'build' });
      const inBuild = beats.filter((b) => b >= p.start && b < p.end - beatDur * 0.5);
      inBuild.forEach((b, k) => {
        const prog = (b - p.start) / Math.max(1, p.end - p.start);
        const every = prog < 0.5 ? 2 : prog < 0.8 ? 1 : 0.5;
        if (every === 2 && k % 2) return;
        const times = every === 0.5 ? [b, b + beatDur / 2] : [b];
        for (const tt of times) {
          snaps.push({ t: tt - 0.03, mode: 'alt', sign: snapSign, amount: 0.3 + 0.5 * prog });
          snapSign = -snapSign;
        }
      });
    }
  }

  // 4e. drops: everything peaks at once on the downbeat
  // valves stay open through the peak so every column is a solid wall from the water up
  const wall = (h: number, extra: number) => riseTime(h) + extra;
  for (const d of drops) {
    for (const j of SHOOTERS) {
      const h = FAMILY_MAX.shooter * (1 - 0.04 * Math.abs(j.famIndex - 3));
      burst(j.id, d, h, wall(h, 0.9), 'drop');
    }
    for (const j of FAN) burst(j.id, d, FAMILY_MAX.fan, wall(FAMILY_MAX.fan, 1.4), 'drop', { angle: 0 });
    for (const j of OARSMEN) burst(j.id, d, FAMILY_MAX.oarsman, wall(FAMILY_MAX.oarsman, 0.6), 'drop', { angle: 0 });
    for (const j of RING) burst(j.id, d, FAMILY_MAX.ring, wall(FAMILY_MAX.ring, 0.6), 'drop');
    addFlash(curves.flash, rate, d, 1, 0.9);
    markers.push({ t: d, kind: 'drop' });
  }
  // chorus entrances without a build get a smaller accent
  for (const p of plans) {
    if (p.label !== 'chorus' || p.index === 0 || p.tier === 'calm') continue;
    const d = p.start;
    for (const j of SHOOTERS) {
      const h = FAMILY_MAX.shooter * 0.72 * (1 - 0.05 * Math.abs(j.famIndex - 3));
      burst(j.id, d, h, riseTime(h) * 0.6, 'accent');
    }
    for (const j of FAN) burst(j.id, d, FAMILY_MAX.fan * 0.8, riseTime(FAMILY_MAX.fan * 0.8) + 0.3, 'accent');
    addFlash(curves.flash, rate, d, 0.45, 0.6);
    markers.push({ t: d, kind: 'accent' });
  }
  // 4f. graceful climaxes for drum-less music: a slow single center column on the biggest notes
  const maxSecE = Math.max(...a.sections.map((s) => s.energy), 0.01);
  for (const p of plans) {
    if (p.shooters || p.label === 'build' || p.label === 'intro' || p.label === 'outro') continue;
    if (p.tier === 'calm' && a.sections[p.index].energy < 0.85 * maxSecE) continue;
    const cands = a.onsets.snare.filter((o) => o.t > p.start + 1 && o.t < p.end - 2 && o.t < cut - 3);
    cands.sort((x, y) => y.s * curveAt(a.energy, y.t) - x.s * curveAt(a.energy, x.t));
    const picked: Onset[] = [];
    for (const o of cands) {
      if (picked.length >= Math.max(1, Math.floor((p.end - p.start) / 14))) break;
      if (picked.some((q) => Math.abs(q.t - o.t) < 8)) continue;
      picked.push(o);
    }
    for (const o of picked) {
      burst(SHOOTERS[3].id, o.t, FAMILY_MAX.shooter * 0.5 * p.level + 6, 1.3, 'accent');
      markers.push({ t: o.t, kind: 'accent' });
    }
  }

  // 4g. finale: one farewell column on the last strong note, then everything falls into silence
  {
    const lastNotes = [...a.onsets.kick, ...a.onsets.snare].filter((o) => o.t > tEnd - 8 && o.t < tEnd - 0.2 && o.s > 0.35);
    lastNotes.sort((x, y) => y.t - x.t);
    const fin = lastNotes[0];
    if (fin) {
      const h = FAMILY_MAX.shooter * 0.45 * Math.max(0.5, lastPlan.level);
      burst(SHOOTERS[3].id, fin.t, h, 0.6, 'finale');
      markers.push({ t: fin.t, kind: 'finale' });
      lightsOut = Math.max(lightsOut, fin.t + fallTimeFromApex(h) + 1.5);
    }
  }
  // lights fade after the last water has landed
  for (let i = 0; i < nC; i++) {
    const t = i / rate;
    if (t > cut) curves.light[i] *= 1 - smoothstep(cut, lightsOut, t);
  }

  // drop events cut through silences; everything else respects the finale cut
  for (const list of events) {
    for (let k = list.length - 1; k >= 0; k--) {
      const ev = list[k];
      if (ev.kind !== 'finale' && ev.peak > cut) list.splice(k, 1);
    }
    list.sort((x, y) => x.peak - y.peak);
  }
  snaps.sort((x, y) => x.t - y.t);

  // ---------------------------------------------------------------- 5. camera
  const shots: Shot[] = [];
  plans.forEach((p, i) => {
    let preset: CameraPreset;
    if (i === 0) preset = 'wide';
    else if (p.label === 'drop') preset = 'crane';
    else if (p.label === 'outro') preset = prevShot === 'wide' ? 'high' : 'wide';
    else preset = rng.pick(CAMERA_POOLS[p.label === 'build' ? 'build' : p.tier], prevShot ?? undefined);
    shots.push({ start: i === 0 ? 0 : p.start - (p.label === 'drop' ? 0.25 : 0), preset, seed: rng.seed(), blend: i === 0 ? 0 : p.label === 'drop' ? 1.2 : 2.8 });
    prevShot = preset;
    markers.push({ t: p.start, kind: 'camera' });
    // long sections get a second angle on a downbeat near the middle
    if (p.end - p.start > 26 && p.label !== 'build') {
      const mid = (p.start + p.end) / 2;
      const d = downbeats.reduce((b, x) => (Math.abs(x - mid) < Math.abs(b - mid) ? x : b), mid);
      const pool = p.label === 'drop' ? CAMERA_POOLS.intense : CAMERA_POOLS[p.tier];
      const preset2 = rng.pick(pool, preset);
      shots.push({ start: d, preset: preset2, seed: rng.seed(), blend: 3.2 });
      prevShot = preset2;
      markers.push({ t: d, kind: 'camera' });
    }
  });

  // ---------------------------------------------------------------- 6. mist projections
  const mistCues: MistCue[] = [];
  for (const p of plans) {
    const r = new Rng(p.seed ^ 0x51ed);
    const secDown = downbeats.filter((d) => d >= p.start && d < p.end);
    const secBeats = beats.filter((b) => b >= p.start && b < p.end);
    switch (p.label === 'build' ? 'build' : p.mist) {
      case 'rings':
        secDown.forEach((d, k) => {
          if (p.tier !== 'intense' && k % 2) return;
          mistCues.push({ t: d, dur: 2.2, kind: 'ring', color: k % 2 ? 2 : 0, x: r.range(-25, 25), y: r.range(10, 18), size: 1.5, speed: 16, strength: 1 });
        });
        break;
      case 'lines':
        secDown.forEach((d, k) =>
          mistCues.push({ t: d, dur: 2.6, kind: 'line', color: k % 3, x: 0, y: 0, size: 1, speed: 11, strength: 0.9 }),
        );
        break;
      case 'bars':
        secBeats.forEach((b, k) =>
          mistCues.push({ t: b, dur: 0.35, kind: 'bars', color: k % 2 ? 1 : 2, x: 0, y: 0, size: 9, speed: k % 2, strength: 0.9 }),
        );
        break;
      case 'spots': {
        let last = -1e9;
        for (const o of a.onsets.snare) {
          if (o.t < p.start || o.t >= p.end || o.t - last < 0.6) continue;
          last = o.t;
          mistCues.push({ t: o.t, dur: 1.4, kind: 'spot', color: r.int(3), x: r.range(-45, 45), y: r.range(7, 20), size: r.range(4, 8), speed: 0, strength: 0.5 + 0.5 * o.s });
        }
        break;
      }
      case 'build':
        secBeats.forEach((b, k) => {
          const prog = (b - p.start) / Math.max(1, p.end - p.start);
          if (prog < 0.5 && k % 2) return;
          mistCues.push({ t: b, dur: 1.6, kind: 'rise', color: 3, x: 0, y: 0, size: 1, speed: 10 + 22 * prog, strength: 0.4 + 0.6 * prog });
        });
        break;
      default:
        break;
    }
  }
  for (const d of drops) {
    mistCues.push({ t: d, dur: 1.4, kind: 'flash', color: 3, x: 0, y: 0, size: 1, speed: 0, strength: 1 });
    mistCues.push({ t: d, dur: 2.8, kind: 'ring', color: 0, x: 0, y: 14, size: 3, speed: 30, strength: 1 });
  }
  mistCues.sort((x, y) => x.t - y.t);

  // ---------------------------------------------------------------- 7. lasers
  const laserCues: LaserCue[] = [];
  for (const p of plans) {
    if (p.laser === 'off') continue;
    let s = p.start;
    if (p.label === 'drop') {
      laserCues.push({ start: p.start, end: p.start + barDur * 2, mode: 'burst', intensity: 1 });
      s = p.start + barDur * 2;
    }
    laserCues.push({ start: s, end: p.end, mode: p.laser, intensity: p.tier === 'intense' ? 1 : 0.7 });
  }

  markers.sort((x, y) => x.t - y.t);
  return {
    seed,
    duration,
    bpm: a.bpm,
    beatsPerBar: bpb,
    beats,
    downbeats,
    sections: plans,
    events,
    snaps,
    shots,
    mistCues,
    laserCues,
    markers,
    curves,
    wake,
    finale: { cut, lightsOut },
    drops,
    songDrive,
  };
}

// ------------------------------------------------------------------------------------ helpers
function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function smoothstep(a: number, b: number, x: number) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function meanCurve(c: Float32Array, rate: number, t0: number, t1: number) {
  const a = Math.max(0, Math.floor(t0 * rate));
  const b = Math.min(c.length, Math.max(a + 1, Math.floor(t1 * rate)));
  let s = 0;
  for (let i = a; i < b; i++) s += c[i];
  return s / Math.max(1, b - a);
}

function smoothInPlace(c: Float32Array, w: number) {
  if (w < 2) return;
  const h = Math.floor(w / 2);
  const cs = new Float64Array(c.length + 1);
  for (let i = 0; i < c.length; i++) cs[i + 1] = cs[i] + c[i];
  for (let i = 0; i < c.length; i++) {
    const a = Math.max(0, i - h);
    const b = Math.min(c.length, i + h + 1);
    c[i] = (cs[b] - cs[a]) / (b - a);
  }
}

function addFlash(c: Float32Array, rate: number, t: number, amount: number, decay: number) {
  const i0 = Math.max(0, Math.round(t * rate));
  for (let i = i0; i < c.length; i++) {
    const dt = (i - i0) / rate;
    if (dt > decay * 5) break;
    c[i] = Math.max(c[i], amount * Math.exp(-dt / decay));
  }
}

function pickPalette(rng: Rng, prev: number): number {
  let p = rng.int(PALETTE_COUNT);
  if (p === prev) p = (p + 1 + rng.int(PALETTE_COUNT - 1)) % PALETTE_COUNT;
  return p;
}

function steadyGrid(t0: number, t1: number, period: number): number[] {
  const out: number[] = [];
  for (let t = t0; t < t1; t += period) out.push(t);
  return out;
}

/** Continuous beat-index -> time, interpolating the beat grid and extrapolating at the ends. */
export function beatTimeFn(beats: number[], period: number) {
  return (pos: number) => {
    if (!beats.length) return pos * period;
    if (pos <= 0) return beats[0] + pos * period;
    const n = beats.length - 1;
    if (pos >= n) return beats[n] + (pos - n) * period;
    const i = Math.floor(pos);
    return beats[i] + (beats[i + 1] - beats[i]) * (pos - i);
  };
}

/** Fill unvoiced gaps by holding / relaxing toward the middle, then smooth. */
function melodyCurve(pitch: Float32Array, rate: number): Float32Array {
  const out = new Float32Array(pitch.length);
  let last = 0.5;
  let since = 0;
  for (let i = 0; i < pitch.length; i++) {
    if (pitch[i] >= 0) {
      last = pitch[i];
      since = 0;
      out[i] = last;
    } else {
      since += 1 / rate;
      const k = Math.min(1, since / 2.5);
      out[i] = last * (1 - k) + 0.5 * k;
    }
  }
  smoothInPlace(out, Math.round(rate * 0.35));
  return out;
}
