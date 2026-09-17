import { describe, expect, it } from 'vitest';
import { ChartPyramidSet, TILE_BORDER, levelSize } from './chartPyramids.ts';
import { TileResidency } from './tileResidency.ts';

const ATLAS_WIDTH = 512;

function atlasWith(regions: { x: number; y: number; width: number; height: number; value: number }[], height = 512): Float32Array {
  const atlas = new Float32Array(ATLAS_WIDTH * height * 4);
  for (const region of regions) {
    for (let y = region.y; y < region.y + region.height; y++) {
      for (let x = region.x; x < region.x + region.width; x++) atlas.set([region.value, region.value, region.value, 1], (y * ATLAS_WIDTH + x) * 4);
    }
  }
  return atlas;
}

function gradientAtlas(region: { x: number; y: number; width: number; height: number }): Float32Array {
  const atlas = new Float32Array(ATLAS_WIDTH * 512 * 4);
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) atlas.set([x, y, 0, 1], ((region.y + y) * ATLAS_WIDTH + region.x + x) * 4);
  }
  return atlas;
}

function storeTexel(set: ChartPyramidSet, key: number, x: number, y: number): number[] {
  const at = (y * set.physicalTile + x) * 4;
  return Array.from(set.tiles[key].pixels.subarray(at, at + 4));
}

describe('ChartPyramidSet', () => {
  it('tiles every level wider than a tile and puts the first level that fits into the tail', () => {
    const regions = [{ x: 0, y: 0, width: 200, height: 100 }];
    const set = new ChartPyramidSet({ atlas: atlasWith([{ ...regions[0], value: 1 }]), atlasWidth: ATLAS_WIDTH, regions, tileSize: 64 });
    expect(set.charts[0].tailLevel).toBe(2);
    expect(set.tiles.filter((tile) => tile.level === 0)).toHaveLength(4 * 2);
    expect(set.tiles.filter((tile) => tile.level === 1)).toHaveLength(2 * 1);
    expect(set.tiles).toHaveLength(10);
  });

  it('keeps a small chart entirely in the tail', () => {
    const regions = [{ x: 10, y: 10, width: 40, height: 20 }];
    const set = new ChartPyramidSet({ atlas: atlasWith([{ ...regions[0], value: 1 }]), atlasWidth: ATLAS_WIDTH, regions, tileSize: 64 });
    expect(set.charts[0].tailLevel).toBe(0);
    expect(set.tiles).toHaveLength(0);
  });

  it('never carries a neighbouring chart light into any tile or tail texel', () => {
    const regions = [
      { x: 0, y: 0, width: 300, height: 300, value: 0 },
      { x: 300, y: 0, width: 200, height: 300, value: 5 },
    ];
    const set = new ChartPyramidSet({ atlas: atlasWith(regions), atlasWidth: ATLAS_WIDTH, regions, tileSize: 64 });
    for (const [key, tile] of set.tiles.entries()) {
      const expected = regions[tile.chart].value;
      for (let y = 0; y < set.physicalTile; y += 7) {
        for (let x = 0; x < set.physicalTile; x += 7) expect(storeTexel(set, key, x, y)[0]).toBe(expected);
      }
    }
    for (const [chart, pyramid] of set.charts.entries()) {
      const width = levelSize(regions[chart].width, pyramid.tailLevel) + 2 * TILE_BORDER;
      const height = levelSize(regions[chart].height, pyramid.tailLevel) + 2 * TILE_BORDER;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const at = ((pyramid.tailY - TILE_BORDER + y) * set.tailSize + pyramid.tailX - TILE_BORDER + x) * 4;
          expect(set.tailPixels[at]).toBe(regions[chart].value);
        }
      }
    }
  });

  it('borders a tile with the real neighbouring texels of the same level', () => {
    const region = { x: 0, y: 0, width: 200, height: 70 };
    const set = new ChartPyramidSet({ atlas: gradientAtlas(region), atlasWidth: ATLAS_WIDTH, regions: [region], tileSize: 64 });
    const second = set.tileKey(0, 0, 1, 0);
    expect(storeTexel(set, second, 0, TILE_BORDER)).toEqual([62, 0, 0, 1]);
    expect(storeTexel(set, second, TILE_BORDER, TILE_BORDER)).toEqual([64, 0, 0, 1]);
    const first = set.tileKey(0, 0, 0, 0);
    expect(storeTexel(set, first, 0, TILE_BORDER)).toEqual([0, 0, 0, 1]);
  });

  it('resolves an atlas texel to the tile that holds it and walks to the parent', () => {
    const region = { x: 100, y: 50, width: 300, height: 130 };
    const set = new ChartPyramidSet({ atlas: gradientAtlas(region), atlasWidth: ATLAS_WIDTH, regions: [region], tileSize: 64 });
    const key = set.tileAt(0, 0, 100 + 200, 50 + 70)!;
    expect(set.tiles[key]).toMatchObject({ level: 0, tileX: 3, tileY: 1 });
    const parent = set.parentKey(key)!;
    expect(set.tiles[parent]).toMatchObject({ level: 1, tileX: 1, tileY: 0 });
    expect(set.tileAt(0, set.charts[0].tailLevel, 150, 60)).toBeNull();
  });
});

