// Contact sheet: node scripts/_sheet.mjs out.png a.png b.png ... [--cols 2] [--w 800] [--gain 1]
import { PNG } from 'pngjs'; import fs from 'node:fs';
const args = process.argv.slice(2); const flag=(n,d)=>{const i=args.indexOf('--'+n);return i>=0?args[i+1]:d;};
const files = args.filter((a,i)=>!a.startsWith('--') && !(i>0 && args[i-1].startsWith('--')));
const out = files.shift(); const cols = Number(flag('cols',2)); const w = Number(flag('w',800)); const gain=Number(flag('gain',1));
const imgs = files.map(f=>PNG.sync.read(fs.readFileSync(f)));
const h = Math.round(w*imgs[0].height/imgs[0].width); const rows=Math.ceil(imgs.length/cols);
const sheet = new PNG({width: w*cols, height: h*rows});
imgs.forEach((img,n)=>{const ox=(n%cols)*w, oy=Math.floor(n/cols)*h; const sx=img.width/w, sy=img.height/h;
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const si=((Math.floor(y*sy))*img.width+Math.floor(x*sx))*4, di=((oy+y)*sheet.width+ox+x)*4;
  for(let c=0;c<3;c++) sheet.data[di+c]=Math.min(255,img.data[si+c]*gain); sheet.data[di+3]=255;}});
fs.writeFileSync(out, PNG.sync.write(sheet)); console.log('sheet', out, sheet.width, sheet.height);
