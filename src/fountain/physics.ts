// Ballistic water with linear air drag. Shared by the choreographer (to fire jets early so
// they PEAK on the beat) and by the particle simulation (same equations on the GPU).
//
//   dv/dt = g - k (v - wind)
//   vertical launch speed v  ->  apex H(v) = v/k - (g/k²)·ln(1 + k·v/g)
//                               rise time T(v) = ln(1 + k·v/g) / k

export const G = 9.81;
/** Median drag coefficient of a droplet (1/s). Individual droplets vary around it. */
export const K_DRAG = 0.12;
/** Time for a valve to go fully open/closed. */
export const VALVE_RAMP = 0.08;
/** Effective delay between commanding a valve open and full-speed water leaving the nozzle. */
export const VALVE_LAG = VALVE_RAMP * 0.6;
/** Water is emitted with a little extra life for the splash burst after it hits the pool. */
export const SPLASH_LIFE = 0.9;

export function apexHeight(v: number, k = K_DRAG): number {
  if (v <= 0) return 0;
  return v / k - (G / (k * k)) * Math.log(1 + (k * v) / G);
}

export function riseTimeForSpeed(v: number, k = K_DRAG): number {
  if (v <= 0) return 0;
  return Math.log(1 + (k * v) / G) / k;
}

/** Time to fall from rest through height h with linear drag. */
export function fallTime(h: number, k = K_DRAG): number {
  if (h <= 0) return 0;
  // h = (g/k) t - (g/k²)(1 - e^{-kt}); Newton from the drag-free guess
  let t = Math.sqrt((2 * h) / G);
  for (let i = 0; i < 8; i++) {
    const e = Math.exp(-k * t);
    const f = (G / k) * t - (G / (k * k)) * (1 - e) - h;
    const df = (G / k) * (1 - e);
    if (df < 1e-6) break;
    t -= f / df;
  }
  return t;
}

// lookup tables for the inverse (height -> speed / rise time)
const H_MAX = 90;
const H_STEP = 0.05;
const N_TAB = Math.ceil(H_MAX / H_STEP) + 1;
const speedTab = new Float32Array(N_TAB);
const riseTab = new Float32Array(N_TAB);
const fallTab = new Float32Array(N_TAB);
{
  let v = 0;
  for (let i = 0; i < N_TAB; i++) {
    const h = i * H_STEP;
    // increase v until apex >= h (monotone), then bisect
    let lo = v;
    let hi = Math.max(v + 0.5, Math.sqrt(2 * G * h) * 2 + 1);
    for (let it = 0; it < 40; it++) {
      const mid = 0.5 * (lo + hi);
      if (apexHeight(mid) < h) lo = mid;
      else hi = mid;
    }
    v = 0.5 * (lo + hi);
    speedTab[i] = v;
    riseTab[i] = riseTimeForSpeed(v);
    fallTab[i] = fallTime(h);
  }
}

function lookup(tab: Float32Array, h: number): number {
  if (h <= 0) return 0;
  const x = Math.min(h, H_MAX) / H_STEP;
  const i = Math.floor(x);
  if (i >= N_TAB - 1) return tab[N_TAB - 1];
  const f = x - i;
  return tab[i] * (1 - f) + tab[i + 1] * f;
}

/** Vertical launch speed that makes the median droplet peak at height h. */
export function speedForHeight(h: number): number {
  return lookup(speedTab, h);
}

/** Seconds from leaving the nozzle to the apex for a jet of apex height h. */
export function riseTime(h: number): number {
  return lookup(riseTab, h);
}

/** Seconds from the apex back down to the pool. */
export function fallTimeFromApex(h: number): number {
  return lookup(fallTab, h);
}

/** How long before the peak a valve must open for water to PEAK at a given moment. */
export function fireLead(h: number): number {
  return riseTime(h) + VALVE_LAG;
}

/** Conservative lifetime estimate of a droplet launched with vertical speed vy (for pool recycling). */
export function lifetimeForSpeed(vy: number): number {
  const kSlow = K_DRAG * 1.6; // high-drag spray lives longer on the way down
  const h = apexHeight(vy, K_DRAG * 0.7);
  return riseTimeForSpeed(vy, K_DRAG * 0.7) + fallTime(h, kSlow) * 1.15 + SPLASH_LIFE;
}
