// The pattern library: named, reusable movements a show designer strings together.
// Continuous patterns describe each jet's flow / height / tilt as a function of musical time;
// shooter patterns describe which of the 7 tall jets fire where inside a bar.

import type { FanPattern, OarsPattern, RingPattern, ShooterPattern, Tier } from './types';

export interface PatternCtx {
  /** seconds */
  t: number;
  /** continuous beat position (beats since song start on the beat grid) */
  beat: number;
  /** continuous bar position */
  bar: number;
  /** cycles-per-bar multiplier (calm sections move slower) */
  pace: number;
  /** melody 0..1 sampled with a small per-jet lag */
  melodyAt: (lag: number) => number;
  /** 0..1 progress through a build-up (0 outside builds) */
  build: number;
}

/** Normalized jet command: flow 0..1, height 0..1 of the family max, tilt −1..1 of the family max tilt. */
export interface JetOut {
  flow: number;
  h: number;
  a: number;
}

const TAU = Math.PI * 2;
const frac = (x: number) => x - Math.floor(x);
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const gauss = (d: number, w: number) => Math.exp(-(d / w) * (d / w));

function set(o: JetOut, flow: number, h: number, a: number): JetOut {
  o.flow = flow;
  o.h = h;
  o.a = a;
  return o;
}

// ------------------------------------------------------------------------------ oarsmen (24)
export function oarsPattern(name: OarsPattern, i: number, u: number, c: PatternCtx, o: JetOut): JetOut {
  const p = c.pace;
  switch (name) {
    case 'wave': {
      const ph = c.bar * p * 0.5 - 0.6 * u;
      return set(o, 1, 0.62 + 0.22 * Math.sin(TAU * (ph + 0.25)), Math.sin(TAU * ph));
    }
    case 'mirror': {
      const s = Math.sin(TAU * c.bar * p * 0.5);
      return set(o, 1, 0.58 + 0.28 * Math.abs(s) * (1 - Math.abs(u) * 0.5), s * Math.sign(u || 1) * (0.35 + 0.65 * Math.abs(u)));
    }
    case 'split': {
      const s = Math.sin(TAU * c.bar * p);
      return set(o, 1, 0.55 + 0.2 * Math.cos(TAU * c.bar * p), (i % 2 ? s : -s) * 0.9);
    }
    case 'chase': {
      const pos = frac(c.bar * p * 0.5) * 2.8 - 1.4;
      return set(o, 1, 0.22 + 0.72 * gauss(u - pos, 0.22), 0.25 * Math.sin(TAU * c.bar * p * 0.5));
    }
    case 'sing': {
      const m = c.melodyAt(0.12 * (u + 1));
      return set(o, 1, 0.38 + 0.47 * m, (m * 2 - 1) * 0.9);
    }
    case 'fanOut': {
      const s = 0.5 + 0.5 * Math.sin(TAU * c.bar * p * 0.5);
      return set(o, 1, 0.55 + 0.3 * (1 - s), u * (0.3 + 0.7 * s));
    }
    case 'crossfire': {
      const pk = Math.exp(-frac(c.beat) * 3.5);
      return set(o, 1, 0.5 + 0.35 * pk, (i % 2 ? 1 : -1) * (0.55 + 0.45 * pk));
    }
    case 'pulse': {
      const pk = Math.exp(-frac(c.beat) * 4);
      return set(o, 1, 0.3 + 0.65 * pk, 0.12 * u);
    }
    case 'sweep': {
      const ph = TAU * c.bar * p * 0.25;
      return set(o, 1, 0.55 + 0.25 * Math.abs(Math.cos(ph)), Math.sin(ph));
    }
    case 'ripple': {
      const r = frac(c.bar * p) * 1.5;
      const g = gauss(Math.abs(u) - r, 0.18);
      return set(o, 1, 0.3 + 0.65 * g, 0.4 * u * g);
    }
    case 'alternate': {
      const g = 0.5 + 0.5 * Math.cos(Math.PI * (c.beat + i));
      return set(o, 1, 0.3 + 0.55 * g * g, i % 2 ? 0.22 : -0.22);
    }
    case 'whip': {
      const s = Math.floor(c.beat * Math.max(0.5, p) - i * 0.04) % 2 ? 1 : -1;
      return set(o, 1, 0.62, s * 0.85);
    }
    case 'breathe':
      return set(o, 1, 0.28 + 0.14 * Math.sin((TAU * c.t) / 7 + u), 0.35 * Math.sin((TAU * c.t) / 9 - u * 1.2));
    case 'rise': {
      const rate = 0.25 + 1.75 * c.build * c.build;
      return set(o, 1, 0.3 + 0.62 * c.build, (0.15 + 0.35 * c.build) * Math.sin(TAU * c.beat * rate * 0.5 - u * 1.5));
    }
    case 'off':
    default:
      return set(o, 0, 0, 0);
  }
}

