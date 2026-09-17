import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { bootOrFail } from './_harness.mjs';

const port = process.env.PORT ?? '5188';
const scene = process.env.SCENE ?? 'lod-scale';
const cams = (process.env.CAMS ?? 'overview,eye,pergola').split(',');
const extra = process.env.EXTRA ?? '&grain=0&aa=none&hud=0';
const out = process.env.OUT ?? `shots/${scene}`;
const baked = process.env.BAKED !== '0';
const timer = setTimeout(() => { console.error('gate'); process.exit(2); }, 420000);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (error) => { console.error('pageerror:', String(error).slice(0, 300)); process.exit(3); });
page.on('console', (message) => { const text = message.text(); if (/\[lod\]|\[lightmap\] \d+ meshes|refused|exhausted/.test(text)) console.log('  console:', text.slice(0, 260)); });
const frames = (count) => page.evaluate((n) => new Promise((resolve) => { let i = 0; const tick = () => (++i > n ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }), count);
for (const cam of cams) {
  await page.goto(`http://127.0.0.1:${port}/?scene=${scene}&cam=${cam}${extra}`);
  await bootOrFail(page, 300000);
  await frames(300);
  await page.screenshot({ path: `${out}/${cam}.png` });
  if (baked) {
    await page.evaluate(() => window.__bakedOnly?.(true));
    await frames(90);
    await page.screenshot({ path: `${out}/${cam}-baked.png` });
  }
  console.log(cam, JSON.stringify(await page.evaluate(() => { const r = window.__lod?.(); return r && { tiles: r.tiles, resident: r.resident, asked: r.asked, tailLevels: r.tailLevels, levels: r.levels }; })));
}
clearTimeout(timer);
await browser.close();
