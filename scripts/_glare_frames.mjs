// Full headed frames of the default beach view: as shipped, with manual exposure,
// with the glare strength the user first saw (before it was lowered), and glare off.
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
for (const [name, q] of [['r0.35s0.18', '&glareRadius=0.35&glareStrength=0.18'], ['r0.5s0.25', '&glareRadius=0.5&glareStrength=0.25'], ['r0.25s0.3', '&glareRadius=0.25&glareStrength=0.3']]) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0${q}`);
  await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
  await page.waitForTimeout(5000);
  const e = await page.evaluate(async () => ({ exposure: await window.__fog.exposure?.(), glare: window.__fog.glare(), grain: window.__fog.grain?.() }));
  await page.screenshot({ path: `shots/glare/${name}.png` });
  console.log(name, JSON.stringify(e));
  await page.close();
}
await browser.close();
