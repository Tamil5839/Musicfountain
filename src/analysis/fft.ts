// Iterative radix-2 complex FFT, in place. Small and allocation-free per call.

export class FFT {
  readonly n: number;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly rev: Uint32Array;

  constructor(n: number) {
    if ((n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  transform(re: Float32Array, im: Float32Array): void {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        let k = 0;
        for (let j = start; j < start + half; j++) {
          const wr = this.cos[k];
          const wi = this.sin[k];
          const l = j + half;
          const tr = re[l] * wr - im[l] * wi;
          const ti = re[l] * wi + im[l] * wr;
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
          k += step;
        }
      }
    }
  }
}
