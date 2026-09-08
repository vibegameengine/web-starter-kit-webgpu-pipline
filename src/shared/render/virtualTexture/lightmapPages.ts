/** CPU page source. Its async interface also accepts disk/network-backed sources. */
export interface LightmapPageKey { mip: number; x: number; y: number }
export interface LightmapPageSource {
  size: number;
  pageSize: number;
  gutter: number;
  fallbackMip: number;
  fallback: Float32Array;
  load(key: LightmapPageKey, signal?: AbortSignal): Promise<Float32Array>;
  stats?(): unknown;
}
export const pageId = ({ mip, x, y }: LightmapPageKey) => `${mip}/${x}/${y}`;

export function createLightmapPages(data: Float32Array, size: number, pageSize = 128, fallbackSize = 128, gutter = 2): LightmapPageSource {
  if (size < pageSize || !Number.isInteger(Math.log2(size)) || !Number.isInteger(Math.log2(pageSize)) || !Number.isInteger(Math.log2(fallbackSize)) || fallbackSize >= size) {
    throw new Error('Virtual lightmap requires power-of-two dimensions and a smaller fallback');
  }
  if (data.length !== size * size * 4 || !data.every(Number.isFinite)) throw new Error('Invalid linear HDR lightmap');
  const levels = [data];
  for (let width = size; width > fallbackSize; width /= 2) {
    const input = levels[levels.length - 1], next = new Float32Array(width * width);
    const nextWidth = width / 2;
    for (let y = 0; y < nextWidth; y++) for (let x = 0; x < nextWidth; x++) {
      for (let c = 0; c < 4; c++) {
        const i = (y * 2 * width + x * 2) * 4 + c;
        next[(y * nextWidth + x) * 4 + c] = (input[i] + input[i + 4] + input[i + width * 4] + input[i + width * 4 + 4]) * .25;
      }
    }
    levels.push(next);
  }
  const fallbackMip = levels.length - 1;
  return {
    size, pageSize, gutter, fallbackMip, fallback: levels[fallbackMip],
    async load({ mip, x, y }) {
      const width = size / 2 ** mip, pages = Math.ceil(width / pageSize);
      if (!Number.isInteger(mip) || mip < 0 || mip >= fallbackMip || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= pages || y >= pages) throw new Error('Invalid lightmap page address');
      const stride = pageSize + gutter * 2, output = new Float32Array(stride * stride * 4);
      // Read the neighbour across page boundaries, not the edge of this page.
      // Only clamp at the outer edge of the virtual atlas.
      for (let py = 0; py < stride; py++) for (let px = 0; px < stride; px++) {
        const sx = Math.max(0, Math.min(width - 1, x * pageSize + px - gutter));
        const sy = Math.max(0, Math.min(width - 1, y * pageSize + py - gutter));
        output.set(levels[mip].subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (py * stride + px) * 4);
      }
      return output;
    },
  };
}
