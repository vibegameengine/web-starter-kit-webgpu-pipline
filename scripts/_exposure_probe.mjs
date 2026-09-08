// Exposure value and frame-to-frame difference over time (headed). node scripts/_exposure_probe.mjs [query]
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
const q = process.argv[2] ?? '';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&still=1&cam=leaves&grain=0${q}`);
await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
const diff = (x, y) => { let s = 0, n = 0; for (let i = 0; i < x.data.length; i += 4) { for (let k = 0; k < 3; k++) s += Math.abs(x.data[i + k] - y.data[i + k]); n += 3; } return (s / n).toFixed(2); };
for (let t = 0; t < 8; t++) {
  const vals = [];
  for (let i = 0; i < 6; i++) { vals.push((await page.evaluate(() => window.__fog.exposure())).toFixed(3)); await page.waitForTimeout(30); }
  const a = PNG.sync.read(await page.screenshot()); await page.waitForTimeout(30); const b = PNG.sync.read(await page.screenshot());
  console.log(`t=${t}s exposure`, vals.join(' '), 'frame diff', diff(a, b));
  await page.waitForTimeout(700);
}
await browser.close();
