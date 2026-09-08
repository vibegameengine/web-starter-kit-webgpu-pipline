// Sun penumbra check on the beach diorama.
//
//   node scripts/check-soft-shadows.mjs           # headed Chrome against http://127.0.0.1:5188
//
// Boots `?cam=shore` (palm frond shadows on the sand, fronds ~4–5 m up) with the soft
// filter at three sun discs — 0.05° (a point sun: the penumbra collapses to the hard
// core), 0.533° (the Earth value) and 2° — and once with `receiverPlane`, the hard
// filter it is built on. For each it captures the frame, measures GPU ms from the
// renderer's timestamp queries, and estimates the penumbra as contrast / peak slope of
// the steepest shadow edge of a frond on fixed scanlines.
//
// The frond's leaflets are only a few pixels wide here, so their shadows never reach a
// full umbra once the penumbra exceeds the leaflet: the measured width saturates and
// the core lightens. That is physics, not a defect, which is why the check does not
// compare soft against hard directly but asks for what the mechanism must do: the
// width must grow monotonically with the disc, the point-sun result must land on the
// hard filter, and the lit sand must not change.
//
// Passes when: no console error appears with `soft` that `receiverPlane` does not also
// produce; width(2°) > width(0.533°) > width(0.05°); width(0.05°) within 25 % of the
// hard filter; the lit side of the edge within 3/255 of the hard filter; GPU ms finite.
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';

const out = 'shots/soft-shadows';
await mkdir(out, { recursive: true });
const base = 'http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&gputime=1&cam=shore';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});

const errors = {};
const report = {};
const luma = (img, x, y) => {
  const p = (y * img.width + x) * 4;
  return 0.2126 * img.data[p] + 0.7152 * img.data[p + 1] + 0.0722 * img.data[p + 2];
};
/**
 * Along a scanline, take the steepest luminance edge inside [x0, x1] and measure its
 * width as local contrast / peak slope: a hard edge of contrast C rising in one pixel
 * has slope C and width 1; a penumbra spreading it over n pixels has slope C/n. Local
 * contrast is the min/max within ±15 px of the steepest point, so neighbouring leaflet
 * shadows do not enter the measurement.
 */
const edgeWidth = (img, y, x0, x1) => {
  const row = [];
  for (let x = x0; x <= x1; x++) row.push(luma(img, x, y));
  // 3 px smoothing takes the sand's texture grain out; a multi-pixel edge survives it.
  const s = row.map((_, i) => (row[Math.max(0, i - 1)] + row[i] + row[Math.min(row.length - 1, i + 1)]) / 3);
  let best = -1, slope = 0;
  for (let i = 1; i < s.length; i++) {
    const d = Math.abs(s[i] - s[i - 1]);
    if (d > slope) { slope = d; best = i; }
  }
  const lo = Math.min(...s.slice(Math.max(0, best - 15), best + 16));
  const hi = Math.max(...s.slice(Math.max(0, best - 15), best + 16));
  const contrast = hi - lo;
  return { x: x0 + best, contrast, slope, width: slope > 0 ? contrast / slope : NaN, core: lo, lit: hi };
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

try {
  const variants = {
    soft005: '&shadowFilter=soft&sunDisc=0.05',
    soft: '&shadowFilter=soft&sunDisc=0.533',
    soft2: '&shadowFilter=soft&sunDisc=2',
    receiverPlane: '&shadowFilter=receiverPlane',
  };
  for (const [filter, query] of Object.entries(variants)) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    errors[filter] = new Set();
    page.on('pageerror', (e) => errors[filter].add(String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errors[filter].add(m.text().slice(0, 200)); });
    await page.goto(`${base}${query}${process.env.GI_QUERY ?? ''}`);
    await page.waitForFunction(() => window.__audit && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
    await page.waitForTimeout(1500);
    const path = `${out}/check-${filter}.png`;
    await page.screenshot({ path });
    const img = PNG.sync.read(await readFile(path));
    // Frond shadows crossing the sand near the top of the frame (see check-soft.png);
    // rows without a real shadow edge (local contrast under 40/255) are left out.
    const rows = Array.from({ length: 11 }, (_, i) => 20 + i * 10);
    const edges = rows.map((y) => ({ y, ...edgeWidth(img, y, 1000, 1400) })).filter((e) => e.contrast > 40);
    report[filter] = { gpu: await gpuMs(page), edges };
    await page.close();
  }
  const mean = (filter) => {
    const v = report[filter].edges.map((e) => e.width).filter(Number.isFinite);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  };
  const lit = (filter) => Math.max(...report[filter].edges.map((e) => e.lit));
  report.summary = {
    widthPointSun: mean('soft005'),
    widthEarthSun: mean('soft'),
    width2deg: mean('soft2'),
    widthHard: mean('receiverPlane'),
    litSoft: lit('soft'),
    litHard: lit('receiverPlane'),
    gpuSoftMs: report.soft.gpu.median,
    gpuHardMs: report.receiverPlane.gpu.median,
  };
  const newErrors = [...errors.soft].filter((e) => !errors.receiverPlane.has(e));
  report.errors = Object.fromEntries(Object.keys(variants).map((k) => [k, [...errors[k]]]));
  await writeFile(`${out}/check.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
  const s = report.summary;
  assert.deepEqual(newErrors, [], 'soft filter must add no browser errors');
  assert.ok(s.width2deg > s.widthEarthSun && s.widthEarthSun > s.widthPointSun, `penumbra must grow with the sun disc: ${JSON.stringify(s)}`);
  assert.ok(Math.abs(s.widthPointSun - s.widthHard) < 0.25 * s.widthHard, `a point sun must land on the hard filter: ${JSON.stringify(s)}`);
  assert.ok(Math.abs(s.litSoft - s.litHard) < 3, `lit sand must not change: ${JSON.stringify(s)}`);
  assert.ok(Number.isFinite(s.gpuSoftMs), 'gpu timestamps present');
  console.log('check-soft-shadows: PASS');
} catch (error) {
  console.error(error);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
