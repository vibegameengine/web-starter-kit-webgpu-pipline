// node scripts/_zoom.mjs in.png out.png x y w h [scale]
import { PNG } from 'pngjs';
import fs from 'node:fs';
const [inp, outp, X, Y, W, H, S = '4'] = process.argv.slice(2);
const x = +X, y = +Y, w = +W, h = +H, s = +S;
const src = PNG.sync.read(fs.readFileSync(inp));
const dst = new PNG({ width: w * s, height: h * s });
for (let j = 0; j < h * s; j++)
  for (let i = 0; i < w * s; i++) {
    const si = (((y + Math.floor(j / s)) * src.width) + (x + Math.floor(i / s))) * 4;
    const di = (j * dst.width + i) * 4;
    dst.data[di] = src.data[si];
    dst.data[di + 1] = src.data[si + 1];
    dst.data[di + 2] = src.data[si + 2];
    dst.data[di + 3] = 255;
  }
fs.writeFileSync(outp, PNG.sync.write(dst));
console.log('wrote', outp, dst.width + 'x' + dst.height);
