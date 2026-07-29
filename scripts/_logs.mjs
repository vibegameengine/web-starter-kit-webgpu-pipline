import { chromium } from 'playwright';
const url = process.argv[2];
const browser = await chromium.launch({ channel:'chrome', headless:true,
  args:['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11','--enable-webgpu-developer-features','--no-sandbox'] });
const page = await browser.newPage({ viewport:{width:1280,height:800} });
const logs=[]; page.on('console', m=>logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e=>logs.push('[pageerror] '+String(e).slice(0,300)));
await page.goto(url,{waitUntil:'domcontentloaded'});
await page.waitForTimeout(Number(process.argv[3]||30000));
console.log(logs.filter(l=>/BVH|instanc|tri|budget|error|lightmap|surfel|probe|scale|Error/i.test(l)).join('\n'));
await browser.close();
