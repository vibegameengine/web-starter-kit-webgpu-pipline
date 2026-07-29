// node scripts/_px.mjs img.png x,y x,y ...   -> prints rgb (3x3 mean) at each point
import { PNG } from 'pngjs';
import fs from 'node:fs';
const p = PNG.sync.read(fs.readFileSync(process.argv[2]));
for (const arg of process.argv.slice(3)) {
  const [x, y] = arg.split(',').map(Number);
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const i = ((y + dy) * p.width + (x + dx)) * 4;
    r += p.data[i]; g += p.data[i + 1]; b += p.data[i + 2]; n++;
  }
  const R = r / n, G = g / n, B = b / n;
  console.log(`${arg}\t${R.toFixed(1)}/${G.toFixed(1)}/${B.toFixed(1)}\tluma ${((R + G + B) / 3).toFixed(1)}`);
}
