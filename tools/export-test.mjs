// End-to-end export test: loads a song, exports a clip, saves the MP4.
// Usage: node tools/export-test.mjs <wav> <out.mp4> <presetIndex> <fps> <start> <end> [quality]
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const [, , wav, out, presetIdx = '0', fps = '30', start = '0', end = '3', quality = 'Low'] = process.argv;
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const logs = [];
page.on('console', (m) => { if (m.type() !== 'debug') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(800);
await page.evaluate((q) => { const f = window.fountain; f.settings.quality = q; f.stage.setQuality(q); }, quality);
await page.setInputFiles('#file', wav);
await page.waitForSelector('#player:not(.hidden)', { timeout: 180000 });
await page.evaluate(({ presetIdx, fps, start, end }) => {
  const f = window.fountain;
  f.player.pause();
  const presets = ['1920×1080 (16:9)', '1080×1920 (9:16)', '1080×1080 (1:1)'];
  f.settings.exportPreset = presets[Number(presetIdx)];
  f.settings.exportFps = Number(fps);
  f.settings.clip = true;
  f.settings.clipStart = Number(start);
  f.settings.clipEnd = Number(end);
  f.onExport();
}, { presetIdx, fps, start, end });
const t0 = Date.now();
let last = '';
while (true) {
  const st = await page.evaluate(() => document.querySelector('#export-modal .stage')?.textContent || '');
  if (st !== last) { console.log(((Date.now() - t0) / 1000).toFixed(0) + 's', st); last = st; }
  if (st.startsWith('Done') || st.startsWith('Export failed') || st.startsWith('Export cancelled')) break;
  await page.waitForTimeout(3000);
}
const res = await page.evaluate(async () => {
  const a = document.querySelector('#export-modal .result a');
  const notes = [...document.querySelectorAll('#export-modal .note')].map((n) => n.textContent);
  if (!a) return { notes };
  const blob = await (await fetch(a.href)).blob();
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { b64: btoa(bin), name: a.download, notes };
});
if (res.b64) { writeFileSync(out, Buffer.from(res.b64, 'base64')); console.log('saved', out, res.name); }
console.log('notes:', res.notes);
console.log(logs.slice(0, 30).join('\n'));
await browser.close();
