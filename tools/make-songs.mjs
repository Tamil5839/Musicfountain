// Generates three very different test songs as 44.1 kHz stereo WAV files:
//   edm.wav   — 128 BPM, intro / verse / 8-bar build (snare roll + riser) / big drop / breakdown / build / drop / outro
//   piano.wav — slow rubato piano (~66 BPM), arpeggios + melody, gentle dynamics
//   pop.wav   — 100 BPM verse / pre-chorus / chorus form with a sung-like lead
// Usage: node tools/make-songs.mjs [outDir]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SR = 44100;
const outDir = process.argv[2] || 'tools/out';
mkdirSync(outDir, { recursive: true });

let seed = 12345;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const noise = () => rnd() * 2 - 1;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

class Track {
  constructor(seconds) {
    this.n = Math.ceil(seconds * SR);
    this.L = new Float32Array(this.n);
    this.R = new Float32Array(this.n);
  }
  add(t0, buf, gain = 1, pan = 0) {
    const i0 = Math.round(t0 * SR);
    const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < buf.length; i++) {
      const j = i0 + i;
      if (j < 0 || j >= this.n) continue;
      this.L[j] += buf[i] * gl;
      this.R[j] += buf[i] * gr;
    }
  }
  normalize(peak = 0.89) {
    let m = 0;
    for (let i = 0; i < this.n; i++) m = Math.max(m, Math.abs(this.L[i]), Math.abs(this.R[i]));
    const g = peak / (m || 1);
    for (let i = 0; i < this.n; i++) {
      this.L[i] = Math.tanh(this.L[i] * g * 1.1) / Math.tanh(1.1);
      this.R[i] = Math.tanh(this.R[i] * g * 1.1) / Math.tanh(1.1);
    }
  }
  write(path) {
    const data = Buffer.alloc(44 + this.n * 4);
    data.write('RIFF', 0);
    data.writeUInt32LE(36 + this.n * 4, 4);
    data.write('WAVE', 8);
    data.write('fmt ', 12);
    data.writeUInt32LE(16, 16);
    data.writeUInt16LE(1, 20);
    data.writeUInt16LE(2, 22);
    data.writeUInt32LE(SR, 24);
    data.writeUInt32LE(SR * 4, 28);
    data.writeUInt16LE(4, 32);
    data.writeUInt16LE(16, 34);
    data.write('data', 36);
    data.writeUInt32LE(this.n * 4, 40);
    for (let i = 0; i < this.n; i++) {
      data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(this.L[i] * 32767))), 44 + i * 4);
      data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(this.R[i] * 32767))), 46 + i * 4);
    }
    writeFileSync(path, data);
    console.log('wrote', path, (this.n / SR).toFixed(1) + 's');
  }
}

