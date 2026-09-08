// GPU ms of the beach frame at `?cam=rocks&still=1` for several contact-occlusion
// settings, each a separate boot: node scripts/_contact_cost.mjs (headed, always).
import { chromium } from 'playwright';
const variants = { off: '&contact=0', 'q1 (0.25x1)': '&contact=1&contactScale=0.25&contactRays=1', 'h1 (0.5x1)': '&contact=1&contactScale=0.5&contactRays=1', 'h2 (0.5x2)': '&contact=1&contactScale=0.5&contactRays=2' };
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
for (const [name, q] of Object.entries(variants)) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&still=1&gputime=1&cam=rocks${q}`);
  await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
  await page.waitForTimeout(2500);
  const samples = [];
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(40); samples.push(await page.evaluate(async () => { const t = await window.__gpuTime(); return [(t.render ?? 0), (t.compute ?? 0)]; })); }
  const r = samples.map(s => s[0]).sort((a, b) => a - b), c = samples.map(s => s[1]).sort((a, b) => a - b);
  console.log(name, 'render median', r[20].toFixed(2), 'compute median', c[20].toFixed(2), 'compute p95', c[38].toFixed(2));
  await page.close();
}
await browser.close();
