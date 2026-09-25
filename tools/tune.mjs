// Visual tuning harness: node tools/tune.mjs <wav> <quality> <time> <label> [js-to-eval-before-shot]
import { createRequire } from 'node:module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const [, , wav, quality, tStr, label, ...evals] = process.argv;
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(1000);
await page.evaluate((q) => { const f = window.fountain; f.settings.quality = q; f.stage.setQuality(q); f.ui.toggleHidden(); }, quality);
await page.setInputFiles('#file', wav);
await page.waitForSelector('#player:not(.hidden)', { timeout: 120000 });
await page.evaluate(() => window.fountain.player.pause());
const t = Number(tStr);
await page.evaluate((t) => window.fountain.player.seek(t), t);
await page.waitForFunction((t) => Math.abs(window.fountain.stage.simTime - t) < 0.05, t, { timeout: 180000 });
for (let i = 0; i < evals.length || i === 0; i++) {
  if (evals[i]) await page.evaluate(evals[i]);
  await page.evaluate(() => window.fountain.markDirty());
  await page.waitForTimeout(500);
  await page.screenshot({ path: `/tmp/claude-0/shots/${label}${evals.length > 1 ? '-' + i : ''}.png`, timeout: 180000 });
}
if (logs.length) console.log(logs.slice(0, 20).join('\n'));
await browser.close();
