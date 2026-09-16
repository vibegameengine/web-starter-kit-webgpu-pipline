import * as THREE from 'three/webgpu';
import type { LightmapRegion } from '../bake/chartPadding.ts';

export const PAGE_GUTTER = 2;

export interface PageSlice {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChartPages {
  levels: PageSlice[];
  width: number;
  height: number;
}

interface LevelPixels {
  chart: number;
  mip: number;
  width: number;
  height: number;
  pixels: Float32Array;
}

export class PagePool {
  readonly pages: THREE.DataTexture[] = [];
  readonly charts: ChartPages[] = [];
  readonly pageSize: number;
  readonly bytes: number;
  readonly rootColours: Float32Array;

  constructor(renderer: THREE.WebGPURenderer, atlas: Float32Array, atlasSize: number, regions: LightmapRegion[], requestedPageSize: number) {
    // @important A level wider than its page would be blitted past the row end and then
    // copied out of bounds: ?lodPage=32 produced 122 WebGPU validation errors and a
    // corrupt page. The design's answer is splitting an oversized map into fragments;
    // until that exists the page grows to hold the largest level instead of silently
    // writing outside it.
    let widest = 0;
    for (const region of regions) widest = Math.max(widest, region.width + 2 * PAGE_GUTTER, region.height + 2 * PAGE_GUTTER);
    const pageSize = Math.max(requestedPageSize, 2 ** Math.ceil(Math.log2(Math.max(widest, 1))));
    if (pageSize !== requestedPageSize) console.warn(`[lod] page ${requestedPageSize}² cannot hold a ${widest}² level; using ${pageSize}²`);
    this.pageSize = pageSize;
    this.rootColours = new Float32Array(regions.length * 3);
    const levels: LevelPixels[] = [];
    for (const [chart, region] of regions.entries()) {
      let current = cutRegion(atlas, atlasSize, region);
      let width = region.width;
      let height = region.height;
      let mip = 0;
      this.charts.push({ levels: [], width, height });
      for (;;) {
        levels.push({ chart, mip, width, height, pixels: current });
        if (width === 1 && height === 1) {
          this.rootColours.set(current.subarray(0, 3), chart * 3);
          break;
        }
        const nextWidth = Math.max(1, width >> 1);
        const nextHeight = Math.max(1, height >> 1);
        current = downsample(current, width, height, nextWidth, nextHeight);
        width = nextWidth;
        height = nextHeight;
        mip++;
      }
    }

    levels.sort((a, b) => b.height - a.height || b.width - a.width);
    const writers: Float32Array[] = [];
    let cursorX = 0;
    let cursorY = 0;
    let rowHeight = 0;
    for (const level of levels) {
      const boxWidth = level.width + 2 * PAGE_GUTTER;
      const boxHeight = level.height + 2 * PAGE_GUTTER;
      if (cursorX + boxWidth > pageSize) { cursorX = 0; cursorY += rowHeight; rowHeight = 0; }
      if (writers.length === 0 || cursorY + boxHeight > pageSize) {
        if (writers.length > 0 && cursorY + boxHeight > pageSize) { cursorX = 0; cursorY = 0; rowHeight = 0; }
        writers.push(new Float32Array(pageSize * pageSize * 4));
      }
      const page = writers.length - 1;
      blitWithGutter(writers[page], pageSize, level, cursorX, cursorY);
      this.charts[level.chart].levels[level.mip] = {
        page, x: cursorX + PAGE_GUTTER, y: cursorY + PAGE_GUTTER, width: level.width, height: level.height,
      };
      cursorX += boxWidth;
      rowHeight = Math.max(rowHeight, boxHeight);
    }

    for (const pixels of writers) {
      const texture = new THREE.DataTexture(
        Uint16Array.from(pixels, THREE.DataUtils.toHalfFloat), pageSize, pageSize, THREE.RGBAFormat, THREE.HalfFloatType,
      );
      texture.minFilter = texture.magFilter = THREE.NearestFilter;
      texture.colorSpace = THREE.NoColorSpace;
      texture.needsUpdate = true;
      renderer.initTexture(texture);
      this.pages.push(texture);
    }
    this.bytes = this.pages.length * pageSize * pageSize * 8;
  }

  lastMip(chart: number): number {
    return this.charts[chart].levels.length - 1;
  }

  slice(chart: number, mip: number): PageSlice {
    const levels = this.charts[chart].levels;
    return levels[Math.min(Math.max(mip, 0), levels.length - 1)];
  }

  dispose(): void {
    for (const page of this.pages) page.dispose();
  }
}

function cutRegion(atlas: Float32Array, atlasSize: number, region: LightmapRegion): Float32Array {
  const out = new Float32Array(region.width * region.height * 4);
  for (let y = 0; y < region.height; y++) {
    const source = ((region.y + y) * atlasSize + region.x) * 4;
    out.set(atlas.subarray(source, source + region.width * 4), y * region.width * 4);
  }
  return out;
}

function downsample(pixels: Float32Array, width: number, height: number, outWidth: number, outHeight: number): Float32Array {
  const out = new Float32Array(outWidth * outHeight * 4);
  const stepX = width / outWidth;
  const stepY = height / outHeight;
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let r = 0, g = 0, b = 0, a = 0, taps = 0;
      for (let sy = Math.floor(y * stepY); sy < Math.min(height, Math.ceil((y + 1) * stepY)); sy++) {
        for (let sx = Math.floor(x * stepX); sx < Math.min(width, Math.ceil((x + 1) * stepX)); sx++) {
          const index = (sy * width + sx) * 4;
          r += pixels[index]; g += pixels[index + 1]; b += pixels[index + 2]; a += pixels[index + 3];
          taps++;
        }
      }
      const index = (y * outWidth + x) * 4;
      out[index] = r / taps; out[index + 1] = g / taps; out[index + 2] = b / taps; out[index + 3] = a / taps;
    }
  }
  return out;
}

function blitWithGutter(page: Float32Array, pageSize: number, level: LevelPixels, originX: number, originY: number): void {
  const boxWidth = level.width + 2 * PAGE_GUTTER;
  const boxHeight = level.height + 2 * PAGE_GUTTER;
  for (let y = 0; y < boxHeight; y++) {
    const sourceY = Math.min(level.height - 1, Math.max(0, y - PAGE_GUTTER));
    for (let x = 0; x < boxWidth; x++) {
      const sourceX = Math.min(level.width - 1, Math.max(0, x - PAGE_GUTTER));
      const from = (sourceY * level.width + sourceX) * 4;
      const to = ((originY + y) * pageSize + originX + x) * 4;
      page[to] = level.pixels[from];
      page[to + 1] = level.pixels[from + 1];
      page[to + 2] = level.pixels[from + 2];
      page[to + 3] = level.pixels[from + 3];
    }
  }
}
