// Small numeric helpers used by the analysis passes.

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Centered moving average with window `w` samples (odd-ized), edge-normalized. */
export function movingAverage(x: ArrayLike<number>, w: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  const h = Math.max(0, Math.floor(w / 2));
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + x[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h);
    const b = Math.min(n, i + h + 1);
    out[i] = (cs[b] - cs[a]) / (b - a);
  }
  return out;
}

/** Moving maximum over a centered window. O(n*w) but windows are small. */
export function movingMax(x: ArrayLike<number>, w: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  const h = Math.floor(w / 2);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    const a = Math.max(0, i - h);
    const b = Math.min(n - 1, i + h);
    for (let j = a; j <= b; j++) if (x[j] > m) m = x[j];
    out[i] = m;
  }
  return out;
}

export function percentile(x: ArrayLike<number>, p: number): number {
  const arr: number[] = [];
  for (let i = 0; i < x.length; i++) if (Number.isFinite(x[i])) arr.push(x[i]);
  if (arr.length === 0) return 0;
  arr.sort((a, b) => a - b);
  const idx = clamp((p / 100) * (arr.length - 1), 0, arr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}

export function mean(x: ArrayLike<number>, a = 0, b = x.length): number {
  let s = 0;
  let c = 0;
  for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) {
    if (Number.isFinite(x[i])) {
      s += x[i];
      c++;
    }
  }
  return c ? s / c : 0;
}

export function std(x: ArrayLike<number>): number {
  const m = mean(x);
  let s = 0;
  let c = 0;
  for (let i = 0; i < x.length; i++) {
    if (Number.isFinite(x[i])) {
      s += (x[i] - m) * (x[i] - m);
      c++;
    }
  }
  return c ? Math.sqrt(s / c) : 0;
}

export function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/** Linear interpolation of a frame-rate signal at fractional index. */
export function sampleAt(x: ArrayLike<number>, idx: number): number {
  if (x.length === 0) return 0;
  if (idx <= 0) return x[0];
  const n = x.length - 1;
  if (idx >= n) return x[n];
  const i = Math.floor(idx);
  const f = idx - i;
  return x[i] * (1 - f) + x[i + 1] * f;
}

/** Resample a signal defined at `srcRate` onto a `dstRate` grid covering `duration` seconds. */
export function resample(x: ArrayLike<number>, srcRate: number, dstRate: number, duration: number): Float32Array {
  const n = Math.max(1, Math.ceil(duration * dstRate) + 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = sampleAt(x, (i / dstRate) * srcRate);
  return out;
}

/** Resample by averaging (for downsampling noisy signals). */
export function resampleMean(x: ArrayLike<number>, srcRate: number, dstRate: number, duration: number): Float32Array {
  const n = Math.max(1, Math.ceil(duration * dstRate) + 1);
  const out = new Float32Array(n);
  const ratio = srcRate / dstRate;
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i - 0.5) * ratio);
    const b = Math.max(a + 1, Math.floor((i + 0.5) * ratio));
    out[i] = mean(x, Math.max(0, a), Math.min(x.length, b));
  }
  return out;
}

export function toDb(v: number): number {
  return 20 * Math.log10(v + 1e-9);
}

/** Simple linear regression; returns slope and Pearson r. */
export function regression(ys: ArrayLike<number>, a: number, b: number, dx = 1): { slope: number; r: number } {
  const n = b - a;
  if (n < 3) return { slope: 0, r: 0 };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = a; i < b; i++) {
    const xv = (i - a) * dx;
    const yv = ys[i];
    sx += xv;
    sy += yv;
    sxx += xv * xv;
    syy += yv * yv;
    sxy += xv * yv;
  }
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  const slope = vx > 1e-12 ? cov / vx : 0;
  const r = vx > 1e-12 && vy > 1e-12 ? cov / Math.sqrt(vx * vy) : 0;
  return { slope, r };
}

/** Nearest value in a sorted array (returns index). */
export function nearestIndex(sorted: number[], v: number): number {
  if (!sorted.length) return -1;
  let lo = 0;
  let hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid;
    else hi = mid;
  }
  return Math.abs(sorted[lo] - v) <= Math.abs(sorted[hi] - v) ? lo : hi;
}

/** First index with sorted[i] >= v. */
export function lowerBound(sorted: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
