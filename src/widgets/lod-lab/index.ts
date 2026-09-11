import * as THREE from 'three/webgpu';
import type { LightmapLod } from '../../shared/gi/lod/index.ts';

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

  constructor(private readonly renderer: THREE.WebGPURenderer, private readonly lod: LightmapLod) {
    this.element = document.createElement('div');
    this.element.id = 'lod-lab';
    this.header = document.createElement('div');
    this.header.className = 'lab-header';
    this.view = document.createElement('canvas');
    this.view.width = lod.atlas.size;
    this.view.height = lod.atlas.size;
    this.legend = document.createElement('div');
    this.legend.className = 'lab-legend';
    this.legend.innerHTML = MIP_COLOURS.map((colour, mip) => `<span><i style="background:${colour}"></i>mip ${mip}</span>`).join('');
    this.element.append(this.header, this.view, this.legend);
    document.body.append(this.element, labStyle());
    const context = this.view.getContext('2d');
    if (!context) throw new Error('lod lab: no 2D context');
    this.context = context;
    this.image = document.createElement('canvas');
    this.image.width = this.image.height = lod.atlas.size;
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
      const size = this.lod.atlas.size;
      const pixels = await this.renderer.readRenderTargetPixelsAsync(this.lod.atlas.target, 0, 0, size, size);
      const context = this.image.getContext('2d');
      if (!context) return;
      const rgba = context.createImageData(size, size);
      for (let texel = 0; texel < size * size; texel++) {
        for (let channel = 0; channel < 3; channel++) {
          const value = decode(pixels, texel * 4 + channel);
          rgba.data[texel * 4 + channel] = Math.round(255 * Math.min(1, (value / (1 + value)) ** (1 / 2.2)));
        }
        rgba.data[texel * 4 + 3] = 255;
      }
      context.putImageData(rgba, 0, 0);
    } finally {
      this.reading = false;
    }
  }

  private draw(): void {
    const size = this.lod.atlas.size;
    this.context.clearRect(0, 0, size, size);
    this.context.drawImage(this.image, 0, 0);
    this.context.lineWidth = 1;
    for (const demand of this.lod.plan.demands) {
      const slot = this.lod.atlas.slotOf(demand.chart);
      if (!slot) continue;
      this.context.strokeStyle = MIP_COLOURS[Math.min(slot.mip, MIP_COLOURS.length - 1)];
      this.context.strokeRect(slot.x + 0.5, slot.y + 0.5, slot.width - 1, slot.height - 1);
    }
  }

  private writeHeader(): void {
    const atlas = this.lod.atlas;
    const plan = this.lod.plan;
    const mips: Record<number, number> = {};
    for (const demand of plan.demands) mips[demand.mip] = (mips[demand.mip] ?? 0) + 1;
    const spread = Object.entries(mips).map(([mip, count]) => `mip ${mip}: ${count}`).join(' · ') || 'nothing resident';
    this.header.innerHTML =
      `<b>source pages</b> ${this.lod.pool.pages.length} × ${this.lod.pool.pageSize}² = ${(this.lod.pool.bytes / 1048576).toFixed(1)} MiB` +
      ` · <b>working atlas</b> ${atlas.size}² = ${((atlas.size * atlas.size * 8) / 1048576).toFixed(1)} MiB` +
      `<br>on screen <b>${plan.visible}</b> charts · wanted <b>${plan.wantedCells}</b> cells · granted <b>${plan.grantedCells}</b>` +
      ` of ${atlas.totalCells()} · coarsened <b>${plan.coarsened}</b> steps · copies this frame <b>${atlas.copiesLastFrame}</b>` +
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
    #lod-lab canvas { image-rendering: pixelated; width: min(calc(48vw - var(--lod-lab-gutter, 0px)), calc(100vh - 120px));
      height: auto; border: 1px solid #232a33; background: #05070a; }
    #lod-lab .lab-header { line-height: 1.6; text-align: center; }
    #lod-lab .lab-legend { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
    #lod-lab .lab-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 4px; border-radius: 2px; }
  `;
  return style;
}
