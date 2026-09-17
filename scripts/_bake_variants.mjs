import { chromium } from 'playwright';
import { mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { bootOrFail } from './_harness.mjs';

const port = process.env.PORT ?? '5188';
const scene = process.env.SCENE ?? 'lod-scale';
const cam = process.env.CAM ?? 'overview';
const out = process.env.OUT ?? 'shots/bake-variants';
const variants = JSON.parse(process.env.VARIANTS ?? '[["default",""]]');
const bakes = process.env.BAKES ?? 'public/bakes';
const timer = setTimeout(() => { console.error('gate'); process.exit(2); }, Number(process.env.GATE_MS ?? 900000));
mkdirSync(out, { recursive: true });
const newest = () => readdirSync(bakes).map((name) => ({ name, time: statSync(`${bakes}/${name}`).mtimeMs })).sort((a, b) => b.time - a.time);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (error) => { console.error('pageerror:', String(error).slice(0, 300)); process.exit(3); });
page.on('console', (message) => { const text = message.text(); if (/integrations|page\(s\)|Error|exhausted/.test(text)) console.log('  ', text.slice(0, 200)); });
const frames = (count) => page.evaluate((n) => new Promise((resolve) => { let i = 0; const tick = () => (++i > n ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }), count);
for (const [name, extra] of variants) {
  const before = new Set(readdirSync(bakes));
  const runStart = Date.now();
  await page.goto(`http://127.0.0.1:${port}/?scene=${scene}&cam=${cam}&grain=0&aa=none&hud=0${extra}`);
  const bootStarted = Date.now();
  await bootOrFail(page, Number(process.env.GATE_MS ?? 900000) - 60000);
  console.log(name, `booted in ${((Date.now() - bootStarted) / 1000).toFixed(1)} s`);
  if (process.env.POSE) await page.evaluate((pose) => window.__camera(...pose), JSON.parse(process.env.POSE));
  await frames(300);
  await page.screenshot({ path: `${out}/${name}.png` });
  await page.evaluate(() => window.__bakedOnly?.(true));
  await frames(90);
  await page.screenshot({ path: `${out}/${name}-baked.png` });
  console.log(name, 'captured');
  for (const file of newest()) if ((!before.has(file.name) || file.time >= runStart) && /\.(bin|json)$/.test(file.name)) rmSync(`${bakes}/${file.name}`);
}
clearTimeout(timer);
await browser.close();
