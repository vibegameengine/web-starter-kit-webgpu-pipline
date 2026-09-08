// Stair-step count (horizontal luma step > 48) in the frond region on a still scene,
// per TAA configuration (headed). node scripts/_taa_steps_probe.mjs
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const luma = (img, x, y) => { const p = (y * img.width + x) * 4; return 0.2126 * img.data[p] + 0.7152 * img.data[p + 1] + 0.0722 * img.data[p + 2]; };
const steps = (img) => { let n = 0; for (let y = 100; y < 500; y++) for (let x = 401; x < 1300; x++) if (Math.abs(luma(img, x, y) - luma(img, x - 1, y)) > 48) n++; return n; };
for (const [label, q] of [['taa history0.9 explicit', '&taaHistory=0.9'], ['taa default A', ''], ['taa history0.97', '&taaHistory=0.97'], ['taa default B', ''], ['taa default gputime', '&gputime=1'], ['none', '&aa=none'], ['fxaa', '&aa=fxaa']]) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&still=1&grain=0&exposure=1&cam=leaves${q}`);
  await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
  await page.waitForTimeout(3500);
  const img = PNG.sync.read(await page.screenshot());
  console.log(label, 'steps', steps(img));
  await page.close();
}
await browser.close();
