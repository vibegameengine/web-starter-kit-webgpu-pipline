// Motion blur check on the beach diorama (headed Chrome, always).
//
//   node scripts/check-motion-blur.mjs
//
// One session at `?cam=leaves`, TAA on, grain off, fixed exposure, `?motionBlur=1` (the
// pass is off by default). In order:
//   1. Still scene, still camera: the pass must be an identity — the frame with the
//      blur on equals the frame with it off to within the TAA's own frame-to-frame
//      drift on a still scene (measured between two blur-on frames the same time
//      apart). A pass that blurs a still picture is broken, whatever it does to a
//      moving one.
//   2. Wind on, camera still: the scene animates but the flattest sand block must not
//      change with the blur on (a still pixel in a moving frame stays itself). The
//      fronds' sway is a millimetre a frame here, under the pass's half-pixel floor,
//      so their blur is reported, not asserted.
//   3. Wind off, the camera alternates between two poses 5 cm apart every frame: a
//      constant-magnitude sideways velocity at a pose that never drifts, so a frame
//      with the blur on and one with it off see the same picture. Horizontal detail
//      in the frond region must drop with the blur on (edges smear along the motion),
//      vertical detail must not drop by nearly as much (a directional blur, not a
//      Gaussian), and the mean luminance must stay (an energy conserving filter). The
//      measured velocity is read from the scene pass so the blur radius is on record.
//   4. A teleport is a cut: the frame after `__camera` jumps a metre must not be blurred.
//   5. No console error the pass adds; GPU ms on/off from per-frame timestamp resolves.
//
// After the loading overlay hides the page saves the bake and the main thread stalls
// for seconds; every measurement waits for 30 consecutive frames under 100 ms first,
// or it reads the last frame rendered before the stall (a cut frame).
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';

