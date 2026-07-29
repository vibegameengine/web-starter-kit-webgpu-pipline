// Amplified difference image: |A-B| * gain, so an ablation's footprint can be *seen*
// rather than inferred from a bounding box. A bbox over a noisy frame is almost always
// the whole frame; a picture of the difference is not.
// Usage: node scripts/_diffmap.mjs A.png B.png OUT.png [gain]
import { PNG } from 'pngjs';
import fs from 'node:fs';
const a = PNG.sync.read(fs.readFileSync(process.argv[2]));
const b = PNG.sync.read(fs.readFileSync(process.argv[3]));
const gain = Number(process.argv[5] ?? 6);
const o = new PNG({ width: a.width, height: a.height });
for (let i = 0; i < a.data.length; i += 4) {
  for (let c = 0; c < 3; c++) {
    o.data[i + c] = Math.min(255, Math.abs(a.data[i + c] - b.data[i + c]) * gain);
  }
  o.data[i + 3] = 255;
}
fs.writeFileSync(process.argv[4], PNG.sync.write(o));
console.log(`wrote ${process.argv[4]} gain=${gain}`);
