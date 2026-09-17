import * as THREE from 'three/webgpu';
import type { LightmapLod } from '../../shared/gi/lod/index.ts';
import { readFloatTexture } from '../../shared/render/gpuReadback.ts';

const MIP_COLOURS = ['#ff4d4d', '#ff9f40', '#ffe04d', '#7fd158', '#4db8ff', '#9a7bff'];
const READBACK_INTERVAL = 12;

/**
 * @important The right pane is the WORKING atlas, read back from the GPU, not the baked
 * one: the whole point is what the assembler chose to keep for this view. Readback is
 * async and throttled because it stalls nothing only while it stays off the frame's
 * critical path.
 */
export class LodLab {
  readonly element: HTMLElement;
  private readonly view: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly header: HTMLElement;
  private readonly legend: HTMLElement;
  private readonly image: HTMLCanvasElement;
  private frame = 0;
  private reading = false;
  private reported = false;

  constructor(private readonly renderer: THREE.WebGPURenderer, private readonly lod: LightmapLod) {
    this.element = document.createElement('div');
    this.element.id = 'lod-lab';
    this.header = document.createElement('div');
    this.header.className = 'lab-header';
    this.view = document.createElement('canvas');
    this.view.width = lod.pool.width;
    this.view.height = lod.pool.height;
    this.legend = document.createElement('div');
    this.legend.className = 'lab-legend';
    this.legend.innerHTML = MIP_COLOURS.map((colour, mip) => `<span><i style="background:${colour}"></i>level ${mip}</span>`).join('');
    this.element.append(this.header, this.view, this.legend);
    document.body.append(this.element, labStyle());
    const context = this.view.getContext('2d');
    if (!context) throw new Error('lod lab: no 2D context');
    this.context = context;
    this.image = document.createElement('canvas');
    this.image.width = lod.pool.width;
    this.image.height = lod.pool.height;
  }

  update(): void {
    this.frame++;
    if (this.frame % READBACK_INTERVAL === 0) void this.readAtlas();
    this.draw();
    this.writeHeader();
  }

  private async readAtlas(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const { width, height } = this.lod.pool;
      const pixels = (await readFloatTexture(this.renderer, this.lod.pool.texture)).data;
      const context = this.image.getContext('2d');
      if (!context) return;
      const rgba = context.createImageData(width, height);
      for (let texel = 0; texel < width * height; texel++) {
        for (let channel = 0; channel < 3; channel++) {
          const value = decode(pixels, texel * 4 + channel);
          rgba.data[texel * 4 + channel] = Math.round(255 * Math.min(1, (value / (1 + value)) ** (1 / 2.2)));
        }
        rgba.data[texel * 4 + 3] = 255;
      }
      context.putImageData(rgba, 0, 0);
      if (!this.reported) {
        this.reported = true;
        let max = 0;
        for (let index = 0; index < pixels.length; index++) max = Math.max(max, decode(pixels, index));
        console.log(`[lod-lab] readback ${width}x${height} ${pixels.constructor.name} of ${pixels.length}, max ${max}`);
      }
    } catch (error) {
      console.warn(`[lod-lab] atlas readback failed: ${error}`);
    } finally {
      this.reading = false;
    }
  }

  private draw(): void {
    const side = this.lod.pyramids.physicalTile;
    const slotsPerSide = Math.round(this.lod.pool.size / side);
    this.context.clearRect(0, 0, this.lod.pool.width, this.lod.pool.height);
    this.context.drawImage(this.image, 0, 0);
    this.context.lineWidth = 1;
    for (const key of this.lod.pool.residency.residentKeys()) {
      const slot = this.lod.pool.residency.slotOf(key)!;
      const level = this.lod.pyramids.tiles[key].level;
      this.context.strokeStyle = MIP_COLOURS[Math.min(level, MIP_COLOURS.length - 1)];
      this.context.strokeRect((slot % slotsPerSide) * side + 0.5, Math.floor(slot / slotsPerSide) * side + 0.5, side - 1, side - 1);
    }
  }

  private writeHeader(): void {
    const { pyramids, pool } = this.lod;
    const stats = pool.residency.stats;
    const levels: Record<number, number> = {};
    for (const key of pool.residency.residentKeys()) levels[pyramids.tiles[key].level] = (levels[pyramids.tiles[key].level] ?? 0) + 1;
    const spread = Object.entries(levels).map(([level, count]) => `level ${level}: ${count}`).join(' · ') || 'nothing resident';
    this.header.innerHTML =
      `<b>tiles</b> ${pyramids.tiles.length} × ${pyramids.tileSize}² in tab memory · <b>tail</b> ${pyramids.tailSize}² · ${(pool.storeBytes / 1048576).toFixed(1)} MiB` +
      `<br><b>pool</b> ${pool.residency.residentKeys().length} / ${pool.residency.capacity} slots (${pool.size}²)` +
      `<br>asked <b>${stats.asked}</b> · planned <b>${stats.planned}</b> · coarsened <b>${stats.coarsened}</b> · copies <b>${stats.copies}</b> (${(pool.uploadedBytesLastFrame / 1024).toFixed(0)} KiB) · released <b>${stats.released}</b> · refused <b>${stats.refused}</b>` +
      `<br>${spread}`;
  }
}

function decode(pixels: ArrayLike<number>, index: number): number {
  const value = pixels[index];
  return Number.isInteger(value) && value > 2 ? THREE.DataUtils.fromHalfFloat(value) : value;
}

function labStyle(): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = `
    body.lod-lab canvas:not(#lod-lab canvas) { width: 50vw !important; }
    #lod-lab { position: fixed; top: 0; right: var(--lod-lab-gutter, 0px); width: calc(50vw - var(--lod-lab-gutter, 0px));
      height: 100vh; background: #0b0d10; color: #cfd6df; font: 12px ui-monospace, Consolas, monospace;
      display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 10px 0; box-sizing: border-box; z-index: 5; }
    #lod-lab canvas { image-rendering: pixelated; width: auto; height: auto; max-width: calc(48vw - var(--lod-lab-gutter, 0px)); max-height: calc(100vh - 120px);
      border: 1px solid #232a33; background: #05070a; }
    #lod-lab .lab-header { line-height: 1.6; text-align: center; }
    #lod-lab .lab-legend { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
    #lod-lab .lab-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 4px; border-radius: 2px; }
  `;
  return style;
}
