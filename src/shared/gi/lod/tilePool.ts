import * as THREE from 'three/webgpu';
import { Fn, attribute, dFdx, dFdy, exp2, float, floor, int, ivec2, max, min, texture, textureLoad, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { TILE_BORDER, type ChartPyramidSet } from './chartPyramids.ts';
import { CHART_RECORD_ENTRIES, PAGE_TABLE_WIDTH, TileResidency, type ResidencyOptions } from './tileResidency.ts';

const HALF_FLOAT_TEXEL_BYTES = 8;
const FLOAT_TEXEL_BYTES = 16;

interface GpuBackend {
  device: GPUDevice;
  get(texture: THREE.Texture): { texture?: GPUTexture };
}

export interface TilePoolOptions extends ResidencyOptions {
  uploadBytesPerFrame: number;
}

function toHalfFloat(pixels: Float32Array): Uint16Array {
  const half = new Uint16Array(pixels.length);
  for (let index = 0; index < pixels.length; index++) half[index] = THREE.DataUtils.toHalfFloat(pixels[index]);
  return half;
}

function gpuOnlyTarget(renderer: THREE.WebGPURenderer, width: number, height: number, type: THREE.TextureDataType, filter: THREE.MagnificationTextureFilter): THREE.RenderTarget {
  const target = new THREE.RenderTarget(width, height, { type, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false });
  target.texture.minFilter = target.texture.magFilter = filter;
  target.texture.colorSpace = THREE.NoColorSpace;
  renderer.initTexture(target.texture);
  return target;
}

/**
 * @important Tiles live in the tab's memory, one half-float buffer each, and reach the GPU
 * through `device.queue.writeTexture` one slot at a time. Three cannot do this: setting
 * `needsUpdate` on a DataTexture uploads the whole texture from origin 0,0, so a pool that
 * three owns the data of would be re-sent whole for every tile, and any stray `needsUpdate`
 * would paint its stale array over tiles already resident. The pool and the page table are
 * GPU-only targets that three never uploads and that are never resized.
 *
 * The tail lives inside the pool texture, below the slots. A fourth texture in the read
 * pushed the village sand material past WebGPU's 16 sampled textures per shader stage: its
 * bind group layout was invalid and the pipeline never compiled, with no error naming the
 * limit (2026-09-17, `?scene=village-light`; one texture fewer and the error was gone).
 */
export class TilePool {
  readonly target: THREE.RenderTarget;
  readonly texture: THREE.Texture;
  readonly size: number;
  readonly width: number;
  readonly height: number;
  readonly residency: TileResidency;
  readonly tailSize: number;
  readonly storeBytes: number;
  readonly copyBudget: number;
  private readonly tileHalves: Uint16Array[];
  private readonly pageTarget: THREE.RenderTarget;
  private readonly sourceSize = uniform(new THREE.Vector2(1, 1));
  uploadedBytesLastFrame = 0;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    readonly pyramids: ChartPyramidSet,
    sourceAtlas: { width: number; height: number },
    private readonly options: TilePoolOptions,
  ) {
    this.sourceSize.value.set(sourceAtlas.width, sourceAtlas.height);
    const tileBytes = pyramids.physicalTile * pyramids.physicalTile * HALF_FLOAT_TEXEL_BYTES;
    this.copyBudget = Math.min(options.copyBudget, Math.max(1, Math.floor(options.uploadBytesPerFrame / tileBytes)));
    this.residency = new TileResidency(pyramids, { ...options, copyBudget: this.copyBudget });
    this.size = options.slotsPerSide * pyramids.physicalTile;
    this.tailSize = pyramids.tailSize;
    this.width = Math.max(this.size, this.tailSize);
    this.height = this.size + this.tailSize;
    this.target = gpuOnlyTarget(renderer, this.width, this.height, THREE.HalfFloatType, THREE.LinearFilter);
    this.texture = this.target.texture;
    this.tileHalves = pyramids.tiles.map((tile) => toHalfFloat(tile.pixels));
    this.storeBytes = this.tileHalves.length * tileBytes + this.tailSize * this.tailSize * HALF_FLOAT_TEXEL_BYTES;
    this.write(this.texture, toHalfFloat(pyramids.tailPixels), { x: 0, y: this.size, width: this.tailSize, height: this.tailSize }, HALF_FLOAT_TEXEL_BYTES);
    pyramids.releasePixels();
    const rows = this.residency.pageData.length / 4 / PAGE_TABLE_WIDTH;
    this.pageTarget = gpuOnlyTarget(renderer, PAGE_TABLE_WIDTH, rows, THREE.FloatType, THREE.NearestFilter);
    this.uploadPageTable();
  }

  serve(requested: Set<number>): void {
    const { copies } = this.residency.serve(requested);
    const side = this.pyramids.physicalTile;
    let bytes = 0;
    for (const { key, slot } of copies) {
      const slotX = (slot % this.options.slotsPerSide) * side;
      const slotY = Math.floor(slot / this.options.slotsPerSide) * side;
      this.write(this.texture, this.tileHalves[key], { x: slotX, y: slotY, width: side, height: side }, HALF_FLOAT_TEXEL_BYTES);
      bytes += this.tileHalves[key].byteLength;
    }
    bytes += this.uploadPageTable();
    this.uploadedBytesLastFrame = bytes;
  }

  private uploadPageTable(): number {
    const range = this.residency.takeDirtyEntries();
    if (!range) return 0;
    const firstRow = Math.floor(range.from / PAGE_TABLE_WIDTH);
    const lastRow = Math.floor(range.to / PAGE_TABLE_WIDTH);
    const rows = this.residency.pageData.subarray(firstRow * PAGE_TABLE_WIDTH * 4, (lastRow + 1) * PAGE_TABLE_WIDTH * 4);
    this.write(this.pageTarget.texture, rows, { x: 0, y: firstRow, width: PAGE_TABLE_WIDTH, height: lastRow - firstRow + 1 }, FLOAT_TEXEL_BYTES);
    return rows.byteLength;
  }

  private write(target: THREE.Texture, data: Uint16Array | Float32Array, region: { x: number; y: number; width: number; height: number }, bytesPerTexel: number): void {
    const backend = this.renderer.backend as unknown as GpuBackend;
    const gpuTexture = backend.get(target).texture;
    if (!gpuTexture) throw new Error('[lod] the pool texture has no GPU texture to write into');
    backend.device.queue.writeTexture(
      { texture: gpuTexture, origin: { x: region.x, y: region.y } },
      data.buffer as ArrayBuffer,
      { offset: data.byteOffset, bytesPerRow: region.width * bytesPerTexel },
      { width: region.width, height: region.height },
    );
  }

  sampler(): { sample: (uv1: THREE.Node) => THREE.Node } {
    const pageTable = this.pageTarget.texture;
    const poolTexture = this.texture;
    const sourceSize = this.sourceSize;
    const chartRecordStart = float(this.residency.chartRecordStart);
    const tileSize = float(this.pyramids.tileSize);
    const physical = float(this.pyramids.physicalTile);
    const poolExtent = vec2(this.width, this.height);
    const tailOrigin = vec2(0, this.size);
    const tableWidth = float(PAGE_TABLE_WIDTH);
    const slotsPerSide = float(this.options.slotsPerSide);

    const load = (index: THREE.Node) => vec4(textureLoad(pageTable, ivec2(int(index.mod(tableWidth)), int(floor(index.div(tableWidth))))));
    const sizeAt = (size: THREE.Node, level: THREE.Node) => max(float(1), floor(size.div(exp2(level))));
    const localAt = (texel0: THREE.Node, rect: THREE.Node, level: THREE.Node) => {
      const extent = vec2(sizeAt(rect.z, level), sizeAt(rect.w, level));
      return texel0.mul(extent.div(rect.zw)).clamp(vec2(0.5), extent.sub(0.5));
    };

    const sample = Fn(([uv1]: [THREE.Node]) => {
      const record = chartRecordStart.add(floor(attribute('lightmapChart', 'float').add(0.5)).mul(float(CHART_RECORD_ENTRIES)));
      const rect = load(record);
      const info = load(record.add(1));
      const offsetsLow = load(record.add(2));
      const offsetsHigh = load(record.add(3));
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
      const entry = load(info.y.add(offset).add(tile.y.mul(across)).add(tile.x));

      const slot = vec2(entry.x.mod(slotsPerSide), floor(entry.x.div(slotsPerSide)));
      const inTile = localAt(texel0, rect, entry.y).sub(entry.zw.mul(tileSize));
      const fromPool = vec3(texture(poolTexture, slot.mul(physical).add(float(TILE_BORDER)).add(inTile).div(poolExtent)).level(float(0)));

      return wanted.lessThan(tailLevel).and(entry.y.lessThan(tailLevel)).select(fromPool, fromTail);
    });
    return { sample: (uv1: THREE.Node) => sample(uv1) };
  }

  dispose(): void {
    this.target.dispose();
    this.pageTarget.dispose();
  }
}
