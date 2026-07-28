// Side-by-side + pixel diff of two running builds.
//
//   node scripts/compare.mjs --a http://127.0.0.1:5188/?hud=0 \
//                            --b http://127.0.0.1:5189/?scene=cornell-box \
//                            --out shots/compare
//
// Produces <out>-a.png, <out>-b.png, <out>-diff.png and <out>-side.png, and prints
// mean / max per-channel error plus the fraction of pixels over a tolerance. The
// point is to make "it doesn't match" a number instead of an argument.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PNG } from 'pngjs';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const urlA = flag('a', 'http://127.0.0.1:5188/?hud=0');
const urlB = flag('b', 'http://127.0.0.1:5189/?scene=cornell-box');
const out = resolve(flag('out', 'shots/compare'));
const width = Number(flag('w', '1280'));
const height = Number(flag('h', '800'));
const wait = Number(flag('wait', '20000'));
// Per-side overrides let one build be diffed against itself at two points in time,
// which is how cache decay gets measured rather than assumed.
const waitA = Number(flag('waitA', String(wait)));
const waitB = Number(flag('waitB', String(wait)));
const tolerance = Number(flag('tol', '8'));
// Seconds fed to window.__freeze on both pages; `--freeze off` disables pinning.
const freezeRaw = flag('freeze', '3.0');
const freezeAt = freezeRaw === 'off' ? null : Number(freezeRaw);
const settle = Number(flag('settle', '6000'));

mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer,WebGPUService',
    '--ignore-gpu-blocklist',
    '--use-angle=d3d11',
    '--enable-webgpu-developer-features',
    '--no-sandbox',
  ],
});

async function grab(url, label, holdMs) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(holdMs);

  // Pin the mover to the same pose in both builds, then let the GI re-converge
  // around it, so the diff measures the renderer and not two animation clocks.
  if (freezeAt !== null) {
    const ok = await page.evaluate(
      (t) => (window.__freeze ? window.__freeze(t) : false),
      freezeAt,
    );
    if (!ok) console.log(`  ! ${label}: no window.__freeze hook`);
    await page.waitForTimeout(settle);
  }

  // Hide every overlay both apps might draw, so only the canvas is compared.
  await page
    .addStyleTag({
      content:
        '#hud,.lil-gui,#stats,#profiler-toggle,.profiler-mini-panel,.profiler-panel,#scene-switcher,#loading-overlay{display:none !important}',
    })
    .catch(() => {});
  await page.waitForTimeout(500);

  const buffer = await page.screenshot({ type: 'png' });
  await page.close();

  console.log(`  ${label}: ${url}${errors.length ? `  (${errors.length} console errors)` : ''}`);
  errors.slice(0, 3).forEach((e) => console.log(`    ! ${e.slice(0, 140)}`));
  return buffer;
}

console.log('capturing…');
const [bufA, bufB] = [await grab(urlA, 'A', waitA), await grab(urlB, 'B', waitB)];
await browser.close();

writeFileSync(`${out}-a.png`, bufA);
writeFileSync(`${out}-b.png`, bufB);

const a = PNG.sync.read(bufA);
const b = PNG.sync.read(bufB);

if (a.width !== b.width || a.height !== b.height) {
  console.error(`✗ size mismatch: A ${a.width}x${a.height}, B ${b.width}x${b.height}`);
  process.exit(2);
}

const diff = new PNG({ width: a.width, height: a.height });
const side = new PNG({ width: a.width * 2, height: a.height });

let sum = 0;
let max = 0;
let over = 0;
const total = a.width * a.height;

for (let y = 0; y < a.height; y++) {
  for (let x = 0; x < a.width; x++) {
    const i = (y * a.width + x) * 4;

    const dr = Math.abs(a.data[i] - b.data[i]);
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
    const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
    const d = (dr + dg + db) / 3;

    sum += d;
    if (d > max) max = d;
    if (d > tolerance) over++;

    // Amplified so small but structured differences are actually visible.
    const shown = Math.min(255, d * 6);
    diff.data[i] = shown;
    diff.data[i + 1] = shown * 0.4;
    diff.data[i + 2] = shown * 0.15;
    diff.data[i + 3] = 255;

    const li = (y * side.width + x) * 4;
    const ri = (y * side.width + x + a.width) * 4;
    for (let c = 0; c < 4; c++) {
      side.data[li + c] = a.data[i + c];
      side.data[ri + c] = b.data[i + c];
    }
  }
}

writeFileSync(`${out}-diff.png`, PNG.sync.write(diff));
writeFileSync(`${out}-side.png`, PNG.sync.write(side));

const mean = sum / total;
const pct = (over / total) * 100;

console.log('');
console.log(`  mean abs error : ${mean.toFixed(2)} / 255`);
console.log(`  max  abs error : ${max.toFixed(0)} / 255`);
console.log(`  pixels > ${tolerance}     : ${pct.toFixed(2)}%`);
console.log('');
console.log(`  ${out}-side.png  (A | B)`);
console.log(`  ${out}-diff.png  (amplified ×6)`);
