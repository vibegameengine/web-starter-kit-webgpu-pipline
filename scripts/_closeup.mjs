// Deterministic close-up: places the camera exactly via window.__camera, waits for
// the probes to re-accumulate after the cut, then captures.
// Usage: node scripts/_closeup.mjs <out.png> "<url>" [warmupMs] [px py pz tx ty tz]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const out = resolve(process.argv[2]);
const url = process.argv[3];
const warmup = Number(process.argv[4] ?? 18000);
// Default pose looks straight down the red wall's base: the wall's inner face sits
// at x = -4.04 and the floor's at y = -0.5, so this frames the junction itself.
const pose = process.argv.slice(5).map(Number);
const [px, py, pz, tx, ty, tz] =
  pose.length === 6 ? pose : [-0.9, 0.75, 2.6, -3.7, -0.4, -0.2];

mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--use-angle=d3d11',
    '--enable-webgpu-developer-features',
    '--no-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(warmup);

const placed = await page.evaluate(
  (p) => (window.__camera ? window.__camera(...p) : false),
  [px, py, pz, tx, ty, tz],
);
if (!placed) console.log('! window.__camera missing — framing is whatever the app chose');

// A cut invalidates almost all probe history, so an immediate grab measures the
// refill rather than the converged answer.
await page.waitForTimeout(8000);
await page.screenshot({ path: out });
console.log(`saved ${out}${errors.length ? ` errors=${JSON.stringify(errors)}` : ''}`);
await browser.close();