// ---------------------------------------------------------------- instruments
function kick(dur = 0.45) {
  const n = Math.round(dur * SR);
  const b = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 45 + 110 * Math.exp(-t / 0.035);
    ph += (2 * Math.PI * f) / SR;
    b[i] = Math.sin(ph) * Math.exp(-t / 0.22) + (i < 60 ? noise() * 0.4 * (1 - i / 60) : 0);
  }
  return b;
}
function snare(dur = 0.25, tone = 190) {
  const n = Math.round(dur * SR);
  const b = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const w = noise();
    const hp = w - prev;
    prev = w;
    b[i] = hp * 0.6 * Math.exp(-t / 0.09) + Math.sin(2 * Math.PI * tone * t) * 0.5 * Math.exp(-t / 0.05);
  }
  return b;
}
function hat(dur = 0.06) {
  const n = Math.round(Math.max(dur * 4, 0.05) * SR);
  const b = new Float32Array(n);
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const w = noise();
    const hp = w - 2 * p1 + p2;
    p2 = p1;
    p1 = w;
    b[i] = hp * 0.35 * Math.exp(-t / dur);
  }
  return b;
}
function synth(freq, dur, { type = 'saw', attack = 0.01, release = 0.1, cutoff = 2000, vib = 0, detune = 0, decay = 0 } = {}) {
  const n = Math.round((dur + release) * SR);
  const b = new Float32Array(n);
  const voices = detune ? [-detune, 0, detune] : [0];
  const phs = voices.map(() => rnd());
  let lp = 0;
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    voices.forEach((d, k) => {
      const f = freq * Math.pow(2, d / 1200) * (1 + vib * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.3));
      phs[k] = (phs[k] + f / SR) % 1;
      const p = phs[k];
      s += type === 'saw' ? 2 * p - 1 : type === 'square' ? (p < 0.5 ? 1 : -1) : Math.sin(2 * Math.PI * p);
    });
    s /= voices.length;
    lp += a * (s - lp);
    let env = Math.min(1, t / attack);
    if (decay) env *= Math.exp(-t / decay);
    if (t > dur) env *= Math.max(0, 1 - (t - dur) / release);
    b[i] = lp * env;
  }
  return b;
}
function piano(midi, dur, vel = 1) {
  const f0 = mtof(midi);
  const n = Math.round((dur + 1.2) * SR);
  const b = new Float32Array(n);
  const B = 0.0004;
  const parts = [];
  for (let h = 1; h <= 10; h++) {
    const f = f0 * h * Math.sqrt(1 + B * h * h);
    if (f > 9000) break;
    parts.push({ f, a: vel / Math.pow(h, 1.1), d: 2.2 / (1 + 0.45 * h) * (f0 < 300 ? 1.4 : 1), ph: rnd() * 6.28 });
  }
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    for (const p of parts) s += p.a * Math.sin(p.ph + 2 * Math.PI * p.f * t) * Math.exp(-t / p.d);
    const rel = t > dur ? Math.exp(-(t - dur) / 0.25) : 1;
    const att = Math.min(1, t / 0.004);
    b[i] = s * rel * att * 0.25;
  }
  // hammer noise
  for (let i = 0; i < 300; i++) b[i] += noise() * 0.012 * vel * (1 - i / 300);
  return b;
}
function riser(dur) {
  const n = Math.round(dur * SR);
  const b = new Float32Array(n);
  let low = 0;
  let band = 0;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    const fc = 300 * Math.pow(30, p);
    const f = 2 * Math.sin((Math.PI * Math.min(fc, 12000)) / SR);
    const q = 0.3;
    const x = noise();
    low += f * band;
    const high = x - low - q * band;
    band += f * high;
    b[i] = band * (0.1 + 0.9 * p * p) * 0.5;
  }
  return b;
}

const CH = {
  Am: [57, 60, 64],
  F: [53, 57, 60],
  C: [48, 52, 55, 60],
  G: [55, 59, 62],
  Em: [52, 55, 59],
  Dm: [50, 53, 57],
};

// ---------------------------------------------------------------- EDM
function makeEdm() {
  const bpm = 128;
  const beat = 60 / bpm;
  const bar = 4 * beat;
  const plan = [
    ['intro', 8],
    ['verse', 16],
    ['build', 8],
    ['drop', 16],
    ['break', 8],
    ['build', 8],
    ['drop', 16],
    ['outro', 8],
  ];
  const totalBars = plan.reduce((s, p) => s + p[1], 0);
  const tr = new Track(totalBars * bar + 3);
  const K = kick();
  const S = snare();
  const H = hat(0.03);
  const prog = ['Am', 'F', 'C', 'G'];
  let b0 = 0;
  const truth = { beats: [], drops: [], builds: [] };
  for (const [name, bars] of plan) {
    for (let b = 0; b < bars; b++) {
      const t = (b0 + b) * bar;
      const chord = CH[prog[(b0 + b) % 4]];
      const fadeOut = name === 'outro' ? 1 - b / bars : 1;
      for (let q = 0; q < 4; q++) truth.beats.push(t + q * beat);
      if (name === 'intro' || name === 'break') {
        for (const m of chord) tr.add(t, synth(mtof(m + 12), bar * 0.98, { attack: 0.4, release: 0.5, cutoff: 900, detune: 12 }), 0.12);
        if (name === 'intro') for (let e = 0; e < 8; e++) if (e % 2) tr.add(t + e * beat * 0.5, H, 0.25 + 0.03 * b, 0.3);
        if (name === 'break') {
          const mel = [76, 74, 72, 71];
          tr.add(t, piano(mel[b % 4], bar * 0.9, 0.9), 0.8);
          tr.add(t + 2 * beat, piano(mel[(b + 1) % 4] - 3, bar * 0.4, 0.7), 0.7);
        }
      }
      if (name === 'verse' || name === 'drop' || name === 'outro') {
        const big = name === 'drop';
        for (let q = 0; q < 4; q++) tr.add(t + q * beat, K, (big ? 1.0 : 0.75) * fadeOut);
        if (name !== 'outro') {
          tr.add(t + beat, S, big ? 0.7 : 0.5, 0.1);
          tr.add(t + 3 * beat, S, big ? 0.7 : 0.5, 0.1);
        }
        for (let e = 0; e < (big ? 16 : 8); e++) {
          const step = big ? beat / 4 : beat / 2;
          tr.add(t + e * step, H, (big ? 0.5 : 0.35) * fadeOut * (e % 2 ? 0.7 : 1), -0.3);
        }
        // bass on offbeats
        for (let q = 0; q < 4; q++)
          tr.add(t + q * beat + beat / 2, synth(mtof(chord[0] - 24), beat * 0.45, { cutoff: big ? 900 : 400, release: 0.05 }), (big ? 0.55 : 0.35) * fadeOut);
        for (const m of chord) tr.add(t, synth(mtof(m + 12), bar * 0.98, { attack: 0.05, release: 0.3, cutoff: big ? 3000 : 1200, detune: 15 }), (big ? 0.1 : 0.07) * fadeOut);
        if (big) {
          const lead = [81, 79, 76, 79, 84, 83, 79, 76];
          for (let e = 0; e < 8; e++) tr.add(t + e * beat * 0.5, synth(mtof(lead[(e + b) % 8]), beat * 0.4, { type: 'square', cutoff: 5000, release: 0.05 }), 0.12, 0.2);
        }
      }
      if (name === 'build') {
        // snare roll accelerating: quarters -> 8ths -> 16ths -> 32nds, gap in the final half bar
        const stage = b < 2 ? 1 : b < 4 ? 2 : b < 6 ? 4 : 8;
        const steps = 4 * stage;
        for (let e = 0; e < steps; e++) {
          const tt = t + (e * bar) / steps;
          if (b === bars - 1 && tt >= t + bar / 2) break;
          tr.add(tt, S, 0.25 + 0.5 * (b / bars), 0);
        }
        for (const m of chord) tr.add(t, synth(mtof(m + 12 + (b >= 4 ? 2 : 0)), bar * (b === bars - 1 ? 0.5 : 0.98), { attack: 0.05, cutoff: 600 + 400 * b, detune: 20 }), 0.05 + 0.012 * b);
      }
    }
    if (name === 'build') {
      tr.add(b0 * bar, riser(bars * bar - bar / 2), 0.8);
      truth.builds.push(b0 * bar);
    }
    if (name === 'drop') truth.drops.push(b0 * bar);
    b0 += bars;
  }
  tr.normalize();
  return { tr, truth };
}

