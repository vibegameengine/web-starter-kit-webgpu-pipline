// The shallow-water solver off the frame: what the main thread stopped doing, and
// that the water still moves without it.
//
//   node scripts/check-water-sim.mjs                    # 1280x720
//   WATER_SIM_SIZE=3840x2160 node scripts/check-water-sim.mjs
//
// Headed Chrome against http://127.0.0.1:5188, always.
//
// Two boots of `?cam=water` (top-down over the lagoon, the swash on the right):
//
//   offThread  the default — the Kurganov–Petrova solver on its own thread and its
//              own WebGPU device (src/entities/water/simWorker.ts)
//   inFrame    `?waterSim=main`, the same solver stepped inside the frame, live
//
// For each it reads `window.__gpuPasses`, three's RendererInspector as the pipeline
// exposes it: every render and compute of every frame with its timestamp query,
// medianed per pass. The solver's passes are the 384x384 quad renders — 12 + 12
// SSP-RK2 stages and one view pass. It also reads `window.__water()`, the solver's
// own clock and the worker's rolling one-second rate.
//
// Motion is judged from two frames 700 ms apart in three fractions of the frame: the
// lagoon, the swash at the water's edge, and dry sand above the water line, which is
// both the control for TAA jitter and the reference that fixes the exposure gain
// between the two frames (see `regionDiff`).
//
// Passes when: the off-thread boot encodes no 384x384 pass at all while the in-frame
// boot encodes them (the control that proves the probe can see them); the off-thread
// water advances its own clock at real time; the lagoon and the swash both change
// between the two frames by more than the dry-sand control; the frame is no slower
// than the same session with the worker stopped; and no console error appears
// off-thread that the in-frame boot does not also produce.
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';

setTimeout(() => { console.error('check-water-sim: 3-minute gate hit, aborting'); process.exit(2); }, 180000);

const out = 'shots/water-sim';
await mkdir(out, { recursive: true });
const base = 'http://127.0.0.1:5188/?scene=beach&hud=0&gputime=1&cam=water';
const SOLVER_PASS = /384x384/;
const [WIDTH, HEIGHT] = (process.env.WATER_SIM_SIZE ?? '1280x720').split('x').map(Number);
/** Fractions of the frame at `?cam=water`: [x0, y0, x1, y1]. See the header for what each is. */
const REGIONS = {
  lagoon: [0.00, 0.00, 0.70, 0.97],
  swash: [0.78, 0.47, 0.97, 0.69],
  drySand: [0.78, 0.00, 0.98, 0.12],
};
const scale = ([x0, y0, x1, y1]) => [Math.round(x0 * WIDTH), Math.round(y0 * HEIGHT), Math.round(x1 * WIDTH), Math.round(y1 * HEIGHT)];

// One browser per boot: measured 2026-09-08, a second page in the same browser
// ran the frame at 18.7 ms against 8.3 ms for the first — the closed page's WebGPU
// device is not released in time, and both boots must see the same machine.
const launch = () => chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});

const meanChannel = (img, [x0, y0, x1, y1]) => {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * img.width + x) * 4;
      sum += img.data[p] + img.data[p + 1] + img.data[p + 2];
      n += 3;
    }
  }
  return sum / n;
};

/**
 * Mean |ΔRGB| per channel between two frames inside a rectangle, with a global gain
 * applied to the second. The gain is needed: measured 2026-09-08, two frames 700 ms
 * apart in the same session can differ by a uniform ~8 % — the beach's exposure and
 * lightmap intensity are still settling long after the loading overlay goes — and
 * that drift alone read 24/255 on dry sand, more than the water's own motion.
 */
const regionDiff = (a, b, [x0, y0, x1, y1], gain) => {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * a.width + x) * 4;
      sum += Math.abs(a.data[p] - b.data[p] * gain)
        + Math.abs(a.data[p + 1] - b.data[p + 1] * gain)
        + Math.abs(a.data[p + 2] - b.data[p + 2] * gain);
      n += 3;
    }
  }
  return sum / n;
};

