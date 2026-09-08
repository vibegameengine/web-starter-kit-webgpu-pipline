// Per-pass GPU/CPU cost of one frame on the beach at 4K (headed, always).
//
//   node scripts/perf-passes.mjs [--cam shore] [--query "&reflections=0"] [--frames 90] [--1080]
//
// Opens the scene at 1920x1080 with a device pixel ratio of 2 (a 3840x2160 drawing
// buffer; the renderer clamps the ratio at 2), waits for the bake-save stall to end,
// then reads `__gpuPasses`: three's RendererInspector records every render and
// compute of every frame with its timestamp query, and the hook returns the median
// per pass over N frames. Prints the frame interval, the summed GPU time and the
// passes largest first. This is the measurement the performance work starts from;
// it changes nothing.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const cam = flag('--cam', '');
const query = flag('--query', '');
const frames = Number(flag('--frames', '90'));
const hd = args.includes('--1080');
const url = `http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&gputime=1${cam ? `&cam=${cam}` : ''}${query}`;

// Hard gate: a measurement that has not finished in 3 minutes is a hung measurement,
// not a slow one (user rule 2026-09-08). Kill it and say so.
const gate = setTimeout(() => { console.error('perf-passes: 3-minute gate hit, aborting'); process.exit(2); }, 180000);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: hd ? 1 : 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
console.log('open', new Date().toISOString().slice(11,19)); await page.goto(url);
await page.waitForFunction(() => window.__gpuPasses && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 240000 });
console.log('overlay hidden', new Date().toISOString().slice(11,19));
// The bake save after the overlay stalls the main thread for seconds; wait for 30
// consecutive frames under 500 ms before measuring anything. (100 ms never held
// at 4K on 2026-09-08: the frame itself was longer than that, and the gate fired.)
await page.evaluate(() => new Promise((resolve) => {
  let last = performance.now(), run = 0;
  const f = () => { const t = performance.now(); run = t - last < 500 ? run + 1 : 0; last = t; if (run >= 30) resolve(); else requestAnimationFrame(f); };
  requestAnimationFrame(f);
}));
console.log('frames steady', new Date().toISOString().slice(11,19));
const size = await page.evaluate(() => { const c = document.querySelector('canvas'); return [c.width, c.height]; });
const info = await page.evaluate(() => { const i = window.__audit?.memory?.(); return i; });
const r = await page.evaluate((n) => window.__gpuPasses(n), frames);
console.log(`${url}\ndrawing buffer ${size[0]}x${size[1]}, ${r.framesUsed} frames: frame ${r.frameMs.toFixed(2)} ms (${(1000 / r.frameMs).toFixed(0)} fps), GPU sum ${r.gpuMs.toFixed(2)} ms`);
if (info) console.log('memory', JSON.stringify(info));
console.log('  gpu ms   cpu ms  x/frame  pass');
for (const p of r.passes) console.log(`${p.gpu.toFixed(3).padStart(8)} ${p.cpu.toFixed(3).padStart(8)} ${String(p.perFrame).padStart(8)}  ${p.name}`);
if (errors.length) console.log('errors:', errors.slice(0, 5));
clearTimeout(gate);
await browser.close();
