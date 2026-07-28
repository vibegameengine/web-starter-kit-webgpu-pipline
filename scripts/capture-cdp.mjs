// Capture via a REAL headed browser (WebGPU works) driven by Playwright over CDP.
// 1. launch: start msedge --remote-debugging-port=9222 <url>
// 2. this script connects to it and screenshots the page content.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const out = resolve(args.find((a) => !a.startsWith('--')) ?? 'shots/cdp.png');
const port = flag('port', '9222');
const wait = Number(flag('wait', '6000'));
mkdirSync(resolve(out, '..'), { recursive: true });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0];
const pages = ctx.pages();
const page = pages.find((p) => p.url().includes('127.0.0.1:5188')) || pages[0];

await page.waitForTimeout(wait);
const perf = await page.evaluate(() => (window.__perf ? { ...window.__perf } : null));
await page.screenshot({ path: out });
console.log('perf:', JSON.stringify(perf));
console.log('saved', out);
await browser.close();