// ---------------------------------------------------------------- piano
function makePiano() {
  const beatBase = 60 / 66;
  const prog = ['Am', 'F', 'C', 'G', 'Am', 'Dm', 'Em', 'Am', 'F', 'G', 'C', 'Am', 'Dm', 'G', 'C', 'C', 'Am', 'F', 'Dm', 'Em', 'Am', 'F', 'G', 'Am'];
  const mel = [76, 77, 79, 74, 76, 74, 71, 72, 77, 79, 84, 81, 77, 79, 76, 72, 76, 77, 74, 71, 72, 72, 74, 69];
  let t = 1.0;
  const tr = new Track(150);
  const onsets = [];
  prog.forEach((cn, bi) => {
    // rubato: slower at phrase ends
    const phrasePos = bi % 4;
    const rub = 1 + 0.08 * Math.sin(bi * 0.9) + (phrasePos === 3 ? 0.12 : 0);
    const beat = beatBase * rub;
    // dynamics: crescendo into the middle section, soft ending
    const dyn = bi < 8 ? 0.45 + bi * 0.03 : bi < 16 ? 0.75 + 0.15 * Math.sin(((bi - 8) / 8) * Math.PI) : 0.7 - (bi - 16) * 0.06;
    const chord = CH[cn];
    // arpeggio in 8ths across 4 beats
    const arp = [chord[0] - 12, chord[1], chord[2], chord[1] + 12, chord[2], chord[1], chord[0], chord[2]];
    arp.forEach((m, k) => {
      const tt = t + (k * beat) / 2;
      tr.add(tt, piano(m, beat * 1.2, dyn * 0.6), 0.9, -0.2);
      onsets.push(tt);
    });
    tr.add(t, piano(chord[0] - 24, beat * 3.5, dyn * 0.8), 0.9, -0.3);
    // melody: half notes
    tr.add(t, piano(mel[bi], beat * 1.9, dyn), 1.1, 0.25);
    tr.add(t + 2 * beat, piano(mel[bi] + (bi % 2 ? -2 : 2), beat * 1.8, dyn * 0.85), 1.0, 0.25);
    t += 4 * beat;
  });
  tr.n = Math.min(tr.n, Math.ceil((t + 4) * SR));
  tr.L = tr.L.subarray(0, tr.n);
  tr.R = tr.R.subarray(0, tr.n);
  tr.normalize(0.6);
  return { tr, truth: { onsets } };
}

