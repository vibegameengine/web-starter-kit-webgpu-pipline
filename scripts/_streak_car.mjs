import { chromium } from 'playwright';
const port = process.env.PORT ?? '5294';
const out = process.env.OUT ?? 'shots/streaks';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1480, height: 840 } });
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/?scene=car&bakeCache&groundSize=200&hud=0`);
const ok = await page.waitForFunction(() => window.__sky && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 170000 }).then(() => true).catch(() => false);
if (!ok) { console.log('boot fail', errors.slice(0, 3)); await browser.close(); process.exit(1); }
await page.waitForTimeout(4000);
await page.screenshot({ path: `${out}/${process.env.TAG ?? 'car'}-history.png` });
await page.evaluate(() => { window.__sky.clouds.historyWeight = 0; });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/${process.env.TAG ?? 'car'}-nohistory.png` });
console.log('camera', JSON.stringify(await page.evaluate(() => window.__probe?.())));
await browser.close();
