// Opens a real Chrome window on the running build and leaves it open.
// The capture script closes the browser as soon as it has its PNG, which is no use
// when the point is to look at the thing yourself.
//   node scripts/open.mjs --url "http://127.0.0.1:5188/?mode=lightmap"
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i+1] ? args[i+1] : d; };
const url = flag('url', 'http://127.0.0.1:5188/');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer,WebGPUService',
    '--ignore-gpu-blocklist',
    '--use-angle=d3d11',
    '--enable-webgpu-developer-features',
    '--no-sandbox',
    '--start-maximized',
  ],
});
const page = await browser.newPage({ viewport: null });
page.on('console', (m) => { if (m.type() === 'error') console.log('  ! ' + m.text().slice(0,200)); });
page.on('pageerror', (e) => console.log('  ! ' + String(e).slice(0,200)));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
console.log(`window open on ${url} — close it to end this process`);
await page.waitForEvent('close', { timeout: 0 });
await browser.close();
