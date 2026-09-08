// Traced-reflection check on the beach diorama (headed Chrome, always).
//
//   node scripts/check-reflections.mjs
//
// One session at `?cam=water` (the swash zone at a grazing angle: wet sand has
// roughness 0.30, the only glossy opaque surface here), frozen mover and scene
// animation, TAA on. In order:
//   1. Boot with reflections on. Switch the split view to `reflections` full frame and
//      capture the traced radiance. Some pixels must carry it (glossy surfaces exist),
//      and dry sand must carry none (roughness above the trace threshold).
//   2. Beauty on, then off through the audit hook, then on again after settling; where
//      radiance was traced the beauty must be brighter with the pass on than off, and
//      where none was traced it must not change beyond TAA noise.
//   3. No console error the pass adds; GPU ms on/off from per-frame timestamp resolves.
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';

const out = 'shots/reflections';
await mkdir(out, { recursive: true });
const url = `http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&still=1&gputime=1&cam=water${process.env.GI_QUERY ?? ''}`;
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const errors = { on: new Set(), off: new Set() };
let phase = 'on';
const report = {};
const luma = (img, p) => 0.2126 * img.data[p] + 0.7152 * img.data[p + 1] + 0.0722 * img.data[p + 2];
const shot = async (page, name) => {
  const path = `${out}/check-${name}.png`;
  await page.screenshot({ path });
  return PNG.sync.read(await readFile(path));
};
const gpuMs = async (page) => page.evaluate(async () => {
  const frames = [];
  for (let i = 0; i < 90; i++) { await new Promise((r) => requestAnimationFrame(r)); const t = await window.__gpuTime(); frames.push((t.render ?? 0) + (t.compute ?? 0)); }
  frames.sort((a, b) => a - b);
  return frames[45];
});

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => errors[phase].add(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors[phase].add(m.text().slice(0, 200)); });
  await page.goto(url);
  await page.waitForFunction(() => window.__fog && window.__audit && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
  await page.waitForTimeout(2500);
  assert.equal(await page.evaluate(() => window.__fog.reflections()), true, 'reflections must be on by default');

  await page.waitForTimeout(1500);
  await shot(page, 'on-first');
  report.gpuOn = await gpuMs(page);
  phase = 'off';
  await page.evaluate(() => window.__fog.reflections(false));
  await page.waitForTimeout(2000);
  const off = await shot(page, 'off');
  report.gpuOff = await gpuMs(page);
  phase = 'on';
  await page.evaluate(() => window.__fog.reflections(true));
  await page.waitForTimeout(2000);
  const on = await shot(page, 'on');

  await page.evaluate(() => window.__fog.split('reflections', 0));
  await page.waitForTimeout(1500);
  const traced = await shot(page, 'traced');

  let tracedPixels = 0, untracedPixels = 0, tracedDelta = 0, untracedDelta = 0, total = 0;
  for (let y = 0; y < on.height; y += 2) for (let x = 0; x < on.width; x += 2) {
    const p = (y * on.width + x) * 4;
    const t = luma(traced, p);
    const d = luma(on, p) - luma(off, p);
    total++;
    if (t > 12) { tracedPixels++; tracedDelta += d; } else if (t < 2) { untracedPixels++; untracedDelta += d; }
  }
  report.traced = { pixels: tracedPixels, fraction: tracedPixels / total, meanDelta: tracedDelta / Math.max(1, tracedPixels) };
  report.untraced = { pixels: untracedPixels, meanDelta: untracedDelta / Math.max(1, untracedPixels) };
  const newErrors = [...errors.on].filter((e) => !errors.off.has(e));
  report.errors = { on: [...errors.on], off: [...errors.off] };
  await writeFile(`${out}/check.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  assert.deepEqual(newErrors, [], 'the pass must add no browser errors');
  assert.ok(report.traced.fraction > 0.02, `some surface must reflect: ${JSON.stringify(report.traced)}`);
  assert.ok(report.traced.meanDelta > 0.5, `reflections must brighten traced pixels: ${JSON.stringify(report.traced)}`);
  assert.ok(Math.abs(report.untraced.meanDelta) < 0.5, `untraced pixels must not change: ${JSON.stringify(report.untraced)}`);
  assert.ok(Number.isFinite(report.gpuOn) && Number.isFinite(report.gpuOff), 'gpu timestamps present');
  console.log('check-reflections: PASS');
} catch (error) {
  console.error(error);
  console.error(JSON.stringify({ report, errors: { on: [...errors.on], off: [...errors.off] } }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
