import type { LightmapRegion } from '../bake/chartPadding.ts';

export const TILE_BORDER = 2;
export const MAX_TILED_LEVELS = 8;
const TAIL_SIDES = [256, 512, 1024, 2048, 4096, 8192];

export interface TileRecord {
  chart: number;
  level: number;
  tileX: number;
  tileY: number;
  pixels: Float32Array;
}

export interface ChartPyramid {
  region: LightmapRegion;
  tailLevel: number;
  tailX: number;
  tailY: number;
  pageStart: number;
  levelOffsets: number[];
}

export interface PyramidSource {
  atlas: Float32Array;
  atlasWidth: number;
  regions: LightmapRegion[];
  tileSize: number;
}

interface LevelImage {
  pixels: Float32Array;
  width: number;
  height: number;
}

interface TailBox extends LevelImage {
  chart: number;
}

export function levelSize(size: number, level: number): number {
  return Math.max(1, Math.floor(size / 2 ** level));
}

export function tilesAcross(size: number, level: number, tileSize: number): number {
  return Math.ceil(levelSize(size, level) / tileSize);
}

/**
 * @important The unit of LOD is the chart, not the mesh: the inner and outer walls of a
 * village house are one merged geometry, and only the chart boundary keeps them apart.
 * Every level is cut inside its own chart and bordered from that same level, so no level
 * of any chart carries a neighbour's light. Levels wider than a tile are cut into equal
 * tiles that stream; the first level that fits a tile is the tail, packed once and
 * resident for the life of the scene.
 */
export class ChartPyramidSet {
  readonly charts: ChartPyramid[] = [];
  readonly tiles: TileRecord[] = [];
  tailPixels: Float32Array;
  readonly tailSize: number;
  readonly physicalTile: number;
  readonly tileSize: number;

  constructor(source: PyramidSource) {
    this.tileSize = source.tileSize;
    this.physicalTile = source.tileSize + 2 * TILE_BORDER;
    const tails: TailBox[] = [];
    for (const [chart, region] of source.regions.entries()) {
      tails.push({ chart, ...this.cutChart(chart, region, cutRegion(source.atlas, source.atlasWidth, region)) });
    }
    const packed = packTails(tails, source.regions.length);
    this.tailSize = packed.size;
    this.tailPixels = packed.pixels;
    for (const [chart, origin] of packed.origins) {
      this.charts[chart].tailX = origin.x;
      this.charts[chart].tailY = origin.y;
    }
  }

  private cutChart(chart: number, region: LightmapRegion, base: Float32Array): LevelImage {
    let image: LevelImage = { pixels: base, width: region.width, height: region.height };
    const levelOffsets: number[] = [];
    const pageStart = this.tiles.length;
    let level = 0;
    while (image.width > this.tileSize || image.height > this.tileSize) {
      if (level >= MAX_TILED_LEVELS) throw new Error(`[lod] chart ${chart} of ${region.width}x${region.height} needs more than ${MAX_TILED_LEVELS} tiled levels at a ${this.tileSize} tile`);
      levelOffsets.push(this.tiles.length - pageStart);
      this.cutLevel(chart, level, image);
      image = halve(image);
      level++;
    }
    while (levelOffsets.length < MAX_TILED_LEVELS) levelOffsets.push(this.tiles.length - pageStart);
    this.charts.push({ region, tailLevel: level, tailX: 0, tailY: 0, pageStart, levelOffsets });
    return image;
  }

  private cutLevel(chart: number, level: number, image: LevelImage): void {
    const across = Math.ceil(image.width / this.tileSize);
    const down = Math.ceil(image.height / this.tileSize);
    for (let tileY = 0; tileY < down; tileY++) {
      for (let tileX = 0; tileX < across; tileX++) {
        const pixels = new Float32Array(this.physicalTile * this.physicalTile * 4);
        copyBordered(image, { pixels, width: this.physicalTile },
          { fromX: tileX * this.tileSize - TILE_BORDER, fromY: tileY * this.tileSize - TILE_BORDER, toX: 0, toY: 0, width: this.physicalTile, height: this.physicalTile });
        this.tiles.push({ chart, level, tileX, tileY, pixels });
      }
    }
  }

  releasePixels(): void {
    for (const tile of this.tiles) tile.pixels = new Float32Array(0);
    this.tailPixels = new Float32Array(0);
  }

  tileKey(chart: number, level: number, tileX: number, tileY: number): number {
    const pyramid = this.charts[chart];
    return pyramid.pageStart + pyramid.levelOffsets[level] + tileY * tilesAcross(pyramid.region.width, level, this.tileSize) + tileX;
  }

