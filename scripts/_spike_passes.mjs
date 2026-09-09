// Which pass grows on a spike frame. Reads three's inspector per frame instead of
// taking a median, finds the frames whose GPU total is well above the median, and
// prints their per-pass breakdown against the median frame. Headed, `?gputime=1`.
//
//   node scripts/_spike_passes.mjs [seconds] [query]
import { chromium } from 'playwright';
const seconds = Number(process.argv[2] ?? 60);
setTimeout(() => { console.error('gate hit, abort'); process.exit(2); }, (seconds + 120) * 1000);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&gputime=1${process.argv[3] ?? ''}`);
await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 150000 });
await page.evaluate(() => new Promise((r) => { let last = performance.now(), run = 0; const f = () => { const t = performance.now(); run = t - last < 500 ? run + 1 : 0; last = t; if (run >= 30) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));

const data = await page.evaluate(async (sec) => {
  const inspector = window.__fog.frameGraph().renderer.inspector;
  const first = inspector.frames.length ? inspector.frames[inspector.frames.length - 1].frameId + 1 : 0;
  const t0 = performance.now();
  while (performance.now() - t0 < sec * 1000) {
    await new Promise((r) => requestAnimationFrame(r));
    await inspector.resolveTimestamp();
  }
  await inspector.resolveTimestamp();
  const label = (s) => s.isComputeStats ? `compute ${s.name || '(unnamed)'}`
    : `${s.name} -> ${s.renderTarget ? `${s.renderTarget.texture?.name || s.renderTarget.textures?.[0]?.name || 'rt'} ${s.renderTarget.width}x${s.renderTarget.height}` : 'screen'}`;
  const out = [];
  for (const f of inspector.frames) {
    if (f.frameId < first || !f.resolvedRender || !f.resolvedCompute) continue;
    const passes = {};
    let total = 0;
    for (const s of [...f.renders, ...f.computes]) { const k = label(s); passes[k] = (passes[k] ?? 0) + s.gpu; total += s.gpu; }
    out.push({ total, delta: f.deltaTime, passes });
  }
  return out;
}, seconds);

const totals = data.map((f) => f.total).sort((a, b) => a - b);
const median = totals[totals.length >> 1];
const medianFrame = data.find((f) => Math.abs(f.total - median) < 0.2) ?? data[0];
const spikes = data.filter((f) => f.total > median * 1.6).sort((a, b) => b.total - a.total).slice(0, 4);
console.log(`${data.length} resolved frames, median GPU ${median.toFixed(2)} ms, ${data.filter((f) => f.total > median * 1.6).length} frames above 1.6x`);
for (const s of spikes) {
  console.log(`\n  spike: GPU ${s.total.toFixed(2)} ms (frame interval ${s.delta.toFixed(1)} ms)`);
  const names = [...new Set([...Object.keys(s.passes), ...Object.keys(medianFrame.passes)])];
  for (const n of names.map((n) => [n, (s.passes[n] ?? 0) - (medianFrame.passes[n] ?? 0)]).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`    +${n[1].toFixed(2).padStart(6)} ms  ${(s.passes[n[0]] ?? 0).toFixed(2)} vs ${(medianFrame.passes[n[0]] ?? 0).toFixed(2)}  ${n[0]}`);
  }
}
await browser.close();
