import { MAX_TILED_LEVELS, tilesAcross, type ChartPyramidSet } from './chartPyramids.ts';

export const PAGE_TABLE_WIDTH = 4096;
export const CHART_RECORD_ENTRIES = 4;

export interface TileCopy {
  key: number;
  slot: number;
}

export interface ResidencyStats {
  asked: number;
  planned: number;
  coarsened: number;
  copies: number;
  released: number;
  refused: number;
}

export interface ResidencyOptions {
  slotsPerSide: number;
  copyBudget: number;
  shiftSlots?: boolean;
  evictAll?: boolean;
}

export class TileResidency {
  readonly capacity: number;
  readonly pageData: Float32Array;
  private readonly slotKey: Int32Array;
  private readonly slotUsed: Int32Array;
  private readonly keySlot = new Map<number, number>();
  private frame = 0;
  private dirtyFrom = Number.POSITIVE_INFINITY;
  private dirtyTo = -1;
  stats: ResidencyStats = { asked: 0, planned: 0, coarsened: 0, copies: 0, released: 0, refused: 0 };

  readonly chartRecordStart: number;

  constructor(private readonly pyramids: ChartPyramidSet, private readonly options: ResidencyOptions) {
    this.capacity = options.evictAll ? 0 : options.slotsPerSide * options.slotsPerSide;
    this.slotKey = new Int32Array(Math.max(1, this.capacity)).fill(-1);
    this.slotUsed = new Int32Array(Math.max(1, this.capacity));
    this.chartRecordStart = pyramids.tiles.length;
    const entries = pyramids.tiles.length + pyramids.charts.length * CHART_RECORD_ENTRIES;
    const rows = Math.ceil(Math.max(1, entries) / PAGE_TABLE_WIDTH);
    this.pageData = new Float32Array(PAGE_TABLE_WIDTH * rows * 4);
    this.writeChartRecords();
    this.dirtyFrom = 0;
    this.dirtyTo = Math.max(0, entries - 1);
    for (let chart = 0; chart < pyramids.charts.length; chart++) this.writeChart(chart);
  }

  /**
   * @important The request names a tile and the pool decides. When the frame asks for more
   * tiles than there are slots, the finest tiles give way to their parents first, so the
   * frame degrades by level and never leaves a near surface on its tail while a far one
   * keeps detail.
   */
  serve(requested: Set<number>): { copies: TileCopy[] } {
    this.frame++;
    const { wanted, coarsened } = this.fitToCapacity(requested);
    for (const key of wanted) {
      const slot = this.keySlot.get(key);
      if (slot !== undefined) this.slotUsed[slot] = this.frame;
    }
    const missing = [...wanted].filter((key) => !this.keySlot.has(key))
      .sort((a, b) => this.pyramids.tiles[b].level - this.pyramids.tiles[a].level);
    const copies: TileCopy[] = [];
    const touched = new Set<number>();
    let released = 0;
    let refused = 0;
    for (const key of missing) {
      const slot = copies.length < this.options.copyBudget ? this.slotFor(wanted) : -1;
      if (slot < 0) { refused++; continue; }
      const previous = this.slotKey[slot];
      if (previous >= 0) {
        this.keySlot.delete(previous);
        touched.add(this.pyramids.tiles[previous].chart);
        released++;
      }
      this.slotKey[slot] = key;
      this.slotUsed[slot] = this.frame;
      this.keySlot.set(key, slot);
      touched.add(this.pyramids.tiles[key].chart);
      copies.push({ key, slot });
    }
    for (const chart of touched) this.writeChart(chart);
    this.stats = { asked: requested.size, planned: wanted.size, coarsened, copies: copies.length, released, refused };
    return { copies };
  }