const out = 'shots/motion-blur';
await mkdir(out, { recursive: true });
const base = `http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&cam=leaves&grain=0&exposure=1&gputime=1&motionBlur=1${process.env.GI_QUERY ?? ''}`;
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const errors = { on: new Set(), off: new Set() };
let phase = 'on';
const report = {};
const luma = (img, x, y) => { const p = (y * img.width + x) * 4; return 0.2126 * img.data[p] + 0.7152 * img.data[p + 1] + 0.0722 * img.data[p + 2]; };
const fronds = [400, 100, 900, 400];
const meanDiff = (a, b, [rx, ry, rw, rh]) => { let s = 0, n = 0; for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) { s += Math.abs(luma(a, x, y) - luma(b, x, y)); n++; } return s / n; };
const meanLuma = (a, [rx, ry, rw, rh]) => { let s = 0, n = 0; for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) { s += luma(a, x, y); n++; } return s / n; };
const gradient = (a, [rx, ry, rw, rh], dx, dy) => { let s = 0, n = 0; for (let y = ry + dy; y < ry + rh; y++) for (let x = rx + dx; x < rx + rw; x++) { s += Math.abs(luma(a, x, y) - luma(a, x - dx, y - dy)); n++; } return s / n; };
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
const shot = async (page, name) => {
  const path = `${out}/check-${name}.png`;
  await page.screenshot({ path });
  return PNG.sync.read(await readFile(path));
};
const gpuMs = async (page) => page.evaluate(async () => {
  const frames = [];
  for (let i = 0; i < 60; i++) { await new Promise((r) => requestAnimationFrame(r)); const t = await window.__gpuTime(); frames.push((t.render ?? 0) + (t.compute ?? 0)); }
  frames.sort((a, b) => a - b);
  return frames[30];
});
const settled = (page) => page.evaluate(() => new Promise((resolve) => {
  let last = performance.now(), run = 0;
  const f = () => { const t = performance.now(); run = t - last < 100 ? run + 1 : 0; last = t; if (run >= 30) resolve(); else requestAnimationFrame(f); };
  requestAnimationFrame(f);
}));
const meanVelocityPx = (page, [rx, ry, rw, rh]) => page.evaluate(async (r) => {
  const v = await window.__fog.velocityFrame(); let s = 0, n = 0;
  for (let y = r[1]; y < r[1] + r[3]; y += 2) for (let x = r[0]; x < r[0] + r[2]; x += 2) { const p = (y * v.width + x) * 4; s += Math.hypot(v.data[p] * 0.5 * v.width, v.data[p + 1] * 0.5 * v.height); n++; }
  return s / n;
}, [rx, ry, rw, rh]);
const setBlur = async (page, on) => {
  phase = on ? 'on' : 'off';
  await page.evaluate((v) => window.__fog.motionBlur(v), on);
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => window.__fog.motionBlur()), on);
};

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => errors[phase].add(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors[phase].add(m.text().slice(0, 200)); });
  await page.goto(`${base}&still=1`);
  await page.waitForFunction(() => window.__fog && window.__audit && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
  await settled(page);
  assert.equal(await page.evaluate(() => window.__fog.motionBlur()), true, '?motionBlur=1 must turn the pass on');

  // 1. Identity on a still frame.
  const stillOn0 = await shot(page, 'still-on-0');
  report.gpuOn = await gpuMs(page);
  const stillOn = await shot(page, 'still-on');
  await setBlur(page, false);
  await page.waitForTimeout(300);
  const stillOff = await shot(page, 'still-off');
  report.gpuOff = await gpuMs(page);
  const whole = [0, 0, 1600, 900];
  report.still = {
    drift: { fronds: meanDiff(stillOn0, stillOn, fronds), frame: meanDiff(stillOn0, stillOn, whole) },
    fronds: meanDiff(stillOn, stillOff, fronds), frame: meanDiff(stillOn, stillOff, whole),
  };
  await setBlur(page, true);

  // 2. Wind: fronds move, sand does not.
  await page.evaluate(() => window.__fog.still(false));
  await page.waitForTimeout(1500);
  report.windVelocityPx = await meanVelocityPx(page, fronds);
  const windOn = await shot(page, 'wind-on');
  await setBlur(page, false);
  await page.waitForTimeout(300);
  const windOff = await shot(page, 'wind-off');
  const flat = flattestBlock(windOff);
  report.wind = { flatRegion: flat, sand: meanDiff(windOn, windOff, flat), fronds: meanDiff(windOn, windOff, fronds) };
  await page.evaluate(() => window.__fog.still(true));
  await setBlur(page, true);

  // 3. The camera alternates between two poses 5 cm apart along x every frame, so the
  // velocity has a constant magnitude and the picture never drifts away from where
  // the blur-off frame is taken (at most one step apart).
  const slide = async () => page.evaluate(() => {
    const c = window.__probe();
    const p = c.camera, t = c.target;
    const step = 0.05; // metres, ~20 px at this distance
    let phase = 0;
    const tick = () => {
      phase ^= 1;
      const d = phase * step;
      window.__camera(p[0] + d, p[1], p[2], t[0] + d, t[1], t[2]);
      if (window.__slideOn) requestAnimationFrame(tick);
    };
    window.__slideOn = true;
    requestAnimationFrame(tick);
  });
  await slide();
  await page.waitForTimeout(600);
  report.slideVelocityPx = await meanVelocityPx(page, fronds);
  const slideOn = await shot(page, 'slide-on');
  await setBlur(page, false);
  const slideOff = await shot(page, 'slide-off');
  await page.evaluate(() => { window.__slideOn = false; });
  await setBlur(page, true);

  // 4. A cut: teleport the camera a metre and read the very next frame.
  const cutOn = await page.evaluate(() => new Promise((resolve) => {
    const c = window.__probe(); const p = c.camera, t = c.target;
    window.__camera(p[0] + 1.5, p[1], p[2], t[0] + 1.5, t[1], t[2]);
    requestAnimationFrame(() => resolve(window.__fog.taaState().cut));
  }));
  report.cut = { detected: cutOn };
  await page.waitForTimeout(300);
  await page.evaluate(() => { const c = window.__probe(); const p = c.camera, t = c.target; window.__camera(p[0] - 1.5, p[1], p[2], t[0] - 1.5, t[1], t[2]); });
  await page.waitForTimeout(300);
  report.slide = {
    horizontalOn: gradient(slideOn, fronds, 1, 0), horizontalOff: gradient(slideOff, fronds, 1, 0),
    verticalOn: gradient(slideOn, fronds, 0, 1), verticalOff: gradient(slideOff, fronds, 0, 1),
    lumaOn: meanLuma(slideOn, fronds), lumaOff: meanLuma(slideOff, fronds),
  };
  report.slide.horizontalRatio = report.slide.horizontalOn / report.slide.horizontalOff;
  report.slide.verticalRatio = report.slide.verticalOn / report.slide.verticalOff;

  const newErrors = [...errors.on].filter((e) => !errors.off.has(e));
  report.errors = { on: [...errors.on], off: [...errors.off] };
  await writeFile(`${out}/check.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  assert.deepEqual(newErrors, [], 'the pass must add no browser errors');
  assert.ok(report.still.frame < report.still.drift.frame * 1.5 + 0.3 && report.still.fronds < report.still.drift.fronds * 1.5 + 0.5,
    `a still frame must pass through unchanged (to within the TAA drift): ${JSON.stringify(report.still)}`);
  assert.ok(report.wind.sand < 1, `a still pixel in an animating frame must not change: ${JSON.stringify(report.wind)}`);
  assert.ok(report.slideVelocityPx > 5, `the alternating camera must give the fronds a measurable velocity: ${report.slideVelocityPx} px`);
  assert.ok(report.cut.detected === true, 'a 1.5 m teleport must be detected as a cut');
  assert.ok(report.slide.horizontalRatio < 0.8, `a sideways slide must smear horizontal detail: ${JSON.stringify(report.slide)}`);
  assert.ok(report.slide.verticalRatio > report.slide.horizontalRatio + 0.1, `the blur must be directional: ${JSON.stringify(report.slide)}`);
  assert.ok(Math.abs(report.slide.lumaOn - report.slide.lumaOff) < report.slide.lumaOff * 0.03, `the blur must conserve energy: ${JSON.stringify(report.slide)}`);
  assert.ok(Number.isFinite(report.gpuOn) && Number.isFinite(report.gpuOff), 'gpu timestamps present');
  console.log('check-motion-blur: PASS');
} catch (error) {
  console.error(error);
  console.error(JSON.stringify({ report, errors: { on: [...errors.on], off: [...errors.off] } }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
