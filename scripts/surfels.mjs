// Reads window.__surfels() at two points in time to tell a cache from a rebuild.
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i+1] ? args[i+1] : d; };
const url = flag('url', 'http://127.0.0.1:5188/');
const t1 = Number(flag('t1', '20000'));
const t2 = Number(flag('t2', '40000'));
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11','--enable-webgpu-developer-features','--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('  ! ' + String(e).slice(0,160)));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(t1);
const a = await page.evaluate(() => (window.__surfels ? window.__surfels() : null));
console.log(`t=${t1/1000}s `, JSON.stringify(a));
await page.waitForTimeout(t2 - t1);
const b = await page.evaluate(() => (window.__surfels ? window.__surfels() : null));
console.log(`t=${t2/1000}s `, JSON.stringify(b));
await browser.close();
