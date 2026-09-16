import { chromium } from 'playwright';

const port = process.env.PORT ?? '5188';
const query = process.env.QUERY ?? 'scene=midsee-village';
const gate = Number(process.env.GATE_MS ?? 200000);
const timer = setTimeout(() => { console.error('gate'); process.exit(2); }, gate);

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
const notes = [];
page.on('console', (message) => {
  const text = message.text();
  if (text.includes('[sun') || text.includes('sunIntensity') || text.includes('[env')) notes.push(text.slice(0, 200));
});
page.on('pageerror', (error) => console.error('pageerror:', String(error).slice(0, 200)));
await page.goto(`http://127.0.0.1:${port}/?${query}`);
await page.waitForFunction(() => document.querySelector('#loading-overlay')?.hidden || !document.querySelector('#error-overlay')?.hidden, null, { timeout: gate - 20000 }).catch(() => {});
await page.waitForTimeout(4000);
console.log(query);
for (const wait of [0, 10000, 20000, 30000]) {
  if (wait) await page.waitForTimeout(wait);
  const probe = await page.evaluate(() => (window.__probe ? window.__probe() : null));
  console.log(`  t+${(wait / 1000).toFixed(0)}s intensity ${probe?.sunIntensity?.toFixed(4)} cfg ${probe?.lightCfg?.intensity?.toFixed(4)}`);
}
for (const note of notes) console.log('  ', note);
clearTimeout(timer);
await browser.close();
