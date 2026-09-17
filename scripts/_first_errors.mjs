import { chromium } from 'playwright';

const port = process.env.PORT ?? '5188';
const query = process.env.QUERY ?? 'scene=village-light';
const timer = setTimeout(() => { console.error('gate'); process.exit(2); }, 150000);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
let shown = 0;
page.on('console', (message) => {
  const text = message.text();
  if (!/error|invalid|warn/i.test(text) || shown >= Number(process.env.LIMIT ?? 3)) return;
  shown++;
  console.log(`---- ${message.type()}\n${text.slice(0, Number(process.env.CHARS ?? 3000))}`);
});
page.on('pageerror', (error) => console.log('pageerror:', String(error).slice(0, 1000)));
await page.goto(`http://127.0.0.1:${port}/?${query}`);
await page.waitForFunction(() => document.querySelector('#loading-overlay')?.hidden || !document.querySelector('#error-overlay')?.hidden, null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(3000);
clearTimeout(timer);
await browser.close();