  tileAt(chart: number, level: number, atlasX: number, atlasY: number): number | null {
    const pyramid = this.charts[chart];
    if (!pyramid || level >= pyramid.tailLevel) return null;
    const { x, y, width, height } = pyramid.region;
    const localX = ((atlasX - x) * levelSize(width, level)) / width;
    const localY = ((atlasY - y) * levelSize(height, level)) / height;
    const tileX = Math.min(tilesAcross(width, level, this.tileSize) - 1, Math.max(0, Math.floor(localX / this.tileSize)));
    const tileY = Math.min(tilesAcross(height, level, this.tileSize) - 1, Math.max(0, Math.floor(localY / this.tileSize)));
    return this.tileKey(chart, level, tileX, tileY);
  }

  parentKey(key: number): number | null {
    const tile = this.tiles[key];
    const { x, y, width, height } = this.charts[tile.chart].region;
    const centreX = x + ((Math.min(levelSize(width, tile.level), (tile.tileX + 0.5) * this.tileSize)) * width) / levelSize(width, tile.level);
    const centreY = y + ((Math.min(levelSize(height, tile.level), (tile.tileY + 0.5) * this.tileSize)) * height) / levelSize(height, tile.level);
    return this.tileAt(tile.chart, tile.level + 1, centreX, centreY);
  }
}

function halve(image: LevelImage): LevelImage {
  const width = Math.max(1, image.width >> 1);
  const height = Math.max(1, image.height >> 1);
  const pixels = new Float32Array(width * height * 4);
  const stepX = image.width / width;
  const stepY = image.height / height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4;
      let taps = 0;
      for (let sy = Math.floor(y * stepY); sy < Math.min(image.height, Math.ceil((y + 1) * stepY)); sy++) {
        for (let sx = Math.floor(x * stepX); sx < Math.min(image.width, Math.ceil((x + 1) * stepX)); sx++) {
          const from = (sy * image.width + sx) * 4;
          for (let channel = 0; channel < 4; channel++) pixels[to + channel] += image.pixels[from + channel];
          taps++;
        }
      }
      for (let channel = 0; channel < 4; channel++) pixels[to + channel] /= taps;
    }
  }
  return { pixels, width, height };
}

function packTails(tails: TailBox[], chartCount: number): { size: number; pixels: Float32Array; origins: Map<number, { x: number; y: number }> } {
  const boxes = tails.map((tail) => ({ tail, width: tail.width + 2 * TILE_BORDER, height: tail.height + 2 * TILE_BORDER }))
    .sort((a, b) => b.height - a.height || b.width - a.width);
  for (const size of TAIL_SIDES) {
    const places = shelfPack(boxes, size);
    if (!places) continue;
    const pixels = new Float32Array(size * size * 4);
    const origins = new Map<number, { x: number; y: number }>();
    for (const [index, box] of boxes.entries()) {
      const place = places[index];
      copyBordered(box.tail, { pixels, width: size }, { fromX: -TILE_BORDER, fromY: -TILE_BORDER, toX: place.x, toY: place.y, width: box.width, height: box.height });
      origins.set(box.tail.chart, { x: place.x + TILE_BORDER, y: place.y + TILE_BORDER });
    }
    return { size, pixels, origins };
  }
  throw new Error(`[lod] ${chartCount} chart tails do not fit an 8192 tail texture`);
}

function shelfPack(boxes: { width: number; height: number }[], side: number): { x: number; y: number }[] | null {
  const places: { x: number; y: number }[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const box of boxes) {
    if (box.width > side) return null;
    if (cursorX + box.width > side) { cursorX = 0; cursorY += rowHeight; rowHeight = 0; }
    if (cursorY + box.height > side) return null;
    places.push({ x: cursorX, y: cursorY });
    cursorX += box.width;
    rowHeight = Math.max(rowHeight, box.height);
  }
  return places;
}

function copyBordered(
  source: LevelImage,
  target: { pixels: Float32Array; width: number },
  span: { fromX: number; fromY: number; toX: number; toY: number; width: number; height: number },
): void {
  for (let y = 0; y < span.height; y++) {
    const sourceY = Math.min(source.height - 1, Math.max(0, span.fromY + y));
    for (let x = 0; x < span.width; x++) {
      const sourceX = Math.min(source.width - 1, Math.max(0, span.fromX + x));
      const from = (sourceY * source.width + sourceX) * 4;
      const to = ((span.toY + y) * target.width + span.toX + x) * 4;
      target.pixels.set(source.pixels.subarray(from, from + 4), to);
    }
  }
}

function cutRegion(atlas: Float32Array, atlasWidth: number, region: LightmapRegion): Float32Array {
  const out = new Float32Array(region.width * region.height * 4);
  for (let y = 0; y < region.height; y++) {
    const source = ((region.y + y) * atlasWidth + region.x) * 4;
    out.set(atlas.subarray(source, source + region.width * 4), y * region.width * 4);
  }
  return out;
}
