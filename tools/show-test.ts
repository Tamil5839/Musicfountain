// Prints the choreography plan for WAV files: npx tsx tools/show-test.ts tools/out/edm.wav
import { readWavMono22k } from './analyze-test';
import { analyzeSamples } from '../src/analysis/analyze';
import { choreograph } from '../src/choreographer';
import { Show, makeTargets } from '../src/show';
import { JETS } from '../src/fountain/layout';

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t - 60 * Math.floor(t / 60)).toFixed(1).padStart(4, '0')}`;
for (const path of process.argv.slice(2)) {
  const a = analyzeSamples(readWavMono22k(path), 22050, path);
  const d = choreograph(a);
  console.log(`\n=== ${path}: drive ${d.songDrive.toFixed(2)}  wake ${d.wake.start.toFixed(1)}-${d.wake.end.toFixed(1)}  cut ${d.finale.cut.toFixed(1)} lightsOut ${d.finale.lightsOut.toFixed(1)}`);
  for (const s of d.sections) {
    const evs = d.events.flat().filter((e) => e.peak >= s.start && e.peak < s.end);
    const byKind: Record<string, number> = {};
    for (const e of evs) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    const maxShooter = Math.max(0, ...evs.filter((e) => JETS[e.jet].family === 'shooter').map((e) => e.height));
    console.log(
      `${fmt(s.start)} ${s.label.padEnd(9)} ${s.tier.padEnd(7)} lvl ${s.level.toFixed(2)} pace ${s.pace.toFixed(2)} oars:${s.oars} fan:${s.fan} ring:${s.ring} sh:${s.shooters}/${s.shooterEvery} pal ${s.palette} ${s.colorMode} mist:${s.mist} laser:${s.laser} snare→${s.snareTarget} hats:${s.hats}`,
    );
    console.log(`      events ${JSON.stringify(byKind)} maxShooter ${maxShooter.toFixed(1)}m  snaps ${d.snaps.filter((x) => x.t >= s.start && x.t < s.end).length}`);
  }
  console.log('shots', d.shots.map((s) => `${fmt(s.start)}:${s.preset}`).join(' '));
  // evaluate targets over the song, measure avg flow & busy-ness
  const show = new Show(d, a);
  const tg = makeTargets();
  let maxH = 0;
  let maxT = 0;
  for (let t = 0; t < d.duration; t += 0.05) {
    show.evaluate(t, 1, tg);
    let sum = 0;
    for (let j = 0; j < JETS.length; j++) sum += tg.height[j] * tg.flow[j];
    if (sum > maxH) {
      maxH = sum;
      maxT = t;
    }
  }
  console.log(`biggest total water height at ${fmt(maxT)} (${maxH.toFixed(0)} m summed)`);
}
