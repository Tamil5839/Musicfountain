import { createRequire } from 'node:module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(1500);
await page.evaluate(() => { const f = window.fountain; f.stage.mist.enabled = false; document.getElementById('ui').style.display='none'; });
await page.waitForTimeout(6000);
const mode = process.argv[2] || 'doubleside';
await page.evaluate((mode) => {
  const m = window.fountain.stage.particles.mesh;
  const THREE_side = 2; // DoubleSide
  if (mode === 'doubleside') { m.material.side = THREE_side; m.material.uniforms.uBright.value = 5; m.material.needsUpdate = true; }
  if (mode === 'dots') {
    m.material.vertexShader = m.material.vertexShader.replace('if (state < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }', 'if (state < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } vColor = vec3(1.0,0.0,0.0); gl_Position = projectionMatrix * viewMatrix * vec4(P.xyz + position * 0.5, 1.0); return;');
    m.material.side = 2; m.material.needsUpdate = true;
  }
}, mode);
await page.waitForTimeout(2500);
await page.screenshot({ path: `/tmp/claude-0/shots/rd2-${mode}.png` });
console.log(logs.filter(l => !l.includes('vite')).join('\n'));
await browser.close();
