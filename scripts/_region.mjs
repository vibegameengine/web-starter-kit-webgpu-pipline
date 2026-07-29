import { PNG } from 'pngjs';
import fs from 'node:fs';
const a = PNG.sync.read(fs.readFileSync(process.argv[2]));
const b = PNG.sync.read(fs.readFileSync(process.argv[3]));
const regions = JSON.parse(process.argv[4]);
for (const [name, x0,y0,x1,y1] of regions) {
  let sa=[0,0,0], sb=[0,0,0], n=0;
  for (let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
    const i=(y*a.width+x)*4; n++;
    for(let c=0;c<3;c++){ sa[c]+=a.data[i+c]; sb[c]+=b.data[i+c]; }
  }
  const A=sa.map(v=>(v/n).toFixed(1)), B=sb.map(v=>(v/n).toFixed(1));
  const d=A.map((v,i)=>(v-B[i]).toFixed(1));
  console.log(`${name.padEnd(22)} A=[${A}] B=[${B}] delta=[${d}]`);
}
