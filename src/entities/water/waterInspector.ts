import * as THREE from 'three/webgpu';
import type { ShallowWater } from './shallowWater.ts';
import type { IslandField } from '../island/heightField.ts';

/**
 * A window into the water that the beauty frame cannot give: the simulated surface
 * seen from above as numbers, and a cross-section through it with the bathymetry.
 *
 * `?waterInspect=1` (or `=z:-1.5` to pick the section line, world z in metres). Reads
 * the state back once a second and draws two panels in the corner:
 *   left  — top-down map: surface elevation above the water line (blue below, white
 *           above), foam in red, dry cells dark; the section line in yellow.
 *   right — section along that line: sand/rock floor (brown), water surface (blue),
 *           still-water line (grey), 10× vertical exaggeration.
 * Also prints min/max/mean depth, |velocity| and wet fraction. Used to see the shape
 * of the water directly instead of guessing it from shading.
 */
export class WaterInspector {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private nextReadAt = 0;
  private busy = false;
  private sectionZ: number;
  private readonly readFoam: (() => Promise<{ size: number; foam: Float32Array; wetness: Float32Array }>) | null;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly bathymetry: THREE.Texture | null;
  private foamField: { size: number; foam: Float32Array; wetness: Float32Array } | null = null;
  /** The bed as the solver sees it (read back once), else the field's analytic stamps. */
  private bed: { size: number; height: Float32Array } | null = null;
  private bedRequested = false;

