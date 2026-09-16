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
  rank: number;
}

export interface AtlasDemand {
  chart: number;
  mip: number;
  /** Position in the plan's priority order: 0 is the chart the camera is closest to. */
  rank: number;
}

/**
 * @important Frames a chart keeps its room after the plan stops naming it. A chart that
 * leaves the frustum for a single frame - a wall the camera pans past and back - used to
 * give its slot up at once and buy it again out of the copy budget: a step turn released
 * 19 to 25 charts and refused 4 to 9 every frame. The room is only actually taken when
 * somebody planned needs it.
 */
const KEEP_UNPLANNED_FRAMES = 90;

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
  private wastedCells = 0;
  private planSignature = 0;
  copiesLastFrame = 0;
  refusedLastFrame = 0;
  releasedLastFrame = 0;

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
      this.tableData[row + 10] = this.pool.lastMip(chart);
    }
    this.tableDirty = true;
  }

  beginFrame(): void {
    this.frame++;
    this.copiesLastFrame = 0;
    this.refusedLastFrame = 0;
    this.releasedLastFrame = 0;
  }

  freeCells(): number {
    return this.cells.length - this.rootCells;
  }

  /**
   * @important What the planner may promise, which is less than what is free. The planner
   * counts area and the packer needs rectangles, so a plan that fits on paper can have
   * nowhere to put its last charts: with 4030 of 4032 cells promised, 37 of 270 charts
   * were refused and re-tried every frame for ever, each refusal evicting somebody who
   * came back the next frame. The gap is not guessed - it is the room the packer actually
   * failed to use, grown by each refusal and given back once a frame places everything it
   * was asked for.
   */
  plannableCells(): number {
    return Math.max(this.rootCells, this.freeCells() - this.wastedCells);
  }

  /**
   * @important The plan is the authority over the whole atlas, not a list of requests
   * laid on top of what is already there. A chart the plan does not name gives its room
   * back before anything is placed, and a chart the plan does name is never evicted to
   * make space for another one it also names: without the first rule the atlas stayed
   * full of the previous camera's charts and the new ones could not fit, and without the
   * second the last charts of the plan evicted the first ones every frame, so the copy
   * budget was spent in full every frame for ever and the surfaces that never won the
   * race stayed on their root - the black bands along the bottom of the village walls.
   */
  serve(demands: AtlasDemand[], copyBudget: number): void {
    /** @important The room the packer could not use is forgotten when the plan changes
     * and kept while it does not. Giving a cell back on every quiet frame instead made the
     * planner refine one chart, the packer refuse it, and the pair repeat for ever: the
     * atlas never reached a frame with nothing to copy. */
    const signature = demands.reduce((hash, demand) => (hash * 31 + demand.chart * 8 + demand.mip) % 2147483647, demands.length);
    if (signature !== this.planSignature) { this.planSignature = signature; this.wastedCells = 0; }
    const planned = new Map(demands.map((demand) => [demand.chart, demand.rank]));
    for (const [chart, entry] of this.resident) {
      if (planned.has(chart)) entry.rank = planned.get(chart)!;
      else if (this.frame - entry.usedFrame > KEEP_UNPLANNED_FRAMES) { this.release(chart); this.releasedLastFrame++; }
      else entry.rank = Number.MAX_SAFE_INTEGER;
    }
    for (const demand of demands) {
      const current = this.resident.get(demand.chart);
      if (current && current.mip === demand.mip) { current.usedFrame = this.frame; continue; }
      if (this.copiesLastFrame >= copyBudget) break;
      if (this.place(demand.chart, demand.mip, demand.rank)) this.copiesLastFrame++;
      else { this.refusedLastFrame++; this.wastedCells += this.cellsOf(demand.chart, demand.mip); }
    }
    if (this.tableDirty) { this.table.needsUpdate = true; this.tableDirty = false; }
  }

  private cellsOf(chart: number, mip: number): number {
    const slice = this.pool.slice(chart, mip);
    return Math.ceil((slice.width + 2 * PAGE_GUTTER) / CELL) * Math.ceil((slice.height + 2 * PAGE_GUTTER) / CELL);
  }

  private place(chart: number, mip: number, rank: number): boolean {
    const slice = this.pool.slice(chart, mip);
    const cellsWide = Math.ceil((slice.width + 2 * PAGE_GUTTER) / CELL);
    const cellsHigh = Math.ceil((slice.height + 2 * PAGE_GUTTER) / CELL);
    let spot = this.findFree(cellsWide, cellsHigh);
    while (!spot && this.evictForRank(rank, chart)) spot = this.findFree(cellsWide, cellsHigh);
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

    this.resident.set(chart, { mip, cellX: spot.cellX, cellY: spot.cellY, cellsWide, cellsHigh, usedFrame: this.frame, rank });
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

  /**
   * @important Room is taken from the back of the plan, not from the oldest tenant. The
   * planner counts area and the packer needs a rectangle, so a plan that fits on paper can
   * still have nowhere to put its last charts; refusing to evict anything the plan names
   * left 26 of 270 planned charts refused every frame for ever on a standing camera, which
   * reads as a surface stuck on its flat root. A chart may only take room from one the
   * plan ranks lower than itself, so the camera's own surfaces win and the far ones give
   * way, and a chart can never evict its way into a loop with an equal.
   */
  private evictForRank(rank: number, keep: number): boolean {
    const order = [...this.resident.entries()].sort((a, b) => b[1].rank - a[1].rank);
    for (const [chart, entry] of order) {
      if (chart === keep || entry.rank <= rank || entry.usedFrame === this.frame) continue;
      this.release(chart);
      return true;
    }
    return false;
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