async function boot(label, query) {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));
  await page.goto(`${base}${query}`);
  // Both audit hooks, not just the overlay: this tree is shared, and a save in
  // another session reloads the page through Vite mid-run — landing an evaluate in
  // a page that has booted the canvas but not yet installed the hooks.
  await page.waitForFunction(
    () => typeof window.__gpuPasses === 'function' && typeof window.__water === 'function' && document.querySelector('#loading-overlay')?.hidden,
    null, { timeout: 120000 },
  );
  // The worker's device is starved while the main thread finishes its own boot
  // (measured 2026-09-08: ~7 s at 0.1–0.3x real time, then a steady 60 Hz), so the
  // rate is only meaningful once the session has settled.
  await page.waitForTimeout(14000);

  const before = await page.evaluate(() => window.__water());
  await page.screenshot({ path: `${out}/${label}-a.png` });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${label}-b.png` });
  const after = await page.evaluate(() => window.__water());
  const passes = await page.evaluate(() => window.__gpuPasses(40));
  // The worker's device shares the GPU with the frame's. Stopping it in the same
  // session is the only way to separate its contention from the run-to-run spread
  // of two browser launches.
  let paused = null;
  if (after.offThread) {
    await page.evaluate(() => window.__waterRun(false));
    await page.waitForTimeout(2500);
    const off = await page.evaluate(() => window.__gpuPasses(40));
    paused = { frameMs: Number(off.frameMs.toFixed(2)), gpuMs: Number(off.gpuMs.toFixed(3)) };
    await page.evaluate(() => window.__waterRun(true));
  }
  await browser.close();

  const a = PNG.sync.read(await readFile(`${out}/${label}-a.png`));
  const b = PNG.sync.read(await readFile(`${out}/${label}-b.png`));
  // Dry sand above the water line carries no water, so it fixes the exposure gain.
  const control = scale(REGIONS.drySand);
  const gain = meanChannel(a, control) / meanChannel(b, control);
  const motion = Object.fromEntries(Object.entries(REGIONS).map(([name, rect]) => [name, Number(regionDiff(a, b, scale(rect), gain).toFixed(2))]));
  motion.exposureGain = Number(gain.toFixed(4));
  const solver = passes.passes.filter((p) => SOLVER_PASS.test(p.name));
  return {
    label,
    offThread: after.offThread,
    simTimeAdvanced: Number((after.simTime - before.simTime).toFixed(3)),
    rate: after.cost ? Number(after.cost.rate.toFixed(3)) : null,
    hz: after.cost ? Number(after.cost.hz.toFixed(1)) : null,
    workerStepMs: after.cost ? Number(after.cost.step.toFixed(2)) : null,
    readbackMs: after.cost ? Number(after.cost.readback.toFixed(1)) : null,
    frameMs: Number(passes.frameMs.toFixed(2)),
    gpuMs: Number(passes.gpuMs.toFixed(3)),
    workerPaused: paused,
    solverPasses: solver.reduce((n, p) => n + p.perFrame, 0),
    solverGpuMs: Number(solver.reduce((s, p) => s + p.gpu, 0).toFixed(3)),
    solverCpuMs: Number(solver.reduce((s, p) => s + p.cpu, 0).toFixed(2)),
    motion,
    errors: [...new Set(errors)],
  };
}

// The in-frame boot first: it is the baseline the off-thread numbers are read against.
const inFrame = await boot('in-frame', '&waterSim=main');
const offThread = await boot('off-thread', '');
const report = { viewport: `${WIDTH}x${HEIGHT}`, inFrame, offThread, freedCpuMs: Number((inFrame.solverCpuMs - offThread.solverCpuMs).toFixed(2)), freedGpuMs: Number((inFrame.solverGpuMs - offThread.solverGpuMs).toFixed(3)) };
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

// (a) the frame no longer encodes the solver.
assert.equal(offThread.offThread, true, 'the default boot did not run the solver off-thread');
assert.equal(offThread.solverPasses, 0, `the off-thread frame still encodes ${offThread.solverPasses} solver passes`);
// Two renders per SSP-RK2 sub-step plus one view pass. The sub-step count follows
// the frame time — 12 at 4K, ~6 at the 8.3 ms frames this check sees — so the floor
// is only there to prove the probe can see the passes at all.
assert.ok(inFrame.solverPasses >= 8, `the in-frame control encoded only ${inFrame.solverPasses} solver passes — the probe cannot see them, so the off-thread zero proves nothing`);

// (b) the water still moves, and its own clock keeps real time.
assert.ok(offThread.simTimeAdvanced > 0.5, `off-thread sim clock advanced ${offThread.simTimeAdvanced} s over 0.7 s of wall time`);
assert.ok(offThread.rate > 0.9 && offThread.rate < 1.1, `off-thread solver ran at ${offThread.rate}x real time`);
for (const region of ['lagoon', 'swash']) {
  assert.ok(offThread.motion[region] > offThread.motion.drySand * 1.5,
    `off-thread ${region} changed ${offThread.motion[region]} against ${offThread.motion.drySand} on dry sand — the water is not moving`);
}
assert.ok(offThread.motion.swash > 4, `off-thread swash changed only ${offThread.motion.swash}`);

// (c) the solver's GPU time left the frame, and the second device does not cost the
// frame more than it saved.
//
// `gpuMs` — the sum of the main renderer's own timestamp queries — is NOT a fair A/B
// once a second device shares the GPU, and this is measured, not assumed. Toggling
// the worker six times inside one session, 2026-09-08:
//
//   1280x720   worker on 4.49 / 3.65 / 3.62 ms   off 4.57 / 4.56 / 4.48 ms
//   3840x2160  worker on 29.8 / 30.0 / 30.1 ms   off 21.4 / 28.4 / 28.2 ms
//
// At 720p the frame measures CHEAPER with the worker running, which no amount of
// contention can explain: the extra load raises the GPU's clocks, so the main
// device's passes finish in fewer nanoseconds. At 4K the interleaving stretches the
// main passes' begin/end timestamps instead and the sum reads ~1.7 ms high. Wall
// time is the honest measure, and over the same toggles it did not move: 29.7 / 32.4
// / 27.5 ms with the worker against 30.7 / 30.0 / 30.2 ms without.
//
// So the gate is the wall-clock frame interval against the same session with the
// worker stopped, plus the solver's own line going to zero.
assert.equal(offThread.solverGpuMs, 0, `the off-thread frame still spends ${offThread.solverGpuMs} ms GPU on solver passes`);
assert.ok(offThread.frameMs <= offThread.workerPaused.frameMs * 1.1,
  `the worker costs the frame ${offThread.frameMs} ms against ${offThread.workerPaused.frameMs} ms with it stopped in the same session`);

const newErrors = offThread.errors.filter((e) => !inFrame.errors.includes(e));
assert.equal(newErrors.length, 0, `off-thread console errors the in-frame boot does not produce: ${JSON.stringify(newErrors)}`);

console.log(`\nOK at ${WIDTH}x${HEIGHT} — solver passes ${inFrame.solverPasses}/frame → ${offThread.solverPasses}; `
  + `main-thread CPU freed ${report.freedCpuMs} ms/frame, its GPU time ${report.freedGpuMs} ms/frame; `
  + `frame ${inFrame.frameMs} → ${offThread.frameMs} ms (${offThread.workerPaused.frameMs} ms with the worker stopped); `
  + `water at ${offThread.rate}x real time, ${offThread.hz} Hz on the worker.`);
process.exit(0);
