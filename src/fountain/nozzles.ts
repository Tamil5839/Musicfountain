// Nozzle actuators: valves ramp (~80 ms), pump pressure slews, pivots swing on damped springs.
// Also does the CPU half of particle emission: each jet owns a ring buffer of particles on the
// GPU and we tell the GPU which slice of it to (re)launch every simulation step.

import type { JetTargets } from '../show';
import { JETS, JET_COUNT } from './layout';
import { VALVE_RAMP, lifetimeForSpeed, speedForHeight } from './physics';

/** Rows of the per-jet data texture shared with the GPU. */
export const JET_TEX_W = 128;
export const JET_TEX_H = 8;
export const ROW = {
  nozzle: 0, // xyz, pool size
  dirA: 1, // direction at step start, speed
  dirB: 2, // direction at step end, speed
  emit: 3, // emitStart, emitCount, spread, nozzle radius
  light: 4, // rgb, intensity
  state: 5, // valve, vertical speed, family id, pool offset
} as const;

const FAMILY_ID = { shooter: 0, oarsman: 1, ring: 2, fan: 3 } as const;

const GUARD_BINS = 80;
const GUARD_BIN_DT = 0.25;

export class NozzleBank {
  readonly valve = new Float32Array(JET_COUNT);
  /** current vertical exit speed (m/s) at full valve */
  readonly vy = new Float32Array(JET_COUNT);
  readonly angle = new Float32Array(JET_COUNT);
  readonly angVel = new Float32Array(JET_COUNT);
  private readonly cursor = new Float64Array(JET_COUNT);
  private readonly carry = new Float64Array(JET_COUNT);
  private readonly prevDir = new Float32Array(JET_COUNT * 4);
  private readonly guardStart = new Float64Array(JET_COUNT * GUARD_BINS).fill(-1e9);
  private readonly guardMax = new Float32Array(JET_COUNT * GUARD_BINS);
  /** particles per jet */
  poolSize: Int32Array = new Int32Array(JET_COUNT);
  /** the GPU data texture contents (RGBA float, JET_TEX_W × JET_TEX_H) */
  readonly tex = new Float32Array(JET_TEX_W * JET_TEX_H * 4);
  /** emitted count this step (for stats) */
  emittedThisStep = 0;

  constructor(poolSizes: Int32Array) {
    this.setPools(poolSizes);
  }

  setPools(poolSizes: Int32Array) {
    this.poolSize = poolSizes;
    let offset = 0;
    for (let j = 0; j < JET_COUNT; j++) {
      const jet = JETS[j];
      this.set(ROW.nozzle, j, jet.pos[0], jet.pos[1], jet.pos[2], poolSizes[j]);
      this.set(ROW.state, j, 0, 0, FAMILY_ID[jet.family], offset);
      offset += poolSizes[j];
    }
    this.reset();
  }

  reset() {
    this.valve.fill(0);
    this.vy.fill(0);
    this.angle.fill(0);
    this.angVel.fill(0);
    this.cursor.fill(0);
    this.carry.fill(0);
    this.guardStart.fill(-1e9);
    this.guardMax.fill(0);
    for (let j = 0; j < JET_COUNT; j++) {
      this.prevDir.set([0, 1, 0, 0], j * 4);
      this.set(ROW.dirA, j, 0, 1, 0, 0);
      this.set(ROW.dirB, j, 0, 1, 0, 0);
      this.set(ROW.emit, j, 0, 0, JETS[j].spread, JETS[j].radius);
    }
  }

  private set(row: number, j: number, a: number, b: number, c: number, d: number) {
    const o = (row * JET_TEX_W + j) * 4;
    this.tex[o] = a;
    this.tex[o + 1] = b;
    this.tex[o + 2] = c;
    this.tex[o + 3] = d;
  }

  setLight(j: number, r: number, g: number, b: number, intensity: number) {
    this.set(ROW.light, j, r, g, b, intensity);
  }

  /** How long particles emitted recently by jet j may still be alive (s). */
  private guard(j: number, t: number): number {
    let g = 1.2;
    const base = j * GUARD_BINS;
    for (let b = 0; b < GUARD_BINS; b++) {
      const m = this.guardMax[base + b];
      if (m > g && this.guardStart[base + b] + GUARD_BIN_DT + m > t) g = m;
    }
    return g;
  }

