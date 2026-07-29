import { chromium } from 'playwright';
const browser = await chromium.launch({ channel:'chrome', headless:true,
  args:['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11','--enable-webgpu-developer-features','--no-sandbox'] });
const page = await browser.newPage({ viewport:{width:1280,height:800} });
page.on('pageerror', e=>console.log('PAGEERROR', String(e)));
await page.goto('http://127.0.0.1:5193/?split=gi&freezeAt=1.0&mover=0&bake=5000',{waitUntil:'domcontentloaded'});
await page.waitForTimeout(16000);
console.log('probe before:', JSON.stringify(await page.evaluate(()=>window.__probe().lightCfg)));
console.log('surfels before:', JSON.stringify(await page.evaluate(()=>window.__surfels())));
await page.screenshot({path:'shots/critic/e-sun-before.png'});
// move the sun with the GUI: find the azimuth/elevation controllers
const names = await page.evaluate(()=>Object.keys(window.__probe().lightCfg));
console.log('lightCfg keys:', names.join(','));
await browser.close();
