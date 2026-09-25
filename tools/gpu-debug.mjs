import { createRequire } from 'node:module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(3000);
const r = await page.evaluate(() => {
  const st = window.fountain.stage;
  const ps = st.particles;
  const read = (v) => {
    const rt = ps.gpu.getCurrentRenderTarget(v);
    const buf = new Float32Array(ps.width * ps.height * 4);
    st.renderer.readRenderTargetPixels(rt, 0, 0, ps.width, ps.height, buf);
    return buf;
  };
  const V = read(ps.velVar);
  const P = read(ps.posVar);
  let alive = 0, splash = 0, maxY = 0, sample = [];
  for (let i = 0; i < ps.width * ps.height; i++) {
    const s = V[i * 4 + 3];
    if (s > 0.5) { alive++; if (s > 1.5) splash++; maxY = Math.max(maxY, P[i * 4 + 1]); if (sample.length < 3) sample.push([P[i*4],P[i*4+1],P[i*4+2],P[i*4+3],V[i*4],V[i*4+1],V[i*4+2],V[i*4+3]].map(x=>+x.toFixed(2))); }
  }
  const bank = st.bank;
  const emitRow = [];
  for (let j = 0; j < 5; j++) { const o = (3 * 128 + 31 + j) * 4; emitRow.push([bank.tex[o], bank.tex[o+1]]); }
  const dirB = []; for (let j = 0; j < 3; j++) { const o = (2 * 128 + 31 + j) * 4; dirB.push([bank.tex[o], bank.tex[o+1], bank.tex[o+2], bank.tex[o+3]].map(x=>+x.toFixed(2))); }
  return { alive, splash, maxY, sample, emitted: bank.emittedThisStep, emitRow, dirB, valve: Array.from(bank.valve.slice(31, 36)), vy: Array.from(bank.vy.slice(31,36)), simTime: st.simTime, pools: Array.from(bank.poolSize.slice(0, 40)) };
});
console.log(JSON.stringify(r, null, 1));
console.log(logs.join('\n'));
await browser.close();
