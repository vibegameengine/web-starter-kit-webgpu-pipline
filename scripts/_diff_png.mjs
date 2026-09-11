import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';
const [aPath, bPath, outPath] = process.argv.slice(2);
const a = PNG.sync.read(readFileSync(aPath)), b = PNG.sync.read(readFileSync(bPath));
const out = new PNG({ width: a.width, height: a.height });
const rows = new Array(a.height).fill(0), cols = new Array(a.width).fill(0);
for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
  const i = (y * a.width + x) * 4;
  const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
  if (d > 1) { rows[y]++; cols[x]++; }
  const v = Math.min(255, d * 8);
  out.data[i] = v; out.data[i + 1] = v > 16 ? 0 : v; out.data[i + 2] = 0; out.data[i + 3] = 255;
}
writeFileSync(outPath, PNG.sync.write(out));
const band = (arr, n, label) => {
  const size = Math.ceil(arr.length / n);
  const bands = Array.from({ length: n }, (_, k) => arr.slice(k * size, (k + 1) * size).reduce((s, v) => s + v, 0));
  console.log(`${label}: ${bands.map((v, k) => `${k * size}-${Math.min(arr.length, (k + 1) * size)}:${v}`).join('  ')}`);
};
band(rows, 8, 'differing pixels by row band   ');
band(cols, 8, 'differing pixels by column band');
