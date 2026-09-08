// Frame-synced TAA stability: reads the resolved TAA texture on consecutive animation
// frames of a still scene and reports the mean absolute difference (headed).
import { chromium } from 'playwright';
const q = process.argv[2] ?? '';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const still = q.includes('still=0') ? '' : '&still=1';
await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0${still}&cam=leaves&grain=0&exposure=1&contact=0&reflections=0&gi=0${q.replace('&still=0', '')}`);
await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
await page.waitForTimeout(4000);
const r = await page.evaluate(async () => {
  const out = [];
  let prev = (await window.__fog.taaFrame()).data;
  for (let i = 0; i < 12; i++) {
    await new Promise((res) => requestAnimationFrame(res));
    const cur = (await window.__fog.taaFrame()).data;
    let s = 0, n = 0; for (let k = 0; k < cur.length; k += 4) { for (let c = 0; c < 3; c++) s += Math.abs(cur[k + c] - prev[k + c]); n += 3; }
    out.push((s / n * 255).toFixed(2)); prev = cur;
  }
  return out;
});
console.log('taa frame-to-frame (x255)', q, r.join(' '));
await browser.close();
