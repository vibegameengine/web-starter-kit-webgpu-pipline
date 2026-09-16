import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';

const port = process.env.PORT ?? '5188';
const query = process.env.QUERY ?? 'scene=midsee-village&hud=1';
const timer = setTimeout(() => { console.error('gate'); process.exit(2); }, 300000);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (error) => { console.error('pageerror:', String(error).slice(0, 300)); process.exit(3); });
await page.goto(`http://127.0.0.1:${port}/?${query}`);
await bootOrFail(page, 240000);
await page.evaluate(() => new Promise((resolve) => { let n = 0; const tick = () => (++n > 600 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }));
const report = await page.evaluate(async () => {
  const lod = window.__lod?.();
  const intervals = []; let last = performance.now();
  await new Promise((resolve) => { const tick = () => { const now = performance.now(); intervals.push(now - last); last = now; if (intervals.length < 240) requestAnimationFrame(tick); else resolve(); }; requestAnimationFrame(tick); });
  intervals.sort((a, b) => a - b);
  let meshes = 0, instanced = 0, instances = 0, charted = 0, shadowCasters = 0;
  const scene = window.__audit?.scene?.() ?? null;
  return { lod: lod && { asked: lod.asked, resident: lod.resident, rootOnly: lod.rootOnly, mips: lod.mips }, median: intervals[120], p90: intervals[216], scene };
});
console.log(JSON.stringify(report));
await page.screenshot({ path: process.env.OUT ?? 'shots/lod/village-fps.png' });
clearTimeout(timer);
await browser.close();
