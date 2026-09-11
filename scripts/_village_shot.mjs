import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const port = process.env.PORT ?? '5188';
const query = process.env.QUERY ?? '';
const out = process.argv[2] ?? 'shots/village.png';
await mkdir(out.slice(0, out.lastIndexOf('/')), { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
let fatal = null;
page.on('pageerror', (e) => { fatal ??= String(e); });
await page.goto(`http://127.0.0.1:${port}/?scene=midsee-village&hud=0${query}`);
const booted = await page.waitForFunction(() => window.__fog && document.querySelector('#loading-overlay')?.hidden, null, { timeout: 150000 }).then(() => true).catch(() => false);
if (!booted) { console.error('boot failed', fatal ?? 'timeout'); await browser.close(); process.exit(1); }
await page.waitForTimeout(6000);
await page.screenshot({ path: out });
console.log('shot', out, fatal ? `(pageerror ${fatal})` : '');
await browser.close();
