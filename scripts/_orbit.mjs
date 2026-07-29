import { chromium } from 'playwright';
const browser = await chromium.launch({ channel:'chrome', headless:true,
  args:['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11','--enable-webgpu-developer-features','--no-sandbox'] });
const page = await browser.newPage({ viewport:{width:1280,height:800} });
await page.goto('http://127.0.0.1:5193/?hud=0&split=off&freezeAt=1.0&mover=0&bake=5000',{waitUntil:'domcontentloaded'});
await page.waitForTimeout(15000);
await page.mouse.move(640,400); await page.mouse.wheel(0,-900); await page.waitForTimeout(300);
await page.mouse.down();
for(let i=0;i<12;i++){ await page.mouse.move(640-i*8, 400+i*2); await page.waitForTimeout(16); }
await page.mouse.up();
await page.waitForTimeout(100);
await page.screenshot({path:'shots/critic/g-close-t0.png'});
await page.waitForTimeout(5000);
await page.screenshot({path:'shots/critic/g-close-t5s.png'});
await browser.close();
