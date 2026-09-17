import * as THREE from 'three/webgpu';
import { Fn, attribute, dFdx, dFdy, exp2, float, floor, int, ivec2, max, min, texture, textureLoad, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { STORE_PAGE_SIZE, TILE_BORDER, type ChartPyramidSet } from './chartPyramids.ts';
import { CHART_RECORD_ENTRIES, PAGE_TABLE_WIDTH, TileResidency, type ResidencyOptions } from './tileResidency.ts';

function halfFloatTexture(renderer: THREE.WebGPURenderer, pixels: Float32Array, size: number, filter: THREE.MagnificationTextureFilter): THREE.DataTexture {
  const half = new Uint16Array(pixels.length);
  for (let index = 0; index < pixels.length; index++) half[index] = THREE.DataUtils.toHalfFloat(pixels[index]);
  const texture = new THREE.DataTexture(half, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.minFilter = texture.magFilter = filter;
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  renderer.initTexture(texture);
  return texture;
}

function floatTable(renderer: THREE.WebGPURenderer, data: Float32Array): THREE.DataTexture {
  const table = new THREE.DataTexture(data, PAGE_TABLE_WIDTH, data.length / 4 / PAGE_TABLE_WIDTH, THREE.RGBAFormat, THREE.FloatType);
  table.minFilter = table.magFilter = THREE.NearestFilter;
  table.generateMipmaps = false;
  table.needsUpdate = true;
  renderer.initTexture(table);
  return table;
}

/**
 * @important The tail lives inside the pool texture, not beside it. A fourth texture in the
 * lightmap read pushed the village sand material past WebGPU's 16 sampled textures per
 * shader stage: its bind group layout was invalid and the pipeline never compiled, with no
 * error naming the limit (2026-09-17, `?scene=village-light`; one texture fewer and the
 * error was gone). The read now binds the pool and the page table, as the chart atlas did.
 */
export class TilePool {
  readonly target: THREE.RenderTarget;
  readonly texture: THREE.Texture;
  readonly size: number;
  readonly width: number;
  readonly height: number;
  readonly residency: TileResidency;
  readonly storePages: THREE.DataTexture[];
  readonly tail: THREE.DataTexture;
  readonly pageTable: THREE.DataTexture;
  readonly storeBytes: number;
  private readonly sourceSize = uniform(new THREE.Vector2(1, 1));

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    readonly pyramids: ChartPyramidSet,
    sourceAtlas: { width: number; height: number },
    private readonly options: ResidencyOptions,
  ) {
    this.sourceSize.value.set(sourceAtlas.width, sourceAtlas.height);
    this.residency = new TileResidency(pyramids, options);
    this.size = options.slotsPerSide * pyramids.physicalTile;
    this.width = Math.max(this.size, pyramids.tailSize);
    this.height = this.size + pyramids.tailSize;
    this.target = new THREE.RenderTarget(this.width, this.height, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false });
    this.texture = this.target.texture;
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.NoColorSpace;
    renderer.initTexture(this.texture);
    this.storePages = pyramids.storePages.map((page) => halfFloatTexture(renderer, page, STORE_PAGE_SIZE, THREE.NearestFilter));
    this.tail = halfFloatTexture(renderer, pyramids.tailPixels, pyramids.tailSize, THREE.LinearFilter);
    renderer.copyTextureToTexture(this.tail, this.texture, null, new THREE.Vector2(0, this.size));
    this.pageTable = floatTable(renderer, this.residency.pageData);
    this.storeBytes = (pyramids.storePages.length * STORE_PAGE_SIZE * STORE_PAGE_SIZE + pyramids.tailSize * pyramids.tailSize) * 8;
  }

  serve(requested: Set<number>): void {
    const { copies, tableChanged } = this.residency.serve(requested);
    const side = this.pyramids.physicalTile;
    for (const { key, slot } of copies) {
      const tile = this.pyramids.tiles[key];
      const source = new THREE.Box2(new THREE.Vector2(tile.storeX, tile.storeY), new THREE.Vector2(tile.storeX + side, tile.storeY + side));
      const destination = new THREE.Vector2((slot % this.options.slotsPerSide) * side, Math.floor(slot / this.options.slotsPerSide) * side);
      this.renderer.copyTextureToTexture(this.storePages[tile.storePage], this.texture, source, destination);
    }
    if (tableChanged) this.pageTable.needsUpdate = true;
  }

  sampler(): { sample: (uv1: THREE.Node) => THREE.Node } {
    const { pageTable, sourceSize } = this;
    const chartRecordStart = float(this.residency.chartRecordStart);
    const poolTexture = this.texture;
    const tileSize = float(this.pyramids.tileSize);
    const physical = float(this.pyramids.physicalTile);
    const poolExtent = vec2(this.width, this.height);
    const tailOrigin = vec2(0, this.size);
    const tableWidth = float(PAGE_TABLE_WIDTH);
    const slotsPerSide = float(this.options.slotsPerSide);

    const load = (table: THREE.DataTexture, index: THREE.Node) =>
      vec4(textureLoad(table, ivec2(int(index.mod(tableWidth)), int(floor(index.div(tableWidth))))));
    const sizeAt = (size: THREE.Node, level: THREE.Node) => max(float(1), floor(size.div(exp2(level))));
    const localAt = (texel0: THREE.Node, rect: THREE.Node, level: THREE.Node) => {
      const extent = vec2(sizeAt(rect.z, level), sizeAt(rect.w, level));
      return texel0.mul(extent.div(rect.zw)).clamp(vec2(0.5), extent.sub(0.5));
    };

    const sample = Fn(([uv1]: [THREE.Node]) => {
      const record = chartRecordStart.add(floor(attribute('lightmapChart', 'float').add(0.5)).mul(float(CHART_RECORD_ENTRIES)));
      const rect = load(pageTable, record);
      const info = load(pageTable, record.add(1));
      const offsetsLow = load(pageTable, record.add(2));
      const offsetsHigh = load(pageTable, record.add(3));
      const tailLevel = info.x;

      const atlasTexel = vec2(uv1).mul(vec2(sourceSize));
      const texel0 = atlasTexel.sub(rect.xy);
      const footprint = max(dFdx(atlasTexel).length(), dFdy(atlasTexel).length()).max(float(1e-6));
      const wanted = min(max(floor(footprint.log2()), float(0)), tailLevel);

      const fromTail = vec3(texture(poolTexture, tailOrigin.add(info.zw).add(localAt(texel0, rect, tailLevel)).div(poolExtent)).level(float(0)));

      const tiledLevel = min(wanted, max(tailLevel.sub(1), float(0)));
      const levelIndex = int(tiledLevel);
      const offset = levelIndex.lessThan(int(4)).select(offsetsLow.element(levelIndex), offsetsHigh.element(levelIndex.sub(int(4))));
      const across = floor(sizeAt(rect.z, tiledLevel).add(tileSize.sub(1)).div(tileSize));
      const down = floor(sizeAt(rect.w, tiledLevel).add(tileSize.sub(1)).div(tileSize));
      const tile = floor(localAt(texel0, rect, tiledLevel).div(tileSize)).clamp(vec2(0), vec2(across.sub(1), down.sub(1)));
      const entry = load(pageTable, info.y.add(offset).add(tile.y.mul(across)).add(tile.x));

      const slot = vec2(entry.x.mod(slotsPerSide), floor(entry.x.div(slotsPerSide)));
      const inTile = localAt(texel0, rect, entry.y).sub(entry.zw.mul(tileSize));
      const fromPool = vec3(texture(poolTexture, slot.mul(physical).add(float(TILE_BORDER)).add(inTile).div(poolExtent)).level(float(0)));

      return wanted.lessThan(tailLevel).and(entry.y.lessThan(tailLevel)).select(fromPool, fromTail);
    });
    return { sample: (uv1: THREE.Node) => sample(uv1) };
  }

  dispose(): void {
    this.target.dispose();
    this.tail.dispose();
    this.pageTable.dispose();
    for (const page of this.storePages) page.dispose();
  }
}