describe('TileResidency', () => {
  const regions = [
    { x: 0, y: 0, width: 256, height: 256 },
    { x: 256, y: 0, width: 256, height: 256 },
  ];
  const build = () => new ChartPyramidSet({ atlas: atlasWith(regions.map((region, index) => ({ ...region, value: index }))), atlasWidth: ATLAS_WIDTH, regions, tileSize: 64 });

  it('points every tile at its tail before anything is resident', () => {
    const set = build();
    const residency = new TileResidency(set, { slotsPerSide: 4, copyBudget: 64 });
    for (const key of set.tiles.keys()) expect(residency.entry(key)).toMatchObject({ onTail: true, level: set.charts[set.tiles[key].chart].tailLevel });
  });

  it('makes requested tiles resident and points their children at them', () => {
    const set = build();
    const residency = new TileResidency(set, { slotsPerSide: 4, copyBudget: 64 });
    const parent = set.tileKey(0, 1, 0, 0);
    residency.serve(new Set([parent]));
    expect(residency.entry(parent)).toMatchObject({ onTail: false, level: 1, tileX: 0, tileY: 0 });
    const child = set.tileKey(0, 0, 1, 1);
    expect(residency.entry(child)).toEqual(residency.entry(parent));
    const otherChart = set.tileKey(1, 0, 0, 0);
    expect(residency.entry(otherChart).onTail).toBe(true);
  });

  it('gives the finest tiles up to their parents when the pool is short', () => {
    const set = build();
    const residency = new TileResidency(set, { slotsPerSide: 1, copyBudget: 64 });
    const children = [0, 1, 2, 3].map((index) => set.tileKey(0, 0, index % 2, Math.floor(index / 2)));
    residency.serve(new Set(children));
    expect(residency.residentKeys()).toEqual([set.tileKey(0, 1, 0, 0)]);
    expect(residency.stats.coarsened).toBeGreaterThan(0);
  });

  it('never points one chart at a slot holding another chart', () => {
    const set = build();
    const residency = new TileResidency(set, { slotsPerSide: 2, copyBudget: 64 });
    for (let round = 0; round < 6; round++) {
      const chart = round % 2;
      residency.serve(new Set([set.tileKey(chart, 0, round % 4, 0), set.tileKey(chart, 1, 0, 0)]));
      for (const key of set.tiles.keys()) {
        const entry = residency.entry(key);
        if (entry.onTail) continue;
        const holder = residency.residentKeys().find((resident) => residency.slotOf(resident) === entry.slot)!;
        expect(set.tiles[holder]).toMatchObject({ chart: set.tiles[key].chart, level: entry.level, tileX: entry.tileX, tileY: entry.tileY });
      }
    }
  });

  it('keeps everything on the tail when eviction of every tile is forced', () => {
    const set = build();
    const residency = new TileResidency(set, { slotsPerSide: 4, copyBudget: 64, evictAll: true });
    residency.serve(new Set(set.tiles.keys()));
    expect(residency.residentKeys()).toHaveLength(0);
    for (const key of set.tiles.keys()) expect(residency.entry(key).onTail).toBe(true);
  });

  it('reports only the page entries a frame changed', () => {
    const set = build();
    const residency = new TileResidency(set, { slotsPerSide: 4, copyBudget: 64 });
    expect(residency.takeDirtyEntries()).toEqual({ from: 0, to: set.tiles.length + set.charts.length * 4 - 1 });
    residency.serve(new Set());
    expect(residency.takeDirtyEntries()).toBeNull();
    const key = set.tileKey(1, 0, 2, 3);
    residency.serve(new Set([key]));
    const range = residency.takeDirtyEntries()!;
    const chartTiles = [...set.tiles.keys()].filter((index) => set.tiles[index].chart === 1);
    expect(range).toEqual({ from: Math.min(...chartTiles), to: Math.max(...chartTiles) });
    residency.serve(new Set([key]));
    expect(residency.takeDirtyEntries()).toBeNull();
  });

  it('respects the copy budget per frame', () => {
    const set = build();
    const residency = new TileResidency(set, { slotsPerSide: 8, copyBudget: 3 });
    const first = residency.serve(new Set(set.tiles.keys()));
    expect(first.copies).toHaveLength(3);
    expect(residency.stats.refused).toBe(set.tiles.length - 3);
  });
});
