import { PNG } from 'pngjs'; import fs from 'node:fs';
const a=PNG.sync.read(fs.readFileSync(process.argv[2])), b=PNG.sync.read(fs.readFileSync(process.argv[3]));
const B=32, gw=Math.ceil(a.width/B), gh=Math.ceil(a.height/B); const acc=new Float64Array(gw*gh), cnt=new Float64Array(gw*gh);
for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){const i=(y*a.width+x)*4;
 const d=(Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2]))/3;
 const g=Math.floor(y/B)*gw+Math.floor(x/B); acc[g]+=d; cnt[g]++;}
const arr=[...acc].map((v,i)=>({v:v/cnt[i], x:(i%gw)*B, y:Math.floor(i/gw)*B})).sort((p,q)=>q.v-p.v).slice(0,8);
console.log(arr.map(o=>`(${o.x},${o.y}) mean=${o.v.toFixed(1)}`).join('  '));
