// Temporal anti-aliasing check on the beach diorama.
//
//   node scripts/check-taa.mjs            # headed Chrome against http://127.0.0.1:5188
//
// One session at `?cam=leaves` (fronds against the sun: thin geometry, the worst
// aliasing in the scene), frozen mover and wind (`still=1`, so the edge metric is about
// resolving static edges; motion is covered by the camera cut), grain off. In order:
//   1. TAA (default) settles for a second; a frame is captured and GPU ms measured.
//   2. Ground truth: the eight jittered frames the resolve is fed (the composed
//      beauty, before the resolve) of the still scene are read back and averaged — the image a converged resolve should output. The resolved
//      frame must match that average (mean luma difference over the frond region) and
//      carry no more stair steps than it (pixels whose horizontal luminance step
//      exceeds 48/255). Eight sub-pixel samples of a thin frond against the sky still
//      leave most of those steps: the ideal average removes ~17 % of them, so the raw
//      count is only compared against the average, never against a fixed fraction
//      (measured 2026-09-08 with `_taa_truth_probe.mjs`: single 11133, average 9198,
//      resolved 8688).
//   3. Switch to `none` and `fxaa` through the audit hook (the GUI path), capture,
//      measure GPU ms; the TAA frame must have fewer steps than the raw one.
//   4. Back to TAA; the camera jumps by a third of the frame. The first frame after the
//      jump must not be black and must not be the *old* view (history rejected, not
//      smeared): its difference to the settled post-jump frame must be small compared
//      to the difference between the two viewpoints.
//   5. After settling, the TAA frame is compared to a `none` frame at the same view:
//      the mean difference over a static backdrop patch must stay small (no colour drift,
//      no blur-induced darkening), while the frond region keeps its reduced stair steps.
//   6. No console error in any phase.
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';

const out = 'shots/taa';
await mkdir(out, { recursive: true });
const url = `http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&still=1&grain=0&gputime=1&cam=leaves${process.env.GI_QUERY ?? ''}`;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});
const errors = [];
const report = {};

