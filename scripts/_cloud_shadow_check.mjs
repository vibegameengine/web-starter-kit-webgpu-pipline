import { chromium } from 'playwright';
const port = process.env.PORT ?? '5188';
const out = process.env.OUT ?? 'shots/cloudshadow';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${port}/?scene=sky&hud=0&bakeCache=0&sunAz=-60&sunEl=55&cloudCoverage=0.55`);
const ok = await page.waitForFunction(() => window.__sky && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 150000 }).then(() => true).catch(() => false);
if (!ok || errors.length) { console.log('FAIL boot', errors.slice(0, 4)); await browser.close(); process.exit(1); }
await page.evaluate(() => { window.__camera(0, 38, 26, 0, 0, -2); window.__sky.clouds.windSpeedKmPerMinute = 6; window.__sky.clouds.shapeScaleKm = 1.2; window.__sky.clouds.detailScaleKm = 0.15; });
for (let shot = 0; shot < 3; shot++) {
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/overhead-${shot}.png` });
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close();
