// Memory/GPU trend of one beach session over 25 s (headed, always). node scripts/_leak_probe.mjs [query]
import { chromium } from 'playwright';
const q = process.argv[2] ?? '';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&gputime=1&cam=rocks${q}`);
await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
for (let t = 0; t <= 25; t += 5) {
  const r = await page.evaluate(async () => {
    const frames = [];
    for (let i = 0; i < 30; i++) { await new Promise((res) => requestAnimationFrame(res)); const g = await window.__gpuTime(); frames.push((g.render ?? 0) + (g.compute ?? 0)); }
    frames.sort((a, b) => a - b);
    return { gpuMs: +frames[15].toFixed(2), heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1), memory: window.__fog.memory() };
  });
  console.log(`t=${t}s`, JSON.stringify(r));
  await page.waitForTimeout(4000);
}
await browser.close();
