// Dumps window.__probe() from a running build.
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i+1] ? args[i+1] : d; };
const url = flag('url', 'http://127.0.0.1:5188/');
const wait = Number(flag('wait', '16000'));
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11','--enable-webgpu-developer-features','--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(wait);
const probe = await page.evaluate(() => (window.__probe ? window.__probe() : null));
console.log(url);
console.log(JSON.stringify(probe, null, 1));
await browser.close();
