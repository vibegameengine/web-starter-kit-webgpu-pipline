import { chromium } from 'playwright';
import { bootOrFail } from './_harness.mjs';

const port = process.env.PORT ?? '5188';
const query = process.env.QUERY ?? 'scene=midsee-village&hud=1';
const timer = setTimeout(() => { console.error('gate'); process.exit(2); }, 240000);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (error) => { console.error('pageerror:', String(error).slice(0, 300)); process.exit(3); });
await page.goto(`http://127.0.0.1:${port}/?${query}`);
await bootOrFail(page, 200000);
await page.evaluate(() => new Promise((resolve) => { let n = 0; const tick = () => (++n > 400 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }));
for (const row of await page.evaluate(() => window.__drawCounts(30))) console.log(JSON.stringify(row));
clearTimeout(timer);
await browser.close();
