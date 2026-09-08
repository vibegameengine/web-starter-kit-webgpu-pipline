// node scripts/_console.mjs "<url>" — boot, wait for ready, print deduped console errors/warnings.
import { chromium } from 'playwright';
const url = process.argv[2];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const seen = new Map();
page.on('console', m => { if (m.type()==='error'||m.type()==='warning') { const k=m.type()+': '+m.text().slice(0,160); seen.set(k,(seen.get(k)??0)+1); } });
page.on('pageerror', e => { const k='pageerror: '+String(e).slice(0,200); seen.set(k,(seen.get(k)??0)+1); });
await page.goto(url);
await page.waitForFunction(() => document.querySelector('#loading-overlay')?.hidden || !document.querySelector('#error-overlay')?.hidden, null, { timeout: 180000 }).catch(()=>{});
await page.waitForTimeout(3000);
for (const [k,v] of seen) console.log(v, k);
console.log('done', url);
await browser.close();