  private writeChartRecords(): void {
    for (const [chart, pyramid] of this.pyramids.charts.entries()) {
      const base = (this.chartRecordStart + chart * CHART_RECORD_ENTRIES) * 4;
      this.pageData.set([pyramid.region.x, pyramid.region.y, pyramid.region.width, pyramid.region.height], base);
      this.pageData.set([pyramid.tailLevel, pyramid.pageStart, pyramid.tailX, pyramid.tailY], base + 4);
      this.pageData.set(pyramid.levelOffsets.slice(0, 4), base + 8);
      this.pageData.set(pyramid.levelOffsets.slice(4, MAX_TILED_LEVELS), base + 12);
    }
  }

  private fitToCapacity(requested: Set<number>): { wanted: Set<number>; coarsened: number } {
    const wanted = new Set(requested);
    let coarsened = 0;
    while (wanted.size > this.capacity) {
      const finest = [...wanted].sort((a, b) => this.pyramids.tiles[a].level - this.pyramids.tiles[b].level);
      const level = this.pyramids.tiles[finest[0]].level;
      for (const key of finest) {
        if (this.pyramids.tiles[key].level !== level || wanted.size <= this.capacity) break;
        wanted.delete(key);
        const parent = this.pyramids.parentKey(key);
        if (parent !== null) wanted.add(parent);
        coarsened++;
      }
    }
    return { wanted, coarsened };
  }

  private slotFor(wanted: Set<number>): number {
    let leastRecent = -1;
    for (let slot = 0; slot < this.capacity; slot++) {
      const key = this.slotKey[slot];
      if (key < 0) return slot;
      if (wanted.has(key)) continue;
      if (leastRecent < 0 || this.slotUsed[slot] < this.slotUsed[leastRecent]) leastRecent = slot;
    }
    return leastRecent;
  }

  /**
   * @important A tile that is not resident points at its nearest resident ancestor in the
   * same chart, and past the tiled levels at that chart's tail. The shader reads one entry
   * and one texture on any level and can never be sent to another chart's light.
   */
  private writeChart(chart: number): void {
    const pyramid = this.pyramids.charts[chart];
    const { width, height } = pyramid.region;
    for (let level = pyramid.tailLevel - 1; level >= 0; level--) {
      const across = tilesAcross(width, level, this.pyramids.tileSize);
      const down = tilesAcross(height, level, this.pyramids.tileSize);
      for (let tileY = 0; tileY < down; tileY++) {
        for (let tileX = 0; tileX < across; tileX++) this.writeEntry(this.pyramids.tileKey(chart, level, tileX, tileY), level, pyramid.tailLevel);
      }
    }
  }

  takeDirtyEntries(): { from: number; to: number } | null {
    if (this.dirtyTo < 0) return null;
    const range = { from: this.dirtyFrom, to: this.dirtyTo };
    this.dirtyFrom = Number.POSITIVE_INFINITY;
    this.dirtyTo = -1;
    return range;
  }

  private writeEntry(key: number, level: number, tailLevel: number): void {
    const slot = this.keySlot.get(key);
    const at = key * 4;
    this.dirtyFrom = Math.min(this.dirtyFrom, key);
    this.dirtyTo = Math.max(this.dirtyTo, key);
    if (slot !== undefined) {
      const tile = this.pyramids.tiles[key];
      this.pageData.set([slot + (this.options.shiftSlots ? 1 : 0), level, tile.tileX, tile.tileY], at);
    } else if (level === tailLevel - 1) {
      this.pageData.set([0, tailLevel, 0, 0], at);
    } else {
      const parent = this.pyramids.parentKey(key)!;
      this.pageData.copyWithin(at, parent * 4, parent * 4 + 4);
    }
  }

  entry(key: number): { slot: number; level: number; tileX: number; tileY: number; onTail: boolean } {
    const at = key * 4;
    const level = this.pageData[at + 1];
    return { slot: this.pageData[at], level, tileX: this.pageData[at + 2], tileY: this.pageData[at + 3], onTail: level >= this.pyramids.charts[this.pyramids.tiles[key].chart].tailLevel };
  }

  slotOf(key: number): number | undefined {
    return this.keySlot.get(key);
  }

  residentKeys(): number[] {
    return [...this.keySlot.keys()];
  }
}
