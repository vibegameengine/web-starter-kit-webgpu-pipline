import { PNG } from 'pngjs';
import fs from 'node:fs';
const a = PNG.sync.read(fs.readFileSync(process.argv[2]));
const b = PNG.sync.read(fs.readFileSync(process.argv[3]));
let n=0, maxd=0, sum=0; let box=[1e9,1e9,-1,-1];
for (let y=0;y<a.height;y++) for(let x=0;x<a.width;x++){
  const i=(y*a.width+x)*4;
  const d=Math.max(Math.abs(a.data[i]-b.data[i]),Math.abs(a.data[i+1]-b.data[i+1]),Math.abs(a.data[i+2]-b.data[i+2]));
  if(d>3){n++;sum+=d;if(d>maxd)maxd=d;
    if(x<box[0])box[0]=x; if(y<box[1])box[1]=y; if(x>box[2])box[2]=x; if(y>box[3])box[3]=y;}
}
console.log(JSON.stringify({diffPixels:n, pct:(100*n/(a.width*a.height)).toFixed(3), maxDelta:maxd, meanDelta:(sum/Math.max(1,n)).toFixed(2), bbox:box}));