  private noteLifetime(j: number, t: number, life: number) {
    const bin = Math.floor(t / GUARD_BIN_DT);
    const idx = j * GUARD_BINS + (((bin % GUARD_BINS) + GUARD_BINS) % GUARD_BINS);
    const start = bin * GUARD_BIN_DT;
    if (this.guardStart[idx] !== start) {
      this.guardStart[idx] = start;
      this.guardMax[idx] = life;
    } else if (life > this.guardMax[idx]) this.guardMax[idx] = life;
  }

  /** Advance actuators by dt toward the targets and compute this step's emission. */
  step(t: number, dt: number, targets: JetTargets) {
    let emitted = 0;
    const kP = 1 - Math.exp(-dt / 0.05); // pressure slew
    for (let j = 0; j < JET_COUNT; j++) {
      const jet = JETS[j];
      // valve ramp: water can't switch instantly
      const dv = targets.flow[j] - this.valve[j];
      const maxDv = dt / VALVE_RAMP;
      this.valve[j] += Math.max(-maxDv, Math.min(maxDv, dv));
      // pump pressure (exit speed) follows the commanded height smoothly
      const vyT = speedForHeight(targets.height[j]);
      if (this.valve[j] < 0.02) this.vy[j] = vyT;
      else this.vy[j] += (vyT - this.vy[j]) * kP;
      // pivot: critically damped spring with a speed limit
      const w = targets.omega[j];
      const acc = w * w * (targets.angle[j] - this.angle[j]) - 2 * w * this.angVel[j];
      let av = this.angVel[j] + acc * dt;
      const ms = targets.maxSpeed[j];
      av = Math.max(-ms, Math.min(ms, av));
      this.angVel[j] = av;
      this.angle[j] += av * dt;

      // exit velocity: partially open valve -> lower jet
      const open = this.valve[j];
      const vyEmit = this.vy[j] * Math.sqrt(Math.max(0, open));
      // tilt toward the jet's sway direction; speed is compensated so the apex height stays
      // what the choreography asked for while the jet swings
      const a = this.angle[j];
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const speed = vyEmit / Math.max(0.5, ca);
      const dx = sa * jet.sway[0];
      const dy = ca;
      const dz = sa * jet.sway[2];
      const pd = j * 4;
      this.set(ROW.dirA, j, this.prevDir[pd], this.prevDir[pd + 1], this.prevDir[pd + 2], this.prevDir[pd + 3]);
      this.set(ROW.dirB, j, dx, dy, dz, speed);
      this.prevDir[pd] = dx;
      this.prevDir[pd + 1] = dy;
      this.prevDir[pd + 2] = dz;
      this.prevDir[pd + 3] = speed;

      // emission from the jet's ring buffer
      const pool = this.poolSize[j];
      let count = 0;
      if (open > 0.01 && vyEmit > 0.3 && pool > 0) {
        const life = lifetimeForSpeed(vyEmit);
        this.noteLifetime(j, t, life);
        const rate = (pool / this.guard(j, t)) * Math.min(1, open * 1.25);
        const total = rate * dt + this.carry[j];
        count = Math.min(pool, Math.floor(total));
        this.carry[j] = total - count;
      } else {
        this.carry[j] = 0;
      }
      this.set(ROW.emit, j, this.cursor[j], count, jet.spread, jet.radius);
      this.cursor[j] = (this.cursor[j] + count) % Math.max(1, pool);
      const st = (ROW.state * JET_TEX_W + j) * 4;
      this.tex[st] = open;
      this.tex[st + 1] = vyEmit;
      emitted += count;
    }
    this.emittedThisStep = emitted;
  }
}

/** Split a particle budget between jets according to their weights. */
export function allocatePools(total: number): Int32Array {
  const out = new Int32Array(JET_COUNT);
  let used = 0;
  for (let j = 0; j < JET_COUNT; j++) {
    out[j] = Math.floor(total * JETS[j].weight);
    used += out[j];
  }
  let j = 0;
  while (used < total) {
    out[j % JET_COUNT]++;
    used++;
    j++;
  }
  return out;
}
