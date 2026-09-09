// Records every frame interval for N seconds and prints the spikes with the time
// they happened, plus any console line that landed in the same second. Headed.
//
//   node scripts/_spike_probe.mjs [seconds] [query]
import { chromium } from 'playwright';
const seconds = Number(process.argv[2] ?? 120);
setTimeout(() => { console.error('gate hit, abort'); process.exit(2); }, (seconds + 90) * 1000);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
const logs = [];
page.on('console', (m) => logs.push({ t: Date.now(), text: m.text().slice(0, 110) }));
await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0${process.argv[3] ?? ''}`);
await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 150000 });
await page.evaluate(() => new Promise((r) => { let last = performance.now(), run = 0; const f = () => { const t = performance.now(); run = t - last < 500 ? run + 1 : 0; last = t; if (run >= 30) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
const started = Date.now();
const frames = await page.evaluate((sec) => new Promise((resolve) => {
  const out = []; const t0 = performance.now(); let last = t0;
  const f = () => { const t = performance.now(); out.push([+(t - t0).toFixed(0), +(t - last).toFixed(1), (performance.memory?.usedJSHeapSize ?? 0) >> 20]); last = t;
    if (t - t0 < sec * 1000) requestAnimationFrame(f); else resolve(out); };
  requestAnimationFrame(f);
}), seconds);
const dts = frames.map((f) => f[1]).sort((a, b) => a - b);
const median = dts[dts.length >> 1];
const spikes = frames.filter((f) => f[1] > Math.max(median * 2, median + 8));
console.log(`${frames.length} frames over ${seconds}s, median ${median.toFixed(1)} ms, p99 ${dts[Math.floor(dts.length * 0.99)].toFixed(1)} ms, ${spikes.length} spikes`);
let previous = 0;
for (const [at, dt] of spikes) {
  const near = logs.filter((l) => Math.abs(l.t - (started + at)) < 1200).map((l) => l.text);
  const i = frames.findIndex((f) => f[0] === at);
  const heapBefore = frames[Math.max(0, i - 2)][2], heapAfter = frames[Math.min(frames.length - 1, i + 2)][2];
  console.log(`  ${(at / 1000).toFixed(1)}s  ${dt.toFixed(0)} ms  (+${((at - previous) / 1000).toFixed(1)}s)  heap ${heapBefore}->${heapAfter} MB${near.length ? '  console: ' + near.join(' | ') : ''}`);
  previous = at;
}
await browser.close();
