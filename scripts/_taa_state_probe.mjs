import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://127.0.0.1:5188/?scene=beach&hud=0&freezeAt=0&still=1&cam=leaves&grain=0&exposure=1&contact=0&reflections=0&gi=0');
await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
await page.waitForTimeout(3000);
const r = await page.evaluate(async () => {
  const states = [];
  for (let i = 0; i < 4; i++) { await new Promise((res) => requestAnimationFrame(res)); states.push(window.__fog.taaState()); }
  const v = (await window.__fog.velocityFrame()).data;
  let sx = 0, sy = 0, mx = 0, n = 0; for (let k = 0; k < v.length; k += 4) { sx += Math.abs(v[k]); sy += Math.abs(v[k + 1]); mx = Math.max(mx, Math.abs(v[k]), Math.abs(v[k + 1])); n++; }
  return { states, velocity: { meanAbsX: sx / n, meanAbsY: sy / n, maxAbs: mx, pixels: n } };
});
console.log(JSON.stringify(r));
await browser.close();
