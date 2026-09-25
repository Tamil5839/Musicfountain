// Headless browser run: loads a song once, screenshots several moments with the UI hidden.
// Usage: node tools/browser-test.mjs <wav> <prefix> <quality> <w>x<h> t1 t2 ...
import { createRequire } from 'node:module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const [, , wav, prefix, quality = 'Medium', size = '960x540', ...times] = process.argv;
const [W, H] = size.split('x').map(Number);
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(1000);
await page.evaluate((q) => { const f = window.fountain; f.settings.quality = q; f.stage.setQuality(q); f.ui.toggleHidden(); }, quality);
const t0 = Date.now();
await page.setInputFiles('#file', wav);
await page.waitForSelector('#player:not(.hidden)', { timeout: 180000 });
console.log('loaded in', Date.now() - t0, 'ms');
await page.evaluate(() => window.fountain.player.pause());
for (const tStr of times) {
  const t = Number(tStr);
  await page.evaluate((t) => { window.fountain.player.seek(t); window.fountain.markDirty(); }, t);
  await page.waitForFunction((t) => Math.abs(window.fountain.stage.simTime - t) < 0.02, t, { timeout: 300000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `/tmp/claude-0/shots/${prefix}-${tStr}.png`, timeout: 300000 });
  console.log('shot', t);
}
if (logs.length) console.log(logs.slice(0, 20).join('\n'));
await browser.close();
