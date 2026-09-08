// Contact occlusion check on the beach diorama.
//
//   node scripts/check-contact.mjs            # headed Chrome against http://127.0.0.1:5188
//
// One session at `?cam=rocks` (boulders on sand, a lagoon bed under the water),
// frozen mover and scene animation (`still=1`), TAA on. In order:
//   1. Boot with contact occlusion on (the default). Switch the split view to `contact` full frame
//      through the audit hook and capture the visibility buffer. Open sand must read
//      as fully visible (mean ≥ 0.9 after tone mapping's 0.94 for 1.0, std ≤ 0.03 — no
//      self-occlusion noise, the defect the full-detail contact BVH exists for), and the
//      sand along a boulder's foot must be darker than open sand.
//   2. Back to the beauty view: capture with occlusion on, then off through the same
//      hook. The difference must sit where the occlusion is (mean |on − off| along the
//      boulder foot several times that on open sand), and the backdrop must not change.
//   3. GPU ms on and off from the renderer's timestamp queries; no new console error
//      with the pass on.
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';

const out = 'shots/contact';
await mkdir(out, { recursive: true });
const url = `http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&still=1&gputime=1&cam=rocks${process.env.GI_QUERY ?? ''}`;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});
const errors = { on: new Set(), off: new Set() };
let phase = 'on';
const report = {};

const stats = (img, [x0, y0, w, h]) => {
  let s = 0, s2 = 0, n = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const p = (y * img.width + x) * 4;
    const v = img.data[p] / 255;
    s += v; s2 += v * v; n++;
  }
  const mean = s / n;
  return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
};
const meanDiff = (a, b, [x0, y0, w, h]) => {
  let sum = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const p = (y * a.width + x) * 4;
    for (let c = 0; c < 3; c++) sum += Math.abs(a.data[p + c] - b.data[p + c]);
  }
  return sum / (w * h * 3);
};
const shot = async (page, name) => {
  const path = `${out}/check-${name}.png`;
  await page.screenshot({ path });
  return PNG.sync.read(await readFile(path));
};
const gpuMs = async (page, frames = 30) => {
  const samples = [];
  for (let i = 0; i < frames; i++) {
    await page.waitForTimeout(40);
    samples.push(await page.evaluate(async () => { const t = await window.__gpuTime(); return (t.render ?? 0) + (t.compute ?? 0); }));
  }
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(samples.length / 2)], p95: samples[Math.floor(samples.length * 0.95)] };
};

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => errors[phase].add(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors[phase].add(m.text().slice(0, 200)); });
  await page.goto(url);
  await page.waitForFunction(() => window.__fog && window.__audit && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
  await page.waitForTimeout(2500);

  // Regions in this camera (see check-visibility.png): open lagoon bed, sand at the
  // foot of the right boulder, the backdrop strip at the top left.
  const openSand = [1250, 650, 300, 150];
  const boulderFoot = [1000, 420, 120, 60];
  const backdrop = [20, 20, 150, 80];

  assert.equal(await page.evaluate(() => window.__fog.contact()), true, 'contact occlusion must be on by default');

  // Beauty on, then off, then on again, each after two seconds of settling: the
  // comparison is off against the second on, so no view switch sits between them.
  await page.waitForTimeout(2000);
  await shot(page, 'on-first');
  report.gpuOn = await gpuMs(page);
  phase = 'off';
  await page.evaluate(() => window.__fog.contact(false));
  await page.waitForTimeout(2000);
  assert.equal(await page.evaluate(() => window.__fog.contact()), false);
  const off = await shot(page, 'off');
  report.gpuOff = await gpuMs(page);
  phase = 'on';
  await page.evaluate(() => window.__fog.contact(true));
  await page.waitForTimeout(2000);
  const on = await shot(page, 'on');
  report.onVsOff = { openSand: meanDiff(on, off, openSand), boulderFoot: meanDiff(on, off, boulderFoot), backdrop: meanDiff(on, off, backdrop) };

  // Cost at other grid scales is measured by separate boots (scripts/_contact_cost.mjs):
  // changing the grid at runtime is not supported.

  // Visibility buffer last, so its white frame never sits in the TAA history of a
  // beauty capture.
  await page.evaluate(() => window.__fog.split('contact', 0));
  await page.waitForTimeout(1500);
  const visibility = await shot(page, 'visibility');
  report.visibility = { openSand: stats(visibility, openSand), boulderFoot: stats(visibility, boulderFoot), backdrop: stats(visibility, backdrop) };
  // Where the pass says "occluded", the beauty must have darkened; where it says
  // "open", it must not have changed beyond TAA noise. Masks come from the visibility
  // capture itself (tone-mapped: 1.0 reads 0.94).
  const darkening = (lo, hi) => {
    let sum = 0, n = 0;
    for (let y = 0; y < on.height; y += 2) for (let x = 0; x < on.width; x += 2) {
      const p = (y * on.width + x) * 4;
      const v = visibility.data[p] / 255;
      if (v < lo || v > hi) continue;
      const lOn = 0.2126 * on.data[p] + 0.7152 * on.data[p + 1] + 0.0722 * on.data[p + 2];
      const lOff = 0.2126 * off.data[p] + 0.7152 * off.data[p + 1] + 0.0722 * off.data[p + 2];
      sum += lOff - lOn; n++;
    }
    return { mean: n ? sum / n : NaN, pixels: n };
  };
  report.darkening = { occluded: darkening(0, 0.7), open: darkening(0.92, 1) };

  const newErrors = [...errors.on].filter((e) => !errors.off.has(e));
  report.errors = { on: [...errors.on], off: [...errors.off] };
  await writeFile(`${out}/check.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  assert.deepEqual(newErrors, [], 'the pass must add no browser errors');
  const v = report.visibility;
  assert.ok(v.openSand.mean > 0.9 && v.openSand.std < 0.03, `open sand must be fully visible and clean: ${JSON.stringify(v.openSand)}`);
  assert.ok(v.boulderFoot.mean < v.openSand.mean - 0.03, `the boulder foot must be occluded: ${JSON.stringify(v)}`);
  assert.ok(report.darkening.occluded.pixels > 500, `too few occluded pixels to judge: ${JSON.stringify(report.darkening)}`);
  assert.ok(report.darkening.occluded.mean > 3 && report.darkening.occluded.mean > 4 * Math.abs(report.darkening.open.mean), `occluded pixels must darken, open ones not: ${JSON.stringify(report.darkening)}`);
  assert.ok(report.onVsOff.backdrop < 1, `the backdrop must not change: ${JSON.stringify(report.onVsOff)}`);
  assert.ok(Number.isFinite(report.gpuOn.median), 'gpu timestamps present');
  console.log('check-contact: PASS');
} catch (error) {
  console.error(error);
  console.error(JSON.stringify({ report, errors: { on: [...errors.on], off: [...errors.off] } }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
