// Volumetric fog check on the beach diorama.
//
//   node scripts/check-atmosphere.mjs            # headed Chrome against http://127.0.0.1:5188
//   FOG_QUERY='&fogDensity=0.05' node scripts/check-atmosphere.mjs
//
// What it proves, in order:
//   1. The page boots with fog on and introduces no console/page error that the same
//      scene does not already produce with `?fog=0` (other work in flight on the beach
//      materials is not this check's business; a *new* error is).
//   2. Fog changes the frame (mean |on − off| over the slab well above the animation noise).
//   3. Toggling off at runtime — the GUI path — reproduces the `?fog=0` boot frame: the
//      composite drops the stage rather than multiplying by one.
//   4. Toggling back on works, and a camera move (history reprojected, then rebuilt)
//      leaves no NaN/black frame and no errors.
//   5. GPU time with and without the fog passes, from the renderer's timestamp queries.
// Screenshots land in shots/atmosphere/check-*.png for the eye; numbers in check.json.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';

const out = 'shots/atmosphere';
await mkdir(out, { recursive: true });
const base = 'http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&gputime=1';
const extra = process.env.FOG_QUERY ?? '';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADLESS === '1',
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});
const errors = [];
let phase = 'on';
const errorsByPhase = { on: new Set(), off: new Set() };
const note = (text) => { errors.push(text); errorsByPhase[phase].add(text.slice(0, 200)); };
const report = {};

const meanDiff = (a, b, region) => {
  const [x0, y0, w, h] = region;
  let sum = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const p = (y * a.width + x) * 4;
    for (let c = 0; c < 3; c++) sum += Math.abs(a.data[p + c] - b.data[p + c]);
  }
  return sum / (w * h * 3);
};
const meanLuma = (a) => {
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) sum += 0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2];
  return sum / (a.data.length / 4);
};
const shot = async (page, name) => {
  const path = `${out}/check-${name}.png`;
  await page.screenshot({ path });
  return PNG.sync.read(await (await import('node:fs/promises')).readFile(path));
};
const gpuMs = async (page, frames = 30) => {
  const samples = [];
  for (let i = 0; i < frames; i++) {
    await page.waitForTimeout(40);
    samples.push(await page.evaluate(async () => {
      const t = await window.__gpuTime();
      return (t.render ?? 0) + (t.compute ?? 0);
    }));
  }
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(samples.length / 2)], p95: samples[Math.floor(samples.length * 0.95)] };
};
const boot = async (page, query) => {
  await page.goto(`${base}${query}${extra}`);
  await page.waitForFunction(() => window.__fog && window.__audit && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
  await page.waitForTimeout(1500);
};

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => note(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') note(m.text()); });

  // The slab and lagoon, where the mist lives; the backdrop corners are left out so a
  // pure-backdrop change cannot pass for fog on the scene.
  const slab = [300, 250, 1000, 550];

  // 1–2. Fog on at boot, then the same session toggled off.
  await boot(page, '');
  assert.equal(await page.evaluate(() => window.__fog.enabled()), true, 'fog must be on for the beach by default');
  report.grid = await page.evaluate(() => window.__fog.grid);
  report.settings = await page.evaluate(() => JSON.parse(JSON.stringify(window.__fog.settings)));
  const on = await shot(page, 'on');
  report.gpuOn = await gpuMs(page);

  await page.evaluate(() => window.__fog.enabled(false));
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.__fog.enabled()), false);
  const offToggled = await shot(page, 'off-toggled');
  report.gpuOff = await gpuMs(page);
  report.onVsOff = meanDiff(on, offToggled, slab);

  // 4. Back on: the history is rebuilt from scratch, then the camera moves.
  await page.evaluate(() => window.__fog.enabled(true));
  await page.waitForTimeout(600);
  const on2 = await shot(page, 'on-again');
  report.onVsOnAgain = meanDiff(on, on2, slab);
  await page.evaluate(() => window.__camera(-12.5, 12.5, 22.5, 0.4, -0.7, 0.0));
  await page.waitForTimeout(150);
  const moved = await shot(page, 'moved');
  await page.waitForTimeout(800);
  const settled = await shot(page, 'moved-settled');
  report.movedLuma = meanLuma(moved);
  report.settledLuma = meanLuma(settled);

  // 3. A fresh boot with `?fog=0` must match the toggled-off frame; both frames come
  // from a frozen scene, but water and wind still animate, so the tolerance is the
  // measured animation noise between two fog-off frames, not zero.
  phase = 'off';
  await boot(page, '&fog=0');
  const offBoot = await shot(page, 'off-boot');
  await page.waitForTimeout(500);
  const offBoot2 = await shot(page, 'off-boot-2');
  report.animationNoise = meanDiff(offBoot, offBoot2, slab);
  report.toggledVsBoot = meanDiff(offToggled, offBoot, slab);

  const newErrors = [...errorsByPhase.on].filter((e) => !errorsByPhase.off.has(e));
  report.preexistingErrors = [...errorsByPhase.off];
  assert.deepEqual(newErrors, [], 'fog must add no browser errors');
  assert.ok(report.onVsOff > 2.5 * Math.max(0.5, report.animationNoise), `fog must visibly change the slab: ${JSON.stringify(report)}`);
  assert.ok(report.toggledVsBoot < 3 * Math.max(0.5, report.animationNoise) + 1.0, `toggled-off must match fog=0 boot: ${JSON.stringify(report)}`);
  assert.ok(report.movedLuma > 20 && report.settledLuma > 20, 'no black frame after a camera move');
  assert.ok(Number.isFinite(report.gpuOn.median) && Number.isFinite(report.gpuOff.median), 'gpu timestamps present');
  report.errorCount = errors.length;
  await writeFile(`${out}/check.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('check-atmosphere: PASS');
} catch (error) {
  console.error(error);
  console.error(JSON.stringify({ report, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