// ------------------------------------------------------------------------------ fan / curtain (40)
export function fanPattern(name: FanPattern, _i: number, u: number, c: PatternCtx, o: JetOut): JetOut {
  const p = c.pace;
  switch (name) {
    case 'curtainWave':
      return set(o, 1, 0.45 + 0.35 * Math.sin(TAU * (c.bar * p * 0.5 - 0.9 * u)), 0);
    case 'curtainFull':
      return set(o, 1, 0.82 + 0.1 * Math.sin((TAU * c.beat) / 2 + u * 2), 0);
    case 'curtainSplit': {
      const g = 0.15 + 0.7 * (0.5 + 0.5 * Math.sin(TAU * c.bar * p * 0.25));
      return set(o, 1, 0.15 + 0.75 * smoothstep(g - 0.12, g + 0.12, Math.abs(u)), 0.2 * u);
    }
    case 'curtainV': {
      const v = 0.5 + 0.5 * Math.sin(TAU * c.bar * p * 0.25);
      const au = Math.abs(u);
      return set(o, 1, 0.25 + 0.65 * (au * (1 - v) + (1 - au) * v), 0);
    }
    case 'curtainBreath':
      return set(o, 1, 0.22 + 0.12 * Math.sin((TAU * c.t) / 10 + u * 2), 0.3 * Math.sin((TAU * c.t) / 8 - u * 1.5));
    case 'curtainRise':
      return set(o, 1, 0.2 + 0.75 * c.build, 0.12 * Math.sin((TAU * c.beat) / 4 + u * 3));
    case 'off':
    default:
      return set(o, 0, 0, 0);
  }
}

// ------------------------------------------------------------------------------ ring (16)
export function ringPattern(name: RingPattern, i: number, _u: number, c: PatternCtx, o: JetOut): JetOut {
  const p = c.pace;
  switch (name) {
    case 'spiral': {
      const ph = frac(c.beat * p * 0.5 - i / 16);
      const d = Math.min(ph, 1 - ph);
      return set(o, 1, 0.25 + 0.75 * gauss(d, 0.12), 0.25);
    }
    case 'ringPulse': {
      const pk = Math.exp(-frac(c.beat) * 4);
      return set(o, 1, 0.35 + 0.6 * pk, -0.25);
    }
    case 'crown':
      return set(o, 1, 0.55 + 0.1 * Math.sin(TAU * (c.t / 6 + i / 16)), -0.38);
    case 'bloom': {
      const s = 0.5 + 0.5 * Math.sin(TAU * c.bar * p * 0.25);
      return set(o, 1, 0.45 + 0.35 * s, -0.35 + 0.8 * s);
    }
    case 'off':
    default:
      return set(o, 0, 0, 0);
  }
}

// ------------------------------------------------------------------------------ shooters (7)
export interface ShooterStep {
  /** shooter index 0..6, left to right */
  i: number;
  /** beat offset inside the bar */
  beat: number;
  /** height factor */
  hf: number;
}

