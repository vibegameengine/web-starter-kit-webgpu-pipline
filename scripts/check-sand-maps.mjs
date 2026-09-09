// What the sand layer generators actually drew: albedo, relief and ranked coverage
// as PNGs, plus the share of each map its stated density would cover.
// Usage: npx tsx scripts/check-sand-maps.mjs   (run through tsx: it imports TS)
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { sandLayerSlices } from '../src/entities/island/sandLayerMaps.ts';
import { rankField } from '../src/shared/render/terrain/layerMaps.ts';

const OUT = 'shots/sand/maps';
mkdirSync(OUT, { recursive: true });
const names = ['dry-grain', 'ripples', 'wet-packed', 'litter'];
const srgb = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.4) - 0.055));

for (const [index, slice] of sandLayerSlices().entries()) {
  const size = Math.round(Math.sqrt(slice.height.length));
  const write = (suffix, fill) => {
    const png = new PNG({ width: size, height: size });
    for (let i = 0; i < size * size; i++) fill(png.data, i * 4, i);
    writeFileSync(`${OUT}/${names[index]}-${suffix}.png`, PNG.sync.write(png));
  };
  write('albedo', (d, o, i) => {
    d[o] = srgb(slice.albedo[i * 3]); d[o + 1] = srgb(slice.albedo[i * 3 + 1]); d[o + 2] = srgb(slice.albedo[i * 3 + 2]); d[o + 3] = 255;
  });
  write('height', (d, o, i) => { const v = Math.round(slice.height[i] * 255); d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255; });
  const coverage = rankField(slice.presence ?? slice.height);
  write('coverage', (d, o, i) => { const v = Math.round(coverage[i] * 255); d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255; });
  for (const density of [0.02, 0.055, 0.2]) {
    let above = 0;
    for (const value of coverage) if (value > 1 - density) above++;
    console.log(`${names[index]} density ${density} covers ${(100 * above / coverage.length).toFixed(2)} %`);
  }
}
console.log(`→ ${OUT}`);

// Encoded normal range per slice: a map whose xy never leaves the middle of the
// byte range cannot tilt anything, however strong the layer says it is.
import { buildLayerMaps } from '../src/shared/render/terrain/layerMaps.ts';
const built = buildLayerMaps(sandLayerSlices(), 512);
built.layers.forEach((layer, index) => {
  const d = layer.detail.image.data;
  let minX = 255, maxX = 0, minY = 255, maxY = 0;
  for (let i = 0; i < d.length; i += 4) {
    minX = Math.min(minX, d[i]); maxX = Math.max(maxX, d[i]);
    minY = Math.min(minY, d[i + 1]); maxY = Math.max(maxY, d[i + 1]);
  }
  console.log(`${names[index]} normal x ${minX}..${maxX}  y ${minY}..${maxY} (128 = flat)`);
});
