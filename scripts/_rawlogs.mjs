import { chromium } from 'playwright';
const url = process.argv[2];
const browser = await chromium.launch({ channel:'chrome', headless:true,
  args:['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11','--enable-webgpu-developer-features','--no-sandbox'] });
const page = await browser.newPage({ viewport:{width:1280,height:800} });
const logs=[]; page.on('console', m=>logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e=>logs.push('[pageerror] '+String(e).slice(0,2000)));
await page.goto(url,{waitUntil:'domcontentloaded'});
await page.waitForTimeout(Number(process.argv[3]||30000));
const pat = process.argv[4] ? new RegExp(process.argv[4],'i') : null;
console.log((pat?logs.filter(l=>pat.test(l)):logs).join('\n').slice(0, 20000));
await browser.close();
