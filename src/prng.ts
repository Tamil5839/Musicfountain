// Seeded PRNG (mulberry32) so the same song always produces the same show.

export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  static fromHash(hash: string, salt = 0): Rng {
    let h = 2166136261 ^ salt;
    for (let i = 0; i < hash.length; i++) {
      h ^= hash.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return new Rng(h >>> 0);
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  int(n: number): number {
    return Math.floor(this.next() * n) % n;
  }

  /** Pick an element, avoiding `exclude` when there is any alternative. */
  pick<T>(arr: readonly T[], exclude?: T | readonly T[]): T {
    const ex = exclude === undefined ? [] : Array.isArray(exclude) ? (exclude as readonly T[]) : [exclude as T];
    const pool = arr.filter((v) => !ex.includes(v));
    const from = pool.length ? pool : arr;
    return from[this.int(from.length)];
  }

  seed(): number {
    return Math.floor(this.next() * 2 ** 31);
  }
}
