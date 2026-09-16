import { chromium } from 'playwright';

const port = process.env.PORT ?? '5188';
const scene = process.env.SCENE ?? 'beach';
const gate = Number(process.env.GATE_MS ?? 120000);
const timer = setTimeout(() => { console.error('gate'); process.exit(2); }, gate);

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const lines = [];
page.on('console', (message) => {
  const text = message.text();
  if (text.includes('[lightmap]') || text.includes('[bake') || text.includes('[BVH')) lines.push(text);
});
page.on('pageerror', (error) => { console.error('pageerror:', String(error).slice(0, 200)); });
await page.goto(`http://127.0.0.1:${port}/?scene=${scene}&hud=0`);
await page.waitForFunction(() => document.querySelector('#loading-overlay')?.hidden || !document.querySelector('#error-overlay')?.hidden, null, { timeout: gate - 20000 }).catch(() => {});
await page.waitForTimeout(3000);
for (const line of lines) console.log(line);
clearTimeout(timer);
await browser.close();