const luma = (img, x, y) => {
  const p = (y * img.width + x) * 4;
  return 0.2126 * img.data[p] + 0.7152 * img.data[p + 1] + 0.0722 * img.data[p + 2];
};
/** Pixels whose horizontal luminance step exceeds `threshold`, inside a region. */
const stairSteps = (img, [x0, y0, w, h], threshold = 48) => {
  let n = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0 + 1; x < x0 + w; x++) {
    if (Math.abs(luma(img, x, y) - luma(img, x - 1, y)) > threshold) n++;
  }
  return n;
};
const meanDiff = (a, b, [x0, y0, w, h]) => {
  let sum = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const p = (y * a.width + x) * 4;
    for (let c = 0; c < 3; c++) sum += Math.abs(a.data[p + c] - b.data[p + c]);
  }
  return sum / (w * h * 3);
};
const meanLuma = (img) => {
  let s = 0;
  for (let y = 0; y < img.height; y += 4) for (let x = 0; x < img.width; x += 4) s += luma(img, x, y);
  return s / ((img.width / 4) * (img.height / 4));
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
const setAA = async (page, mode) => {
  await page.evaluate((m) => window.__fog.aa(m), mode);
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => window.__fog.aa()), mode);
};

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => window.__fog && window.__audit && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
  await page.waitForTimeout(1500);

  // Frond silhouettes against the backdrop. The static patch for the drift test is
  // found in the frame itself: the 80x80 block with the flattest luminance in the raw
  // frame is backdrop with no frond over it.
  const fronds = [400, 100, 900, 400];
  const flattestBlock = (img) => {
    let best = null;
    for (let y = 0; y + 80 <= img.height; y += 40) for (let x = 0; x + 80 <= img.width; x += 40) {
      let s = 0, s2 = 0;
      for (let j = 0; j < 80; j += 2) for (let i = 0; i < 80; i += 2) { const l = luma(img, x + i, y + j); s += l; s2 += l * l; }
      const n = 1600, sd = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
      if (best === null || sd < best.sd) best = { sd, region: [x, y, 80, 80] };
    }
    return best.region;
  };

  assert.equal(await page.evaluate(() => window.__fog.aa()), 'taa', 'TAA must be the default');
  const taa = await shot(page, 'taa');
  report.gpuTaa = await gpuMs(page);
  // 2. The resolve against the average of the eight jitter phases (linear domain,
  // display-encoded for the metric the same way for both).
  report.truth = await page.evaluate(async (region) => {
    const phases = new Map();
    let width = 0, height = 0;
    for (let i = 0; i < 64 && phases.size < 8; i++) {
      const j = window.__fog.taaState().jitter.join(',');
      const f = await window.__fog.taaInputFrame();
      width = f.width; height = f.height;
      if (!phases.has(j)) phases.set(j, f.data);
      await new Promise((res) => requestAnimationFrame(res));
    }
    const frames = [...phases.values()];
    const avg = new Float32Array(frames[0].length);
    for (const d of frames) for (let k = 0; k < d.length; k++) avg[k] += d[k] / frames.length;
    const resolved = (await window.__fog.taaFrame()).data;
    const srgb = (v) => Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.2) * 255;
    const luma = (d, x, y) => { const p = (y * width + x) * 4; return 0.2126 * srgb(d[p]) + 0.7152 * srgb(d[p + 1]) + 0.0722 * srgb(d[p + 2]); };
    const [rx, ry, rw, rh] = region;
    const steps = (d) => { let n = 0; for (let y = ry; y < ry + rh; y++) for (let x = rx + 1; x < rx + rw; x++) if (Math.abs(luma(d, x, y) - luma(d, x - 1, y)) > 48) n++; return n; };
    const diff = (a, b) => { let s = 0, n = 0; for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) { s += Math.abs(luma(a, x, y) - luma(b, x, y)); n++; } return s / n; };
    return { phases: phases.size, steps: { single: steps(frames[0]), average: steps(avg), resolved: steps(resolved) }, resolvedVsAverage: diff(resolved, avg), singleVsAverage: diff(frames[0], avg) };
  }, fronds);

  await setAA(page, 'none');
  const none = await shot(page, 'none');
  report.gpuNone = await gpuMs(page);

  await setAA(page, 'fxaa');
  const fxaa = await shot(page, 'fxaa');
  report.gpuFxaa = await gpuMs(page);

  report.steps = { taa: stairSteps(taa, fronds), fxaa: stairSteps(fxaa, fronds), none: stairSteps(none, fronds) };

  // 4. Camera jump under TAA.
  await setAA(page, 'taa');
  const before = await shot(page, 'taa-before-jump');
  await page.evaluate(() => window.__camera(-0.9, 3.4, -0.2, 3.2, 3.6, -3.6));
  await page.waitForTimeout(60);
  const first = await shot(page, 'taa-first-after-jump');
  await page.waitForTimeout(1200);
  const settled = await shot(page, 'taa-settled-after-jump');
  report.jump = {
    firstVsBefore: meanDiff(first, before, fronds),
    firstVsSettled: meanDiff(first, settled, fronds),
    beforeVsSettled: meanDiff(before, settled, fronds),
    firstLuma: meanLuma(first),
  };

  // 5. Same view without AA.
  await setAA(page, 'none');
  const noneAfter = await shot(page, 'none-after-jump');
  const flat = flattestBlock(noneAfter);
  report.settledVsNone = { flatRegion: flat, sand: meanDiff(settled, noneAfter, flat), fronds: meanDiff(settled, noneAfter, fronds) };
  report.stepsAfter = { taa: stairSteps(settled, fronds), none: stairSteps(noneAfter, fronds) };

  report.errors = errors;
  await writeFile(`${out}/check.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  assert.deepEqual(errors, [], 'no browser errors');
  assert.equal(report.truth.phases, 8, 'all eight jitter phases must be observed');
  assert.ok(report.truth.resolvedVsAverage < 2 && report.truth.resolvedVsAverage < report.truth.singleVsAverage * 0.5, `the resolve must converge to the average of the jittered frames: ${JSON.stringify(report.truth)}`);
  assert.ok(report.truth.steps.resolved <= report.truth.steps.average * 1.05, `the resolve must be as smooth as the converged average: ${JSON.stringify(report.truth)}`);
  assert.ok(report.steps.taa < report.steps.none, `TAA must remove stair steps: ${JSON.stringify(report.steps)}`);
  assert.ok(report.jump.firstLuma > 20, 'no black frame after the jump');
  // A ghost of the old view would keep `first` close to `before`; a rejected history
  // puts it as far from `before` as the new view is.
  assert.ok(report.jump.firstVsBefore > report.jump.beforeVsSettled * 0.7, `history must be rejected on a cut, not smeared: ${JSON.stringify(report.jump)}`);
  assert.ok(report.settledVsNone.sand < 4, `no drift on the static backdrop: ${JSON.stringify(report.settledVsNone)}`);
  assert.ok(report.stepsAfter.taa < report.stepsAfter.none, `still anti-aliased after settling: ${JSON.stringify(report.stepsAfter)}`);
  console.log('check-taa: PASS');
} catch (error) {
  console.error(error);
  console.error(JSON.stringify({ report, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