export function shooterSteps(name: ShooterPattern, barIdx: number, beatsPerBar: number): ShooterStep[] {
  const last = beatsPerBar - 1;
  const at = (i: number, beat: number, hf: number): ShooterStep => ({ i, beat: Math.min(beat, last + 0.5), hf });
  switch (name) {
    case 'center':
      return [at(3, 0, 1)];
    case 'outsideIn': {
      const groups = [[0, 6], [1, 5], [2, 4], [3]];
      return groups[barIdx % 4].map((i) => at(i, 0, i === 3 ? 1 : 0.85));
    }
    case 'insideOut': {
      const groups = [[3], [2, 4], [1, 5], [0, 6]];
      return groups[barIdx % 4].map((i) => at(i, 0, i === 3 ? 1 : 0.85));
    }
    case 'chaseLR':
      return [0, 1, 2, 3, 4, 5, 6].map((i) => at(i, (i * beatsPerBar) / 8, 0.72 + 0.04 * i));
    case 'chaseRL':
      return [6, 5, 4, 3, 2, 1, 0].map((i, k) => at(i, (k * beatsPerBar) / 8, 0.72 + 0.04 * k));
    case 'pairs':
      return [
        at(3, 0, 1),
        at(2, 1, 0.8),
        at(4, 1, 0.8),
        at(1, Math.min(2, last), 0.75),
        at(5, Math.min(2, last), 0.75),
        ...(beatsPerBar >= 4 ? [at(0, 3, 0.7), at(6, 3, 0.7)] : []),
      ];
    case 'all':
      return [0, 1, 2, 3, 4, 5, 6].map((i) => at(i, 0, 1 - 0.07 * Math.abs(i - 3)));
    case 'alternate':
      return (barIdx % 2 ? [1, 3, 5] : [0, 2, 4, 6]).map((i) => at(i, 0, i === 3 ? 1 : 0.85));
  }
}

// ------------------------------------------------------------------------------ pools per tier
export const OARS_POOLS: Record<Tier | 'build', OarsPattern[]> = {
  calm: ['sing', 'breathe', 'wave', 'mirror'],
  medium: ['wave', 'mirror', 'split', 'chase', 'sing', 'fanOut', 'sweep', 'ripple'],
  intense: ['crossfire', 'pulse', 'alternate', 'whip', 'ripple', 'chase', 'split', 'fanOut'],
  build: ['rise'],
};

export const FAN_POOLS: Record<Tier | 'build', FanPattern[]> = {
  calm: ['curtainBreath', 'curtainWave'],
  medium: ['curtainWave', 'curtainSplit', 'curtainV', 'off'],
  intense: ['curtainFull', 'curtainWave', 'curtainV', 'curtainSplit'],
  build: ['curtainRise'],
};

export const RING_POOLS: Record<Tier | 'build', RingPattern[]> = {
  calm: ['crown', 'bloom', 'off'],
  medium: ['spiral', 'crown', 'ringPulse', 'bloom'],
  intense: ['spiral', 'ringPulse', 'bloom'],
  build: ['spiral'],
};

export const SHOOTER_POOLS: Record<'medium' | 'intense', ShooterPattern[]> = {
  medium: ['center', 'pairs', 'alternate'],
  intense: ['outsideIn', 'insideOut', 'chaseLR', 'chaseRL', 'pairs', 'all', 'alternate'],
};

/** Every named pattern in the library (for the README / UI). */
export const PATTERN_NAMES = [
  ...new Set<string>([
    ...Object.values(OARS_POOLS).flat(),
    ...Object.values(FAN_POOLS).flat(),
    ...Object.values(RING_POOLS).flat(),
    ...Object.values(SHOOTER_POOLS).flat(),
  ]),
].filter((n) => n !== 'off');
