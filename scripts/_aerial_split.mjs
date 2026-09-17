import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 675 } });
const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' || /warn/i.test(m.type())) errors.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
await page.goto(`http://127.0.0.1:${process.env.PORT}/?scene=sky&cam=horizon&hud=0&bakeCache=0&clouds=0&sunAz=-60&sunEl=25&aerialScale=0`);
const ok = await page.waitForFunction(() => window.__sky && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 150000 }).then(() => true).catch(() => false);
if (!ok) { console.log('boot fail', errors.slice(0, 5)); await browser.close(); process.exit(1); }
await page.waitForTimeout(3000);
await page.screenshot({ path: 'shots/aerial/split-hook-and-compute.png' });
await page.evaluate(() => { window.__sky.settings.aerialPerspective = false; });
await page.waitForTimeout(4000);
await page.screenshot({ path: 'shots/aerial/split-hook-only.png' });
console.log(errors.slice(0, 8).join('\n'));
await browser.close();