  constructor(
    renderer: THREE.WebGPURenderer,
    private readonly sim: ShallowWater,
    private readonly field: IslandField,
    options: { sectionZ?: number; readFoam?: () => Promise<{ size: number; foam: Float32Array; wetness: Float32Array }>; bathymetry?: THREE.Texture } = {},
  ) {
    this.renderer = renderer;
    this.bathymetry = options.bathymetry ?? null;
    this.readFoam = options.readFoam ?? null;
    this.sectionZ = options.sectionZ ?? -1.0;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 900;
    this.canvas.height = 320;
    this.canvas.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:30;background:rgba(6,10,16,.85);border:1px solid rgba(140,170,200,.3);border-radius:6px;image-rendering:pixelated';
    this.canvas.dataset.testid = 'water-inspector';
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  update(now: number): void {
    if (this.busy || now < this.nextReadAt) return;
    this.busy = true;
    this.nextReadAt = now + 1000;
    // Off the render loop: a readback issued while the frame's targets are bound
    // reads the wrong texture.
    const read = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const target = this.bathymetry?.userData.renderTarget as THREE.RenderTarget | undefined;
      if (target && !this.bedRequested) {
        this.bedRequested = true;
        const size = target.width;
        const raw = await this.renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size);
        const height = new Float32Array(size * size);
        const decode = raw instanceof Uint16Array ? (x: number) => THREE.DataUtils.fromHalfFloat(x) : (x: number) => x;
        for (let k = 0; k < size * size; k++) height[k] = decode(raw[k * 4]);
        this.bed = { size, height };
      }
      const state = await this.sim.readState();
      const foamField = this.readFoam ? await this.readFoam() : null;
      return { state, foamField };
    };
    void read().then(({ state, foamField }) => {
      this.foamField = foamField;
      this.draw(state);
      this.busy = false;
    }).catch((error) => {
      console.warn('[water-inspector]', error);
      this.busy = false;
    });
  }

  /** Bed height at world (x, z): the solver's texture when read back, else the field. */
  private bedHeight(x: number, z: number): number {
    if (!this.bed) return this.field.obstacleHeight(x, z);
    const { size, height } = this.bed;
    const half = this.field.half;
    const u = Math.max(0, Math.min(size - 1, Math.floor(((x + half) / (2 * half)) * size)));
    const v = Math.max(0, Math.min(size - 1, Math.floor(((z + half) / (2 * half)) * size)));
    return height[v * size + u];
  }

  private draw(state: { size: number; depth: Float32Array; u: Float32Array; v: Float32Array; foam: Float32Array }): void {
    const { size, depth, u, v, foam } = state;
    const ctx = this.ctx;
    const half = this.field.half;
    const level = this.field.waterLevel;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // --- map --------------------------------------------------------------------
    const mapSize = 300;
    const image = ctx.createImageData(mapSize, mapSize);
    let dMin = Infinity, dMax = -Infinity, dSum = 0, speedMax = 0, wet = 0, etaMin = Infinity, etaMax = -Infinity;
    for (let j = 0; j < mapSize; j++) {
      for (let i = 0; i < mapSize; i++) {
        const sx = Math.floor((i / mapSize) * size);
        const sz = Math.floor((j / mapSize) * size);
        const k = sz * size + sx;
        const d = depth[k];
        const x = -half + ((sx + 0.5) / size) * 2 * half;
        const z = -half + ((sz + 0.5) / size) * 2 * half;
        const b = this.bedHeight(x, z);
        const o = (j * mapSize + i) * 4;
        if (d > 0.003) {
          const eta = b + d - level;
          const t = Math.max(-1, Math.min(1, eta / 0.08));
          image.data[o] = t > 0 ? 120 + 135 * t : 30;
          image.data[o + 1] = t > 0 ? 160 + 95 * t : 90 + 60 * (1 + t);
          image.data[o + 2] = t > 0 ? 200 + 55 * t : 150 + 100 * (1 + t);
          if (foam[k] > 0.2) { image.data[o] = 255; image.data[o + 1] = 60; image.data[o + 2] = 60; }
          etaMin = Math.min(etaMin, eta); etaMax = Math.max(etaMax, eta);
          wet++;
        } else {
          // Dry sand, darkened by the wetness field (the swash that has been here).
          let wetness = 0;
          if (this.foamField) {
            const fs = this.foamField.size;
            wetness = this.foamField.wetness[Math.floor((j / mapSize) * fs) * fs + Math.floor((i / mapSize) * fs)];
          }
          const k2 = 1 - 0.7 * Math.min(1, wetness);
          image.data[o] = 170 * k2; image.data[o + 1] = 140 * k2; image.data[o + 2] = 100 * k2;
        }
        image.data[o + 3] = 255;
      }
    }
    for (let k = 0; k < size * size; k++) {
      const d = depth[k];
      dMin = Math.min(dMin, d); dMax = Math.max(dMax, d); dSum += d;
      speedMax = Math.max(speedMax, Math.hypot(u[k], v[k]));
    }
    ctx.putImageData(image, 10, 10);
    const lineY = 10 + ((this.sectionZ + half) / (2 * half)) * mapSize;
    ctx.strokeStyle = '#ffd24a';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(10, lineY); ctx.lineTo(10 + mapSize, lineY); ctx.stroke();

    // --- sections: the whole column at ×2, the surface alone at ×25 --------------
    const sz = Math.max(0, Math.min(size - 1, Math.floor(((this.sectionZ + half) / (2 * half)) * size)));
    const drawSection = (x0: number, y0: number, w: number, h: number, zoom: number, span: number, withFloor: boolean) => {
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(x0, y0, w, h);
      const yOf = (worldY: number) => y0 + h * 0.5 - (worldY - level) * zoom * (h / span);
      ctx.strokeStyle = 'rgba(200,200,200,0.5)'; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x0, yOf(level)); ctx.lineTo(x0 + w, yOf(level)); ctx.stroke(); ctx.setLineDash([]);
      if (withFloor) {
        ctx.strokeStyle = '#b08a52'; ctx.lineWidth = 2; ctx.beginPath();
        for (let i = 0; i < size; i++) {
          const x = -half + ((i + 0.5) / size) * 2 * half;
          const b = this.bedHeight(x, this.sectionZ);
          const px = x0 + (i / (size - 1)) * w;
          if (i === 0) ctx.moveTo(px, yOf(b)); else ctx.lineTo(px, yOf(b));
        }
        ctx.stroke();
      }
      ctx.strokeStyle = '#4fc3ff'; ctx.lineWidth = 2; ctx.beginPath();
      let pen = false;
      for (let i = 0; i < size; i++) {
        const k = sz * size + i;
        const d = depth[k];
        const x = -half + ((i + 0.5) / size) * 2 * half;
        const b = this.bedHeight(x, this.sectionZ);
        const px = x0 + (i / (size - 1)) * w;
        if (d > 0.003) { const py = yOf(b + d); if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py); }
        else pen = false;
      }
      ctx.stroke();
      ctx.fillStyle = '#9fb3c8'; ctx.font = '10px ui-monospace, Consolas, monospace';
      ctx.fillText(`×${zoom}`, x0 + 4, y0 + 12);
    };
    drawSection(330, 10, 550, 120, 2, 6, true);
    drawSection(330, 140, 550, 130, 25, 6, false);
    const x0 = 330, y0 = 10, h = 260;

    ctx.fillStyle = '#d7e6f5';
    ctx.font = '11px ui-monospace, Consolas, monospace';
    const n = size * size;
    ctx.fillText(`section z=${this.sectionZ.toFixed(2)} m · sections ×2 / ×25 · grid ${size}² (${(this.sim.cell * 100).toFixed(1)} cm) · sim t=${this.sim.simTime.toFixed(1)} s`, x0, y0 + h + 16);
    ctx.fillText(`depth min ${dMin.toFixed(3)} max ${dMax.toFixed(3)} mean ${(dSum / n).toFixed(3)} m · η−level ${etaMin.toFixed(3)}..${etaMax.toFixed(3)} m · |u| max ${speedMax.toFixed(2)} m/s · wet ${((wet / (mapSize * mapSize)) * 100).toFixed(0)}%`, x0, y0 + h + 32);
  }
}
