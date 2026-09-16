import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const port = process.env.PORT ?? '5188';
const query = process.env.QUERY ?? 'scene=midsee-village';
const out = process.env.OUT ?? 'shots/startup/atlas.png';
const gain = Number(process.env.GAIN ?? 8);
const gate = Number(process.env.GATE_MS ?? 280000);
const timer = setTimeout(() => { console.error('gate'); process.exit(2); }, gate);

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (error) => console.error('pageerror:', String(error).slice(0, 200)));
await page.goto(`http://127.0.0.1:${port}/?${query}`);
await page.waitForFunction(() => document.querySelector('#loading-overlay')?.hidden || !document.querySelector('#error-overlay')?.hidden, null, { timeout: gate - 30000 }).catch(() => {});
await page.waitForTimeout(2000);

const dump = await page.evaluate(() => (window.__atlasDump ? window.__atlasDump() : null));
if (!dump) { console.error('no atlas'); process.exit(3); }

const { width, height, data } = dump;
const png = new PNG({ width, height });
let lit = 0;
let covered = 0;
for (let i = 0; i < width * height; i++) {
  const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
  const encode = (v) => Math.max(0, Math.min(255, Math.round(255 * Math.pow(Math.max(0, v) * gain, 1 / 2.2))));
  if (a > 0.25) { covered++; if ((r + g + b) / 3 > 0.002) lit++; }
  png.data[i * 4] = encode(r);
  png.data[i * 4 + 1] = encode(g);
  png.data[i * 4 + 2] = encode(b);
  png.data[i * 4 + 3] = 255;
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, PNG.sync.write(png));
console.log(`${width}x${height}, covered ${covered}, lit ${lit} (${((lit / Math.max(covered, 1)) * 100).toFixed(1)}% of covered), gain ${gain} -> ${out}`);
clearTimeout(timer);
await browser.close();
