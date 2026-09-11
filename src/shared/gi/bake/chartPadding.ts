/** A disjoint, mip-aligned rectangle allocated to one UV chart. */
export interface LightmapRegion { x: number; y: number; width: number; height: number }

/** Fill only unmeasured texels, from the same chart. Alpha >= .75 means a real
 * baked sample, including physically black samples. No brightness threshold.
 * A bounded breadth-first expansion fills arbitrary holes and border padding in
 * O(atlas texels), without allocating per chart or touching another rectangle. */
export function padLightmapCharts(pixels: Float32Array, size: number, regions: LightmapRegion[], height = size): number {
  if (pixels.length !== size * height * 4) throw new Error('Invalid lightmap padding dimensions');
  const owners = new Int32Array(size * height).fill(-1);
  for (const [id, region] of regions.entries()) {
    const { x, y, width, height } = region;
    if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > size) throw new Error('Invalid lightmap chart rectangle');
    for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) {
      const index = py * size + px;
      if (owners[index] !== -1) throw new Error('Overlapping lightmap chart rectangles');
      owners[index] = id;
    }
  }
  const queue = new Int32Array(size * height);
  let tail = 0, filled = 0;
  const seeds = new Uint32Array(regions.length);
  for (let i = 0; i < owners.length; i++) {
    if (owners[i] < 0) { pixels.fill(0, i * 4, i * 4 + 4); continue; }
    if (pixels[i * 4 + 3] >= .75) { queue[tail++] = i; seeds[owners[i]]++; }
    else pixels.fill(0, i * 4, i * 4 + 4);
  }
  /** @important A chart the GPU rasterisation missed used to throw and take the whole
   * scene down with it. The CPU coverage test in the unwrap and the rasteriser's own
   * fill rule disagree on a sliver now and then - one chart in 13713 on the beach - and
   * a dead scene is a worse answer than one unlit sliver. Many of them still throw:
   * that is a broken unwrap, not a rounding difference. */
  const unmeasured = seeds.reduce((count, seeded) => count + (seeded === 0 ? 1 : 0), 0);
  if (unmeasured > Math.max(4, regions.length * 0.01)) {
    throw new Error(`${unmeasured} of ${regions.length} lightmap charts have no measured texels; the unwrap is wrong, not the rasteriser`);
  }
  if (unmeasured > 0) console.warn(`[lightmap] ${unmeasured} chart(s) of ${regions.length} rasterised no texel and stay unlit`);
  for (let head = 0; head < tail; head++) {
    const i = queue[head], x = i % size;
    for (let side = 0; side < 4; side++) {
      if ((side === 0 && x === 0) || (side === 1 && x === size - 1)) continue;
      const j = i + (side === 0 ? -1 : side === 1 ? 1 : side === 2 ? -size : size);
      if (j < 0 || j >= owners.length || owners[j] !== owners[i] || pixels[j * 4 + 3] > .25) continue;
      pixels[j * 4] = pixels[i * 4]; pixels[j * 4 + 1] = pixels[i * 4 + 1]; pixels[j * 4 + 2] = pixels[i * 4 + 2];
      pixels[j * 4 + 3] = .5; queue[tail++] = j; filled++;
    }
  }
  return filled;
}
