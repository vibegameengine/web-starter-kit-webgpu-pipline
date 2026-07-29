import { chromium } from 'playwright';
const browser = await chromium.launch({ channel:'chrome', headless:true,
  args:['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11','--enable-webgpu-developer-features','--no-sandbox'] });
for (const q of ['?hud=0&freezeAt=1.0&mover=0&bake=5000','?hud=0&freezeAt=1.0&mover=0&bake=5000&freezeAll=1']) {
  const page = await browser.newPage({ viewport:{width:1280,height:800} });
  await page.goto('http://127.0.0.1:5193/'+q,{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(15000);
  const s1 = await page.evaluate(()=>window.__surfels());
  await page.waitForTimeout(9000);
  const s2 = await page.evaluate(()=>window.__surfels());
  const ft = await page.evaluate(()=>new Promise(res=>{
    const t=[]; let last=performance.now(); let n=0;
    const tick=()=>{const now=performance.now(); t.push(now-last); last=now; if(++n<180) requestAnimationFrame(tick);
      else {t.sort((a,b)=>a-b); res({median:t[90].toFixed(2), p95:t[171].toFixed(2)});}};
    requestAnimationFrame(tick);
  }));
  console.log(q, '\n  t=15s', JSON.stringify(s1), '\n  t=24s', JSON.stringify(s2), '\n  frameMs', JSON.stringify(ft));
  await page.close();
}
await browser.close();
