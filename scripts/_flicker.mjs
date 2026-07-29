// Frame-to-frame stability with the scene actually moving.
// Usage: node scripts/_flicker.mjs "<url>" [warmupMs] [frames] [gapMs]
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import fs from 'node:fs';
const url = process.argv[2], warm = Number(process.argv[3]??18000);
const n = Number(process.argv[4]??8), gap = Number(process.argv[5]??120);
const browser = await chromium.launch({ channel:'chrome', headless:true,
  args:['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--use-angle=d3d11','--enable-webgpu-developer-features','--no-sandbox'] });
const page = await browser.newPage({ viewport:{width:1280,height:800} });
await page.goto(url,{waitUntil:'domcontentloaded'}); await page.waitForTimeout(warm);
const shots=[];
for(let i=0;i<n;i++){ shots.push(PNG.sync.read(await page.screenshot())); await page.waitForTimeout(gap); }
await browser.close();
const regions = JSON.parse(process.argv[6] ?? '[["full",0,0,1280,800]]');
for (const [name,x0,y0,x1,y1] of regions){
  let worst=0, sum=0, cnt=0;
  for(let k=1;k<shots.length;k++){
    const a=shots[k-1], b=shots[k]; let s=0,c=0;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
      const i=(y*a.width+x)*4;
      s+=(Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2]))/3; c++;
    }
    const m=s/c; sum+=m; cnt++; if(m>worst)worst=m;
  }
  console.log(`${name.padEnd(22)} mean frame-to-frame ${(sum/cnt).toFixed(2)}  worst ${worst.toFixed(2)}`);
}
fs.writeFileSync('shots/flicker/f0.png', PNG.sync.write(shots[0]));
fs.writeFileSync('shots/flicker/f1.png', PNG.sync.write(shots[1]));
