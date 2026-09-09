import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('pageerror', String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('console', m.text().slice(0, 900)); });
const test = process.argv[2] ?? '1';
await page.goto(`http://127.0.0.1:5188/?scene=beach&hud=0&mode=surfel&bake=0&sprayTest=${test}`);
await page.waitForFunction(() => !!window.__lagoon && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 180000 });
for (const wait of [1000, 800, 800, 800, 800, 800]) {
  await page.waitForTimeout(wait);
  console.log(JSON.stringify(await page.evaluate(() => window.__lagoon.sprayStats())));
}
await browser.close();
