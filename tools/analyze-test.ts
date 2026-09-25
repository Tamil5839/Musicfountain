// Runs the analysis on WAV files in Node and prints a summary.
// Usage: npx tsx tools/analyze-test.ts tools/out/edm.wav [...]

import { readFileSync, writeFileSync } from 'node:fs';
import { analyzeSamples } from '../src/analysis/analyze';

export function readWavMono22k(path: string): Float32Array {
  const buf = readFileSync(path);
  const ch = buf.readUInt16LE(22);
  const sr = buf.readUInt32LE(24);
  let off = 12;
  let dataOff = 0;
  let dataLen = 0;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      dataOff = off + 8;
      dataLen = len;
      break;
    }
    off += 8 + len;
  }
  const frames = dataLen / (2 * ch);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += buf.readInt16LE(dataOff + (i * ch + c) * 2) / 32768;
    mono[i] = s / ch;
  }
  if (sr === 22050) return mono;
  if (sr !== 44100) throw new Error('test harness expects 44.1k');
  const out = new Float32Array(Math.floor(frames / 2));
  for (let i = 0; i < out.length; i++) {
    const a = mono[2 * i - 1] ?? 0;
    const b = mono[2 * i];
    const c = mono[2 * i + 1] ?? 0;
    out[i] = (a + 2 * b + c) / 4;
  }
  return out;
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t - 60 * Math.floor(t / 60)).toFixed(2).padStart(5, "0")}`;

if (process.argv[1]?.endsWith('analyze-test.ts')) {
  for (const path of process.argv.slice(2)) {
    const x = readWavMono22k(path);
    const t0 = performance.now();
    const a = analyzeSamples(x, 22050, 'test');
    const ms = performance.now() - t0;
    console.log(`\n=== ${path}  (${a.duration.toFixed(1)}s, analysis ${ms.toFixed(0)} ms)`);
    console.log(
      `bpm ${a.bpm.toFixed(2)}  conf ${a.beatConfidence.toFixed(2)}  beats ${a.beats.length}  bars ${a.downbeats.length} (${a.beatsPerBar}/4)`,
    );
    console.log(`first beats: ${a.beats.slice(0, 6).map((b) => b.toFixed(3)).join(' ')}`);
    console.log(`first downbeats: ${a.downbeats.slice(0, 5).map((b) => b.toFixed(3)).join(' ')}`);
    console.log(`onsets: kick ${a.onsets.kick.length}, snare ${a.onsets.snare.length}, hat ${a.onsets.hat.length}`);
    console.log(`first kicks: ${a.onsets.kick.slice(0, 6).map((o) => o.t.toFixed(3)).join(' ')}`);
    console.log(`sound ${a.firstSound.toFixed(2)}..${a.lastSound.toFixed(2)}  peakDb ${a.peakDb.toFixed(1)}  fadeOut ${a.fadeOut ? fmt(a.fadeOut.start) + '-' + fmt(a.fadeOut.end) : 'none'}`);
    console.log(`silences: ${a.silences.map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`).join(', ')}`);
    console.log(`buildups: ${a.buildups.map((b) => `${fmt(b.start)}→drop ${fmt(b.drop)} (${b.strength.toFixed(2)})`).join(', ') || 'none'}`);
    for (const s of a.sections)
      console.log(
        `  ${fmt(s.start)}-${fmt(s.end)}  ${s.label.padEnd(9)} energy ${s.energy.toFixed(2)} intensity ${s.intensity.toFixed(2)} slope ${s.slope.toFixed(3)} rep ${s.repeatOf}`,
      );
    const voiced = Array.from(a.pitch).filter((p) => p >= 0).length / a.pitch.length;
    console.log(`melody voiced ${(voiced * 100).toFixed(0)}%`);
    if (process.env.DUMP) writeFileSync(path + '.analysis.json', JSON.stringify(a, (_k, v) => (v instanceof Float32Array ? Array.from(v) : v)));
  }
}
