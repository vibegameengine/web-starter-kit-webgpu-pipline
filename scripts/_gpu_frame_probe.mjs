// Per-frame GPU ms (headed, always): resolves the timestamp pool every animation
// frame so nothing accumulates across frames. node scripts/_gpu_frame_probe.mjs
import { chromium } from 'playwright';
const variants = { off: '&contact=0', 'q1 (0.25x1)': '&contact=1&contactScale=0.25&contactRays=1', 'h1 (0.5x1)': '&contact=1&contactScale=0.5&contactRays=1' };
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
for (const [name, q] of Object.entries(variants)) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&still=1&gputime=1&cam=rocks${q}`);
  await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
  await page.waitForTimeout(3000);
  const r = await page.evaluate(async () => {
    const frames = [];
    for (let i = 0; i < 150; i++) {
      await new Promise((res) => requestAnimationFrame(res));
      const t = await window.__gpuTime();
      frames.push([t.render ?? 0, t.compute ?? 0]);
    }
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    return { render: med(frames.map(f => f[0])), compute: med(frames.map(f => f[1])), total: med(frames.map(f => f[0] + f[1])) };
  });
  console.log(name, JSON.stringify(r));
  await page.close();
}
await browser.close();
