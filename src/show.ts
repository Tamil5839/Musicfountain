// Timeline player. `Show` evaluates the choreography at any time t (pure function of t, so
// scrubbing and offline export are exact); `AudioPlayer` provides the playback clock.

import type { ShowData } from './choreographer';
import { beatTimeFn } from './choreographer';
import { FAMILY_MAX, JETS, JET_COUNT } from './fountain/layout';
import { fireLead, riseTime } from './fountain/physics';
import { fanPattern, oarsPattern, ringPattern, type JetOut, type PatternCtx } from './patterns';
import type { Analysis, Family, SectionPlan } from './types';

export interface JetTargets {
  flow: Float32Array;
  height: Float32Array;
  angle: Float32Array;
  omega: Float32Array;
  maxSpeed: Float32Array;
}

export function makeTargets(): JetTargets {
  return {
    flow: new Float32Array(JET_COUNT),
    height: new Float32Array(JET_COUNT),
    angle: new Float32Array(JET_COUNT),
    omega: new Float32Array(JET_COUNT).fill(4),
    maxSpeed: new Float32Array(JET_COUNT).fill(2),
  };
}

/** Maximum nozzle tilt per family (radians). */
export const MAX_TILT: Record<Family, number> = { shooter: 0, oarsman: 0.62, fan: 0.35, ring: 0.45 };

