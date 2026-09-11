import * as THREE from 'three/webgpu';
import { Fn, attribute, exp2, float, int, ivec2, texture, textureLoad, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { PAGE_GUTTER, PagePool } from './pagePool.ts';

export const CELL = 8;
const TABLE_COLUMNS = 4;

interface Residency {
  mip: number;
  cellX: number;
  cellY: number;
  cellsWide: number;
  cellsHigh: number;
  usedFrame: number;
}

export interface AtlasDemand {
  chart: number;
  mip: number;
  priority: number;
}

export class WorkingAtlas {
  readonly target: THREE.RenderTarget;
  readonly texture: THREE.Texture;
  readonly size: number;
  readonly table: THREE.DataTexture;
  private readonly tableData: Float32Array;
  private readonly cells: Uint8Array;
  private readonly columns: number;
  private readonly rows: number;
  private readonly resident = new Map<number, Residency>();
  private readonly sourceAtlasSize = uniform(new THREE.Vector2(1, 1));
  private frame = 0;
  private tableDirty = true;
  private rootCells = 0;
  copiesLastFrame = 0;
  refusedLastFrame = 0;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly pool: PagePool,
    private readonly chartOrigins: { x: number; y: number; width: number; height: number }[],
    sourceAtlasSize: { width: number; height: number },
    size: number,
  ) {
    this.size = size;
    this.columns = Math.floor(size / CELL);
    this.rows = Math.floor(size / CELL);
    this.cells = new Uint8Array(this.columns * this.rows);
    this.sourceAtlasSize.value = new THREE.Vector2(sourceAtlasSize.width, sourceAtlasSize.height);

    this.target = new THREE.RenderTarget(size, size, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false,
    });
    this.texture = this.target.texture;
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.NoColorSpace;
    renderer.initTexture(this.texture);

    this.tableData = new Float32Array(TABLE_COLUMNS * chartOrigins.length * 4);
    this.table = new THREE.DataTexture(this.tableData, TABLE_COLUMNS, chartOrigins.length, THREE.RGBAFormat, THREE.FloatType);
    this.table.minFilter = this.table.magFilter = THREE.NearestFilter;
    this.table.needsUpdate = true;
    renderer.initTexture(this.table);

    this.writeChartGeometry();
    this.pinRoots();
  }

  private writeChartGeometry(): void {
    for (const [chart, origin] of this.chartOrigins.entries()) {
      const row = chart * TABLE_COLUMNS * 4;
      this.tableData[row] = origin.x;
      this.tableData[row + 1] = origin.y;
      this.tableData[row + 2] = origin.width;
      this.tableData[row + 3] = origin.height;
    }
  }

  /**
   * @important The roots are the reason a frame can never go black: the working atlas
   * holds one texel per chart that is never evicted, so a chart whose detail has not
   * been copied in yet still reads its own average colour instead of a neighbour's
   * slot. They sit in the first rows, and those cells are marked used for good.
   */
  private pinRoots(): void {
    const perRow = this.size;
    const rootRows = Math.ceil(this.chartOrigins.length / perRow);
    for (let cellY = 0; cellY < Math.ceil(rootRows / CELL); cellY++) {
      for (let cellX = 0; cellX < this.columns; cellX++) { this.cells[cellY * this.columns + cellX] = 1; this.rootCells++; }
    }
    const region = new THREE.Box2();
    const target = new THREE.Vector2();
    for (let chart = 0; chart < this.chartOrigins.length; chart++) {
      const slice = this.pool.slice(chart, this.pool.lastMip(chart));
      region.min.set(slice.x, slice.y);
      region.max.set(slice.x + 1, slice.y + 1);
      const x = chart % perRow;
      const y = Math.floor(chart / perRow);
      target.set(x, y);
      this.renderer.copyTextureToTexture(this.pool.pages[slice.page], this.texture, region, target);
      const row = chart * TABLE_COLUMNS * 4;
      this.tableData[row + 8] = x;
      this.tableData[row + 9] = y;
    }
    this.tableDirty = true;
  }

  beginFrame(): void {
    this.frame++;
    this.copiesLastFrame = 0;
    this.refusedLastFrame = 0;
  }

  freeCells(): number {
    return this.cells.length - this.rootCells;
  }

  serve(demands: AtlasDemand[], copyBudget: number): void {
    for (const demand of demands) {
      const current = this.resident.get(demand.chart);
      if (current && current.mip === demand.mip) { current.usedFrame = this.frame; continue; }
      if (this.copiesLastFrame >= copyBudget) break;
      if (this.place(demand.chart, demand.mip)) this.copiesLastFrame++;
      else this.refusedLastFrame++;
    }
    if (this.tableDirty) { this.table.needsUpdate = true; this.tableDirty = false; }
  }

  private place(chart: number, mip: number): boolean {
    const slice = this.pool.slice(chart, mip);
    const cellsWide = Math.ceil((slice.width + 2 * PAGE_GUTTER) / CELL);
    const cellsHigh = Math.ceil((slice.height + 2 * PAGE_GUTTER) / CELL);
    let spot = this.findFree(cellsWide, cellsHigh);
    if (!spot) { this.evictOldest(cellsWide * cellsHigh, chart); spot = this.findFree(cellsWide, cellsHigh); }
    /** @important The old level is given up only once the new one has a home. Releasing
     * first is the failure §05 of the design names: a chart lit correctly at mip 2 asks
     * for mip 1, the four cells are not there, and the surface drops to its 1x1 root. */
    if (!spot) return false;
    this.release(chart);
    spot = this.findFree(cellsWide, cellsHigh) ?? spot;
    this.occupy(spot.cellX, spot.cellY, cellsWide, cellsHigh, 1);

    const region = new THREE.Box2(
      new THREE.Vector2(slice.x - PAGE_GUTTER, slice.y - PAGE_GUTTER),
      new THREE.Vector2(slice.x + slice.width + PAGE_GUTTER, slice.y + slice.height + PAGE_GUTTER),
    );
    const target = new THREE.Vector2(spot.cellX * CELL, spot.cellY * CELL);
    this.renderer.copyTextureToTexture(this.pool.pages[slice.page], this.texture, region, target);

    this.resident.set(chart, { mip, cellX: spot.cellX, cellY: spot.cellY, cellsWide, cellsHigh, usedFrame: this.frame });
    const row = chart * TABLE_COLUMNS * 4;
    this.tableData[row + 4] = mip;
    this.tableData[row + 5] = spot.cellX * CELL + PAGE_GUTTER;
    this.tableData[row + 6] = spot.cellY * CELL + PAGE_GUTTER;
    this.tableData[row + 7] = 1;
    this.tableDirty = true;
    return true;
  }

  private release(chart: number): void {
    const entry = this.resident.get(chart);
    if (!entry) return;
    this.occupy(entry.cellX, entry.cellY, entry.cellsWide, entry.cellsHigh, 0);
    this.resident.delete(chart);
    this.tableData[chart * TABLE_COLUMNS * 4 + 7] = 0;
    this.tableDirty = true;
  }

  private evictOldest(cellsNeeded: number, keep: number): void {
    const order = [...this.resident.entries()].sort((a, b) => a[1].usedFrame - b[1].usedFrame);
    let freed = 0;
    for (const [chart, entry] of order) {
      if (entry.usedFrame === this.frame || chart === keep) continue;
      this.release(chart);
      freed += entry.cellsWide * entry.cellsHigh;
      if (freed >= cellsNeeded) break;
    }
  }

  private findFree(cellsWide: number, cellsHigh: number): { cellX: number; cellY: number } | null {
    for (let y = 0; y + cellsHigh <= this.rows; y++) {
      for (let x = 0; x + cellsWide <= this.columns; x++) {
        if (this.isFree(x, y, cellsWide, cellsHigh)) return { cellX: x, cellY: y };
      }
    }
    return null;
  }

  private isFree(x: number, y: number, cellsWide: number, cellsHigh: number): boolean {
    for (let dy = 0; dy < cellsHigh; dy++) {
      for (let dx = 0; dx < cellsWide; dx++) if (this.cells[(y + dy) * this.columns + x + dx]) return false;
    }
    return true;
  }

  private occupy(x: number, y: number, cellsWide: number, cellsHigh: number, value: number): void {
    for (let dy = 0; dy < cellsHigh; dy++) {
      for (let dx = 0; dx < cellsWide; dx++) this.cells[(y + dy) * this.columns + x + dx] = value;
    }
  }

  residentCount(): number {
    return this.resident.size;
  }

  slotOf(chart: number): { x: number; y: number; width: number; height: number; mip: number } | null {
    const entry = this.resident.get(chart);
    if (!entry) return null;
    return { x: entry.cellX * CELL, y: entry.cellY * CELL, width: entry.cellsWide * CELL, height: entry.cellsHigh * CELL, mip: entry.mip };
  }

  residentMip(chart: number): number | null {
    return this.resident.get(chart)?.mip ?? null;
  }

  usedCells(): number {
    let used = 0;
    for (const value of this.cells) used += value;
    return used;
  }

  totalCells(): number {
    return this.cells.length;
  }

  sampler(): { sample: (uv1: THREE.Node) => THREE.Node } {
    const atlas = texture(this.texture);
    const atlasSize = float(this.size);
    const sourceSize = this.sourceAtlasSize;
    const table = this.table;
    const sample = Fn(([uv1]: [THREE.Node]) => {
      const chart = int(attribute('lightmapChart', 'float').add(0.5));
      const geometry = vec4(textureLoad(table, ivec2(int(0), chart)));
      const entry = vec4(textureLoad(table, ivec2(int(1), chart)));
      const root = vec4(textureLoad(table, ivec2(int(2), chart)));
      const rootColour = vec3(textureLoad(this.texture, ivec2(int(root.x), int(root.y))));

      const scale = exp2(entry.x);
      const localTexel = vec2(uv1).mul(vec2(sourceSize)).sub(geometry.xy).div(scale);
      const levelSize = vec2(geometry.zw).div(scale).max(vec2(1));
      const clamped = localTexel.clamp(vec2(0.5), levelSize.sub(vec2(0.5)));
      const physical = vec2(entry.y, entry.z).add(clamped).div(atlasSize);
      const detail = vec3(atlas.sample(physical));
      return entry.w.greaterThan(float(0.5)).select(detail, rootColour);
    });
    return { sample: (uv1: THREE.Node) => sample(uv1) };
  }

  dispose(): void {
    this.target.dispose();
    this.table.dispose();
  }
}
