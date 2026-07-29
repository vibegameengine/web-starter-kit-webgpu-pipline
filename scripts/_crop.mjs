import { PNG } from 'pngjs'; import fs from 'node:fs';
const [,,src,dst,X,Y,W,H,S] = process.argv;
const a = PNG.sync.read(fs.readFileSync(src));
const s=Number(S||3), w=Number(W), h=Number(H), x0=Number(X), y0=Number(Y);
const o = new PNG({width:w*s, height:h*s});
for(let y=0;y<h*s;y++)for(let x=0;x<w*s;x++){
  const si=(((y0+Math.floor(y/s))*a.width)+(x0+Math.floor(x/s)))*4, di=(y*w*s+x)*4;
  for(let c=0;c<4;c++) o.data[di+c]=a.data[si+c];
}
fs.writeFileSync(dst, PNG.sync.write(o));