// Base patterns are evaluated slightly in the future so that what the audience sees at the
// top of the water column (which lags the nozzle by the rise time) lines up with the music.
const HEIGHT_LEAD: Record<Family, number> = {
  shooter: 0,
  oarsman: riseTime(FAMILY_MAX.oarsman * 0.5),
  fan: riseTime(FAMILY_MAX.fan * 0.5),
  ring: riseTime(FAMILY_MAX.ring * 0.5),
};
const ANGLE_LEAD = 0.25;
/** order in which families wake up during the intro (fraction of the wake window) */
const WAKE: Record<Family, [number, number]> = {
  ring: [0, 0.35],
  oarsman: [0.2, 0.6],
  fan: [0.4, 0.8],
  shooter: [0.7, 1],
};

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Show {
  readonly data: ShowData;
  readonly analysis: Analysis;
  readonly beatDur: number;
  private readonly beatTime: (pos: number) => number;
  private readonly out: JetOut = { flow: 0, h: 0, a: 0 };
  private readonly ctxH: PatternCtx;
  private readonly ctxA: PatternCtx;

  constructor(data: ShowData, analysis: Analysis) {
    this.data = data;
    this.analysis = analysis;
    this.beatDur = 60 / (data.bpm || 120);
    this.beatTime = beatTimeFn(data.beats, this.beatDur);
    const mk = (): PatternCtx => {
      const ctx: PatternCtx = { t: 0, beat: 0, bar: 0, pace: 1, build: 0, melodyAt: () => 0.5 };
      ctx.melodyAt = (lag: number) => this.curve('melody', ctx.t - lag);
      return ctx;
    };
    this.ctxH = mk();
    this.ctxA = mk();
  }

  get duration(): number {
    return this.data.duration;
  }

  sectionIndexAt(t: number): number {
    const s = this.data.sections;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (s[m].start <= t) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  sectionAt(t: number): SectionPlan {
    return this.data.sections[this.sectionIndexAt(t)];
  }

  /** Continuous beat position. */
  beatPos(t: number): number {
    const b = this.data.beats;
    if (!b.length) return t / this.beatDur;
    if (t <= b[0]) return (t - b[0]) / this.beatDur;
    const n = b.length - 1;
    if (t >= b[n]) return n + (t - b[n]) / this.beatDur;
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (b[m] <= t) lo = m;
      else hi = m;
    }
    return lo + (t - b[lo]) / (b[lo + 1] - b[lo]);
  }

  /** Continuous bar position (downbeat-aligned). */
  barPos(t: number): number {
    const d = this.data.downbeats;
    const barDur = this.beatDur * this.data.beatsPerBar;
    if (d.length < 2) return t / barDur;
    if (t <= d[0]) return (t - d[0]) / barDur;
    const n = d.length - 1;
    if (t >= d[n]) return n + (t - d[n]) / barDur;
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (d[m] <= t) lo = m;
      else hi = m;
    }
    return lo + (t - d[lo]) / (d[lo + 1] - d[lo]);
  }

  timeOfBeat(pos: number): number {
    return this.beatTime(pos);
  }

  curve(name: keyof Omit<ShowData['curves'], 'rate'>, t: number): number {
    const c = this.data.curves[name];
    const x = t * this.data.curves.rate;
    if (x <= 0) return c[0];
    const i = Math.floor(x);
    if (i >= c.length - 1) return c[c.length - 1];
    const f = x - i;
    return c[i] * (1 - f) + c[i + 1] * f;
  }

  /** 0..1 how awake a family is during the intro wake-up. */
  wake(family: Family, t: number): number {
    const w = this.data.wake;
    const len = w.end - w.start;
    const [a, b] = WAKE[family];
    return smoothstep(w.start + a * len, w.start + b * len, t);
  }

  private fillCtx(ctx: PatternCtx, t: number, p: SectionPlan) {
    ctx.t = t;
    ctx.beat = this.beatPos(t);
    ctx.bar = this.barPos(t);
    ctx.pace = p.pace;
    ctx.build = p.label === 'build' ? this.curve('build', t) : 0;
  }

  /** Fill jet targets at time t. `intensity` is the user's global jet-height multiplier. */
  evaluate(t: number, intensity: number, out: JetTargets): void {
    const d = this.data;
    for (let j = 0; j < JET_COUNT; j++) {
      const jet = JETS[j];
      const fam = jet.family;
      // ---- base pattern
      let flow = 0;
      let height = 0;
      let angle = 0;
      const pa = this.sectionAt(t + ANGLE_LEAD);
      if (fam !== 'shooter') {
        const th = t + HEIGHT_LEAD[fam];
        const ph = this.sectionAt(th);
        this.fillCtx(this.ctxH, th, ph);
        const o = this.pattern(fam, ph, jet.famIndex, jet.u, this.ctxH);
        const hs = this.curve('height', th) * this.wake(fam, th);
        const baseH = o.flow * o.h * FAMILY_MAX[fam] * hs * intensity;
        if (baseH > 1) {
          flow = 1;
          height = baseH;
        }
        this.fillCtx(this.ctxA, t + ANGLE_LEAD, pa);
        const oa = this.pattern(fam, pa, jet.famIndex, jet.u, this.ctxA);
        angle = oa.a * MAX_TILT[fam] * pa.swing;
        if (fam === 'oarsman') angle = this.applySnaps(t + ANGLE_LEAD, pa, jet.famIndex, jet.u, angle);
      }
      // ---- discrete events (fired early so they PEAK on time)
      const list = d.events[j];
      if (list.length) {
        let k = lowerBoundPeak(list, t - 4.5);
        for (; k < list.length; k++) {
          const ev = list[k];
          if (ev.peak > t + 4.8) break;
          const h = ev.boost ? (height > 1 ? height : 0) + ev.height * intensity : ev.height * intensity;
          const open = ev.peak - fireLead(h);
          if (t >= open && t < open + ev.hold) {
            flow = 1;
            if (h > height) height = h;
            if (ev.angle !== undefined) angle = ev.angle;
          }
        }
      }
      out.flow[j] = flow;
      out.height[j] = height;
      out.angle[j] = angle;
      out.omega[j] = pa.springOmega;
      out.maxSpeed[j] = pa.maxAngularSpeed;
    }
  }

  private pattern(fam: Family, p: SectionPlan, i: number, u: number, ctx: PatternCtx): JetOut {
    switch (fam) {
      case 'oarsman':
        return oarsPattern(p.oars, i, u, ctx, this.out);
      case 'fan':
        return fanPattern(p.fan, i, u, ctx, this.out);
      case 'ring':
        return ringPattern(p.ring, i, u, ctx, this.out);
      default:
        this.out.flow = 0;
        return this.out;
    }
  }

  private applySnaps(t: number, p: SectionPlan, i: number, u: number, base: number): number {
    const s = this.data.snaps;
    if (!s.length) return base;
    let lo = 0;
    let hi = s.length - 1;
    if (s[0].t > t) return base;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (s[m].t <= t) lo = m;
      else hi = m - 1;
    }
    const sn = s[lo];
    if (sn.t < p.start - 0.1) return base;
    const dt = t - sn.t;
    const bd = this.beatDur;
    if (dt > 4 * bd) return base;
    const w = dt < bd ? 1 : Math.exp(-(dt - bd) / (1.2 * bd));
    let target: number;
    switch (sn.mode) {
      case 'all':
        target = sn.sign * sn.amount;
        break;
      case 'alt':
        target = sn.sign * sn.amount * (i % 2 ? 1 : -1);
        break;
      case 'wave':
        target = sn.sign * sn.amount * Math.sin(u * Math.PI * 0.5 + sn.sign);
        break;
      default:
        target = -Math.sign(u || 1) * sn.amount * (0.4 + 0.6 * Math.abs(u)) * sn.sign;
    }
    return base * (1 - w) + target * MAX_TILT.oarsman * w;
  }
}

