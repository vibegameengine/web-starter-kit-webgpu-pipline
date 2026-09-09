// Chrome tracing around the frame spikes: records the browser's own timeline and
// prints every event longer than 8 ms, grouped by name, so a stall has a name
// instead of a guess. Headed; the trace stays in memory and only aggregates print.
//
//   node scripts/_trace_spikes.mjs [seconds] [query]
import { chromium } from 'playwright';
const seconds = Number(process.argv[2] ?? 40);
setTimeout(() => { console.error('gate hit, abort'); process.exit(2); }, (seconds + 120) * 1000);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0${process.argv[3] ?? ''}`);
await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 150000 });
await page.evaluate(() => new Promise((r) => { let last = performance.now(), run = 0; const f = () => { const t = performance.now(); run = t - last < 500 ? run + 1 : 0; last = t; if (run >= 30) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));

const cdp = await page.context().newCDPSession(page);
const events = [];
const creates = [];
cdp.on('Tracing.dataCollected', ({ value }) => { for (const e of value) { if (e.dur > 4000) events.push(e); if (/Pipeline|Shader|Compile|CreateBuffer|CreateTexture|Device|Queue/i.test(e.name)) creates.push(e); } });
const done = new Promise((resolve) => cdp.on('Tracing.tracingComplete', resolve));
await cdp.send('Tracing.start', {
  traceConfig: { includedCategories: ['gpu', 'toplevel', 'disabled-by-default-gpu.service', 'disabled-by-default-gpu.device', 'disabled-by-default-gpu.decoder', 'disabled-by-default-devtools.timeline.frame'] },
  transferMode: 'ReportEvents',
});
await page.evaluate((sec) => new Promise((r) => { const t0 = performance.now(); const f = () => (performance.now() - t0 < sec * 1000 ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); }), seconds);
await cdp.send('Tracing.end');
await done;

const byName = new Map();
for (const e of events) {
  const k = `${e.name} [${e.cat.split(',')[0]}]`;
  const a = byName.get(k) ?? { count: 0, total: 0, max: 0 };
  a.count++; a.total += e.dur / 1000; a.max = Math.max(a.max, e.dur / 1000);
  byName.set(k, a);
}
console.log(`${events.length} events over 8 ms in ${seconds}s`);
for (const [name, a] of [...byName].sort((x, y) => y[1].max - x[1].max).slice(0, 18)) {
  console.log(`  max ${a.max.toFixed(1).padStart(6)} ms  n=${String(a.count).padStart(4)}  total ${a.total.toFixed(0).padStart(5)} ms  ${name}`);
}
const byCreate = new Map();
for (const e of creates) {
  const a = byCreate.get(e.name) ?? { count: 0, total: 0, max: 0 };
  a.count++; a.total += (e.dur ?? 0) / 1000; a.max = Math.max(a.max, (e.dur ?? 0) / 1000);
  byCreate.set(e.name, a);
}
console.log('--- resource creation and shader work');
for (const [name, a] of [...byCreate].sort((x, y) => y[1].total - x[1].total).slice(0, 14)) {
  console.log(`  n=${String(a.count).padStart(5)}  total ${a.total.toFixed(1).padStart(7)} ms  max ${a.max.toFixed(1).padStart(6)} ms  ${name}`);
}
await browser.close();