// ---------------------------------------------------------------- pop
function makePop() {
  const bpm = 100;
  const beat = 60 / bpm;
  const bar = 4 * beat;
  const plan = [
    ['intro', 4],
    ['verse', 8],
    ['pre', 4],
    ['chorus', 8],
    ['verse', 8],
    ['pre', 4],
    ['chorus', 8],
    ['bridge', 4],
    ['chorus', 8],
    ['outro', 4],
  ];
  const total = plan.reduce((s, p) => s + p[1], 0);
  const tr = new Track(total * bar + 3);
  const K = kick(0.35);
  const S = snare(0.22, 210);
  const H = hat(0.025);
  const verseProg = ['C', 'G', 'Am', 'F'];
  const chorusProg = ['F', 'C', 'G', 'Am'];
  const verseMel = [64, 67, 69, 67, 64, 62, 60, 62];
  const chorusMel = [72, 71, 69, 67, 69, 71, 72, 76];
  let b0 = 0;
  for (const [name, bars] of plan) {
    for (let b = 0; b < bars; b++) {
      const t = (b0 + b) * bar;
      const isCh = name === 'chorus';
      const prog = isCh ? chorusProg : verseProg;
      const chord = CH[prog[b % 4]];
      const fade = name === 'outro' ? 1 - b / bars : 1;
      // chords (guitar-ish plucks on 8ths)
      for (let e = 0; e < 8; e++) {
        const tt = t + (e * beat) / 2;
        for (const m of chord) tr.add(tt, synth(mtof(m + 12), beat * 0.35, { cutoff: isCh ? 3500 : 1800, decay: 0.2, release: 0.05 }), (isCh ? 0.06 : 0.045) * fade, 0.35);
      }
      if (name !== 'intro' && name !== 'bridge') {
        const kicks = isCh ? [0, 1, 2, 3] : [0, 2.5];
        for (const k of kicks) tr.add(t + k * beat, K, 0.8 * fade);
        tr.add(t + beat, S, (isCh ? 0.6 : 0.45) * fade);
        tr.add(t + 3 * beat, S, (isCh ? 0.6 : 0.45) * fade);
        const hs = isCh ? 16 : 8;
        for (let e = 0; e < hs; e++) tr.add(t + (e * bar) / hs, H, (isCh ? 0.4 : 0.3) * fade * (e % 2 ? 0.6 : 1), -0.35);
        if (name === 'pre' && b === bars - 1) for (let e = 0; e < 8; e++) tr.add(t + 2 * beat + (e * beat) / 4, S, 0.3 + e * 0.05);
      } else if (name === 'bridge') {
        tr.add(t, K, 0.4);
      } else {
        for (let e = 0; e < 4; e++) tr.add(t + e * beat, H, 0.2, -0.35);
      }
      // bass
      tr.add(t, synth(mtof(chord[0] - 24), beat * 1.8, { cutoff: 500, release: 0.1 }), 0.45 * fade);
      tr.add(t + 2 * beat, synth(mtof(chord[0] - 24), beat * 1.8, { cutoff: 500, release: 0.1 }), 0.45 * fade);
      // lead "vocal"
      if (name === 'verse' || isCh || name === 'pre') {
        const mel = isCh ? chorusMel : verseMel;
        const shift = name === 'pre' ? 2 : 0;
        for (let e = 0; e < 2; e++) {
          const m = mel[(b * 2 + e) % 8] + shift;
          tr.add(t + e * 2 * beat, synth(mtof(m), beat * 1.8, { type: 'saw', attack: 0.04, cutoff: 2500, vib: 0.006, release: 0.1 }), isCh ? 0.16 : 0.12, 0);
        }
      }
      if (name === 'bridge') {
        for (const m of chord) tr.add(t, synth(mtof(m + 12), bar * 0.95, { attack: 0.3, release: 0.4, cutoff: 1000, detune: 10 }), 0.1);
        tr.add(t, synth(mtof(72 - b), bar * 0.9, { type: 'saw', attack: 0.1, cutoff: 2000, vib: 0.008 }), 0.12);
      }
    }
    b0 += bars;
  }
  tr.normalize();
  return { tr };
}

const edm = makeEdm();
edm.tr.write(join(outDir, 'edm.wav'));
writeFileSync(join(outDir, 'edm.truth.json'), JSON.stringify(edm.truth));
const pn = makePiano();
pn.tr.write(join(outDir, 'piano.wav'));
writeFileSync(join(outDir, 'piano.truth.json'), JSON.stringify(pn.truth));
makePop().tr.write(join(outDir, 'pop.wav'));