function lowerBoundPeak(list: { peak: number }[], v: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (list[m].peak < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Background "idle" fountain shown before a song is loaded: slow, low, breathing water. */
export function idleTargets(t: number, out: JetTargets): void {
  const ctx: PatternCtx = { t, beat: t / 1.2, bar: t / 4.8, pace: 0.2, build: 0, melodyAt: () => 0.5 };
  const o: JetOut = { flow: 0, h: 0, a: 0 };
  for (let j = 0; j < JET_COUNT; j++) {
    const jet = JETS[j];
    let flow = 0;
    let h = 0;
    let a = 0;
    if (jet.family === 'fan') {
      fanPattern('curtainBreath', jet.famIndex, jet.u, ctx, o);
      flow = 1;
      h = o.h * 0.9;
      a = o.a * MAX_TILT.fan;
    } else if (jet.family === 'ring') {
      ringPattern('crown', jet.famIndex, jet.u, ctx, o);
      flow = 1;
      h = o.h * 0.55;
      a = o.a * MAX_TILT.ring;
    } else if (jet.family === 'oarsman') {
      oarsPattern('breathe', jet.famIndex, jet.u, ctx, o);
      flow = 1;
      h = o.h * 0.8;
      a = o.a * MAX_TILT.oarsman * 0.6;
    }
    out.flow[j] = flow;
    out.height[j] = h * FAMILY_MAX[jet.family];
    out.angle[j] = a;
    out.omega[j] = 1.5;
    out.maxSpeed[j] = 0.4;
  }
}

// ---------------------------------------------------------------------------------------------
// Audio playback clock
// ---------------------------------------------------------------------------------------------
export class AudioPlayer {
  readonly ctx: AudioContext;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private readonly gain: GainNode;
  private startedAt = 0;
  private offset = 0;
  private offsetAtStart = 0;
  playing = false;
  onEnded: (() => void) | null = null;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }

  load(buffer: AudioBuffer) {
    this.stop();
    this.buffer = buffer;
    this.offset = 0;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  /** Current song time, compensated for output latency so the picture matches what you hear. */
  get time(): number {
    if (!this.playing) return this.offset;
    const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    // what is audible right now was scheduled `lat` seconds ago; never run backwards past the seek point
    return Math.max(this.offsetAtStart, this.ctx.currentTime - this.startedAt - lat);
  }

  async play() {
    if (!this.buffer) return;
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.offset >= this.buffer.duration - 0.05) this.offset = 0;
    this.stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    src.onended = () => {
      if (this.source === src && this.playing) {
        this.playing = false;
        this.offset = this.buffer?.duration ?? 0;
        this.onEnded?.();
      }
    };
    this.startedAt = this.ctx.currentTime - this.offset;
    this.offsetAtStart = this.offset;
    src.start(0, this.offset);
    this.source = src;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.time;
    this.playing = false;
    this.stopSource();
  }

  seek(t: number) {
    const was = this.playing;
    if (was) this.pause();
    this.offset = Math.max(0, Math.min(this.duration, t));
    if (was) void this.play();
  }

  stop() {
    this.playing = false;
    this.stopSource();
    this.offset = 0;
  }

  private stopSource() {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        /* already stopped */
      }
      this.source.disconnect();
      this.source = null;
    }
  }
}
