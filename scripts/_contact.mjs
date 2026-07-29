// Deterministic contact close-up.
//
// `_closeup.mjs` waits a fixed number of milliseconds before it reaches for
// `window.__camera`, and the surfel warm-up no longer reliably finishes inside that
// window — two of three runs screenshotted the loading overlay instead of the scene,
// and one of them placed the camera before the hook existed. Waiting on the overlay
// rather than on a stopwatch is the only version of this that is reproducible.
//
// The camera placement itself is unchanged: the same `window.__camera` call with the
// same pose. Synthetic mouse drags land a different distance every run and were
// abandoned for exactly that reason.
//
// Usage: node scripts/_contact.mjs <out.png> "<url>" [settleMs] [px py pz tx ty tz]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const out = resolve(process.argv[2]);
const url = process.argv[3];
const settle = Number(process.argv[4] ?? 9000);
const pose = process.argv.slice(5).map(Number);
// Straight down the red wall's base: the wall's inner face is at x = -4.0 and the
// floor's top at y = -0.5, so this frames the junction itself.
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
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 300));
});
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

const overlayHidden = () =>
  page.evaluate(() => {
    const o = document.querySelector('#loading-overlay');
    return !!o && (o.hidden || o.classList.contains('hidden'));
  });

// The bake is a wall-clock budget spent on whole frames, so how long it takes is a
// property of the machine, not of the URL.
const waitForScene = () =>
  page
    .waitForFunction(
      () => {
        const o = document.querySelector('#loading-overlay');
        return !!o && (o.hidden || o.classList.contains('hidden'));
      },
      null,
      { timeout: 240000 },
    )
    .catch(() => console.log('! loading overlay never cleared'));

// Retried, because a second agent hot-reloads this dev server: a reload that lands
// during the settle puts the loading overlay back over the exact pixels being measured
// and produces a table of the overlay's background colour. Checking again after the
// settle is what turns that from a silently wrong number into a re-run.
let ok = false;
for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
  await waitForScene();
  const placed = await page.evaluate(
    (p) => (window.__camera ? window.__camera(...p) : false),
    [px, py, pz, tx, ty, tz],
  );
  if (!placed) {
    console.log(`! attempt ${attempt}: window.__camera missing, retrying`);
    await page.waitForTimeout(3000);
    continue;
  }
  // A cut invalidates almost all probe history, so an immediate grab measures the
  // refill rather than the converged answer.
  await page.waitForTimeout(settle);
  ok = await overlayHidden();
  if (!ok) console.log(`! attempt ${attempt}: page reloaded mid-settle, retrying`);
}

if (!ok) {
  console.log('! never got a clean settled frame — ABORTING rather than measuring chrome');
  await browser.close();
  process.exit(3);
}

await page.screenshot({ path: out });
console.log(`saved ${out}${errors.length ? ` errors=${JSON.stringify(errors)}` : ''}`);
await browser.close();
