/* @important Section 09 of the look document: the frame is accepted in motion, not on a
   still. The scene animates (no ?still=1) and the camera's own exposure profile stays on,
   so this walks the five poses the document names and asks what the light does - the meter
   along the route, the meter after a hard cut, the look still visible while everything
   moves. It reports no frame times on purpose: this tree is shared with other agents
   driving their own browsers, and a millisecond measured here would be theirs as much as
   ours. Frame cost belongs in a quiet machine, alone. */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdirSync } from 'node:fs';

setTimeout(() => { console.error('gate: 10 minutes, abort'); process.exit(2); }, 600000);

const SCENE = process.env.ROUTE_SCENE ?? 'midsee-village';
const CAM = process.env.ROUTE_CAM ?? 'front';
const ROUTE_FRAMES = 420;
const WARMUP_FRAMES = 240;

const CASES = {
  'neutral look': '',
  'working look': '&exposureEV=0.5&indirectEV=0.35&saturation=1.06&contrast=1.04',
};

const chromeArgs = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--no-sandbox'];
const failures = [];
const expect = (name, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(name);
};

const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
function meanLuminance(image) {
  let sum = 0;
  let used = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const luminance = 0.2126 * srgbToLinear(image.data[i] / 255) + 0.7152 * srgbToLinear(image.data[i + 1] / 255) + 0.0722 * srgbToLinear(image.data[i + 2] / 255);
    sum += luminance;
    used++;
  }
  return sum / used;
}

const WAYPOINTS = [
  { turn: 0, zoom: 1, lift: 1 },
  { turn: -0.35, zoom: 0.72, lift: 0.55 },
  { turn: -0.15, zoom: 0.55, lift: 0.3 },
  { turn: 0.3, zoom: 0.6, lift: 0.7 },
  { turn: 0.8, zoom: 0.95, lift: 1.1 },
];

const flyRoute = (page, frames, waypoints) => page.evaluate(([count, route]) => new Promise((resolve) => {
  const probe = window.__probe();
  const [ex, ey, ez] = probe.camera;
  const [tx, ty, tz] = probe.target;
  const radius = Math.hypot(ex - tx, ez - tz);
  const height = ey - ty;
  const start = Math.atan2(ex - tx, ez - tz);
  let seen = 0;
  const step = () => {
    const at = Math.min(route.length - 1.001, (seen / count) * (route.length - 1));
    const a = route[Math.floor(at)];
    const b = route[Math.floor(at) + 1];
    const k = at - Math.floor(at);
    const smooth = k * k * (3 - 2 * k);
    const mix = (from, to) => from + (to - from) * smooth;
    const angle = start + mix(a.turn, b.turn);
    const zoom = mix(a.zoom, b.zoom);
    window.__camera(tx + Math.sin(angle) * radius * zoom, ty + height * mix(a.lift, b.lift), tz + Math.cos(angle) * radius * zoom, tx, ty, tz);
    if (++seen >= count) resolve(true);
    else requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}), [frames, waypoints]);

const idle = (page, frames) => page.evaluate((count) => new Promise((resolve) => {
  let seen = 0;
  const step = () => { if (++seen >= count) resolve(true); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), frames);

const exposureTrail = (page, samples) => page.evaluate(async (count) => {
  const trail = [];
  for (let step = 0; step < count; step++) {
    trail.push(+(await window.__fog.exposure()).toFixed(4));
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return trail;
}, samples);

mkdirSync('shots/look/route', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: chromeArgs });
const brightness = {};
try {
  for (const [name, query] of Object.entries(CASES)) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:5188/?scene=${SCENE}&cam=${CAM}&hud=0&inspector=0${query}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const ready = await page.waitForFunction(() => {
      const error = document.querySelector('#error-overlay');
      if (error && !error.hidden && !error.classList.contains('hidden')) return { error: document.querySelector('#error-message')?.textContent ?? 'error overlay' };
      const loading = document.querySelector('#loading-overlay');
      return (!loading || loading.hidden || loading.classList.contains('hidden')) && window.__camera && window.__probe ? { ready: true } : false;
    }, null, { timeout: 400000, polling: 500 }).then((handle) => handle.jsonValue());
    if (ready.error) throw new Error(`pipeline error: ${ready.error}`);

    await idle(page, WARMUP_FRAMES);
    const bootErrors = errors.length;
    const slug = name.replace(/\W+/g, '-');
    await flyRoute(page, Math.floor(ROUTE_FRAMES / 2), WAYPOINTS.slice(0, 3));
    const midRoute = PNG.sync.read(await page.screenshot({ path: `shots/look/route/${slug}-mid.png` }));
    brightness[name] = meanLuminance(midRoute);
    await flyRoute(page, Math.floor(ROUTE_FRAMES / 2), WAYPOINTS.slice(2));
    await page.screenshot({ path: `shots/look/route/${slug}-end.png` });

    const alongRoute = await exposureTrail(page, 8);
    const steps = alongRoute.slice(1).map((value, index) => Math.abs(value / alongRoute[index] - 1));
    expect(`${name}: the meter adapts without a jump`, Math.max(...steps) < 0.25, `E ${alongRoute[0]} → ${alongRoute.at(-1)}, largest step ${(Math.max(...steps) * 100).toFixed(1)}% per 150 ms`);

    await page.evaluate(() => {
      const probe = window.__probe();
      const [ex, ey, ez] = probe.camera;
      const [tx, ty, tz] = probe.target;
      window.__camera(tx - (ex - tx), ey, tz - (ez - tz), tx, ty, tz);
    });
    const afterCut = await exposureTrail(page, 8);
    await page.screenshot({ path: `shots/look/route/${slug}-after-cut.png` });
    expect(`${name}: the meter settles again after a hard cut`, Math.abs(afterCut.at(-1) / afterCut.at(-2) - 1) < 0.02, `E ${afterCut.join(' → ')}`);
    expect(`${name}: the route raised no page errors`, errors.length === bootErrors, errors.slice(bootErrors, bootErrors + 2).join(' | '));
    await page.close();
  }

  const ratio = brightness['working look'] / brightness['neutral look'];
  expect('the look is still doing its work mid-route, with the meter free', ratio > 1.05, `mean frame luminance ratio ${ratio.toFixed(3)} (the meter compensates part of it, by design)`);
} catch (error) {
  console.log(`FAIL ${error.message}`);
  failures.push(error.message);
} finally {
  await browser.close();
}

console.log(failures.length ? `FAILED: ${failures.join(', ')}` : 'OK look route');
process.exit(failures.length ? 1 : 0);
