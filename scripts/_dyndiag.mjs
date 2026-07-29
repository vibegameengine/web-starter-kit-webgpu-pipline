// Isolates the mover's indirect light from its silhouette displacement.
//
// `scripts/_flicker.mjs` on a moving ball measures, overwhelmingly, the ball moving:
// with `?freezeAt=` the whole frame reads 0.02. So this pins the mover to a fixed pose,
// which makes the region comparable across builds, and reports both how much indirect
// light lands on it (mean luma) and what is left of the frame-to-frame noise.
//
// Usage: node scripts/_dyndiag.mjs "<url>" [warmMs] [shots] [gapMs] '[[name,x0,y0,x1,y1],...]'
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const url = process.argv[2];
const warm = Number(process.argv[3] || 40000);
const n = Number(process.argv[4] || 6);
const gap = Number(process.argv[5] || 100);
const regions = JSON.parse(process.argv[6] ?? '[["full",0,0,1280,800]]');

const browser = await chromium.launch({ channel:'chrome', headless:true,
  args:['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11','--enable-webgpu-developer-features','--no-sandbox'] });
const page = await browser.newPage({ viewport:{width:1280,height:800} });
const errs=[]; page.on('console', m=>{ if (m.type()==='error') errs.push(m.text()); });
page.on('pageerror', e=>errs.push('[pageerror] '+String(e).slice(0,200)));
await page.goto(url,{waitUntil:'domcontentloaded'});
await page.waitForTimeout(warm);

const shots=[];
for(let i=0;i<n;i++){ shots.push(PNG.sync.read(await page.screenshot())); await page.waitForTimeout(gap); }
const surfels = await page.evaluate(() => window.__surfels ? window.__surfels() : null);
await browser.close();

const luma = (p,x0,y0,x1,y1) => {
  let s=0,c=0;
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    const i=(y*p.width+x)*4;
    s += 0.2126*p.data[i] + 0.7152*p.data[i+1] + 0.0722*p.data[i+2]; c++;
  }
  return s/c;
};
console.log(url.split('?')[1]);
for (const [name,x0,y0,x1,y1] of regions){
  let sum=0,cnt=0;
  for(let k=1;k<shots.length;k++){
    const a=shots[k-1], b=shots[k]; let s=0,c=0;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
      const i=(y*a.width+x)*4;
      s+=(Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2]))/3; c++;
    }
    sum+=s/c; cnt++;
  }
  const l = shots.map(p=>luma(p,x0,y0,x1,y1));
  console.log(`  ${name.padEnd(8)} meanLuma ${(l.reduce((a,b)=>a+b,0)/l.length).toFixed(2)}  frame-to-frame ${(sum/cnt).toFixed(3)}`);
}
console.log('  surfels', JSON.stringify(surfels));
if (errs.length) console.log('  console errors:', errs.slice(0,5).join(' | '));
