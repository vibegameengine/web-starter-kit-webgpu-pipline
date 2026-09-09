import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('pageerror', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:5188/?scene=beach&hud=0&mode=surfel&bake=0');
await page.waitForFunction(() => !!window.__lagoon && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 120000 });
for (const wait of [1000, 4000, 8000]) {
  await page.waitForTimeout(wait);
  console.log(JSON.stringify(await page.evaluate(() => window.__lagoon.simStats())));
}
await browser.close();
