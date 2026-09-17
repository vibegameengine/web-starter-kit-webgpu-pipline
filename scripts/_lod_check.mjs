import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { bootOrFail } from './_harness.mjs';

const port = process.env.PORT ?? '5188';
const query = process.env.QUERY ?? 'scene=village-light&iters=32&rays=8&probes=0&grain=0&aa=none';
const out = process.env.OUT ?? 'shots/lod';
const gate = Number(process.env.GATE_MS ?? 180000);
const timer = setTimeout(() => { console.error('gate'); process.exit(2); }, gate);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (error) => { console.error('pageerror:', String(error).slice(0, 300)); process.exit(3); });
page.on('console', (message) => {
  const text = message.text();
  if (/\[lod|\[lightmap\] applied|error|Error/.test(text)) console.log('  console:', text.slice(0, 240));
});
for (const [name, extra] of (process.env.VARIANTS ? JSON.parse(process.env.VARIANTS) : [['lod', ''], ['atlas', '&lod=0'], ['lab', '&lodLab=1']])) {
  await page.goto(`http://127.0.0.1:${port}/?${query}${extra}&hud=0`);
  await bootOrFail(page, gate - 30000);
  await page.waitForFunction(() => { const frames = (window.__settleFrames = (window.__settleFrames ?? 0) + 1); return frames > 1; }, null, { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => new Promise((resolve) => { let n = 0; const tick = () => (++n > 400 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }));
  const report = await page.evaluate(() => (window.__lod ? window.__lod() : null));
  console.log(name, JSON.stringify(report, (key, value) => (key === "feedbackLevels" ? Object.fromEntries(Object.entries(value).filter(([level]) => Number(level) < 16)) : value)));
  await page.screenshot({ path: `${out}/${name}.png` });
  await page.evaluate(() => window.__bakedOnly?.(true));
  await page.evaluate(() => new Promise((resolve) => { let n = 0; const tick = () => (++n > 120 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }));
  await page.screenshot({ path: `${out}/${name}-baked.png` });
}
clearTimeout(timer);
await browser.close();
