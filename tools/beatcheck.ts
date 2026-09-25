import { readWavMono22k } from './analyze-test';
import { analyzeSamples } from '../src/analysis/analyze';
import { readFileSync } from 'node:fs';
const x = readWavMono22k('tools/out/edm.wav');
const a = analyzeSamples(x, 22050, 't');
const truth = JSON.parse(readFileSync('tools/out/edm.truth.json','utf8'));
const tb: number[] = truth.beats;
const segs = [[0,15],[15,45],[45,60],[60,90],[90,105],[105,120],[120,150],[150,165]];
for (const [s,e] of segs) {
  const bs = a.beats.filter(b=>b>=s&&b<e);
  const offs = bs.map(b=>{ let m=1e9; for(const t of tb){ if(Math.abs(b-t)<Math.abs(m)) m=b-t;} return m;});
  const mabs = offs.reduce((p,c)=>p+Math.abs(c),0)/offs.length;
  const dbs = a.downbeats.filter(b=>b>=s&&b<e).map(d=>(((d % 1.875)+1.875)%1.875).toFixed(2));
  console.log(s,e,'n',bs.length,'mabs',mabs.toFixed(3),'dbPhase',dbs.slice(0,5).join(','));
}
console.log('bpm', a.bpm.toFixed(2));
