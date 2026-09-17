import * as THREE from 'three/webgpu';
import { Fn, attribute, dFdx, dFdy, float, max, uniform, vec2, vec4 } from 'three/tsl';
import { Layer } from '../../world/index.ts';

/* @important The alpha channel is one, and the chart and the level share red. Three's basic
   material multiplies colour by alpha on the way out, so the first packing - atlas y in
   alpha - came back as chart x y and atlas x x y: 33891 of 33907 fragments resolved to no
   tile and the pool held 16 tiles for the whole village (2026-09-17). */
const LEVELS_PER_CHART = 16;

export type TileResolver = (chart: number, level: number, atlasX: number, atlasY: number) => number | null;

/**
 * @important The demand is read off the frame, not walked over the world: each fragment of
 * a charted surface writes its chart, the level its own `uv1` derivatives call for in
 * atlas texels, and the atlas texel it reads, and the CPU turns that into a tile. The
 * target is a float target so the address is exact - RGBA8 cannot carry a chart number,
 * a level and a texel of a large chart. It is sparse (the frame divided by `spacing`) and
 * read asynchronously: the plan always works from a frame that was actually drawn, and
 * the frame never waits for it.
 */
export class DemandFeedback {
  requests = new Set<number>();
  private readonly target: THREE.RenderTarget;
  private readonly material: THREE.NodeMaterial;
  private readonly sourceSize = uniform(new THREE.Vector2(1, 1));
  private readonly pixelsPerFragment = uniform(1);
  private readonly clearColour = new THREE.Color();
  private reading = false;
  private frame = 0;
  private pixels = 0;
  readsDone = 0;
  drawnLastRead = 0;
  levelsLastRead: Record<number, number> = {};
  onTailLastRead = 0;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly scene: THREE.Scene,
    sourceAtlas: { width: number; height: number },
    private readonly spacing: number,
    private readonly resolve: TileResolver,
  ) {
    this.sourceSize.value.set(sourceAtlas.width, sourceAtlas.height);
    this.target = new THREE.RenderTarget(2, 2, { type: THREE.FloatType, depthBuffer: true, generateMipmaps: false });
    this.target.texture.colorSpace = THREE.NoColorSpace;
    this.material = new THREE.MeshBasicNodeMaterial();
    this.material.colorNode = Fn(() => {
      const chart = attribute('lightmapChart', 'float').add(float(0.5)).floor();
      const atlasTexel = attribute('uv1', 'vec2').mul(vec2(this.sourceSize));
      const footprint = max(dFdx(atlasTexel).length(), dFdy(atlasTexel).length()).div(this.pixelsPerFragment).max(float(1e-6));
      const level = footprint.log2().floor().clamp(float(0), float(15));
      return vec4(chart.add(float(1)).mul(float(LEVELS_PER_CHART)).add(level), atlasTexel.x, atlasTexel.y, float(1));
    })();
    this.material.fog = false;
    this.material.toneMapped = false;
  }

  resize(width: number, height: number): void {
    const wide = Math.max(2, Math.floor(width / this.spacing));
    const high = Math.max(2, Math.floor(height / this.spacing));
    if (this.target.width === wide && this.target.height === high) return;
    this.target.setSize(wide, high);
    this.pixels = wide * high;
    this.pixelsPerFragment.value = width / wide;
  }

  render(camera: THREE.Camera): void {
    this.frame++;
    if (this.pixels === 0) return;
    const previousTarget = this.renderer.getRenderTarget();
    const previousOverride = this.scene.overrideMaterial;
    const previousBackground = this.scene.background;
    const previousLayers = camera.layers.mask;
    const previousAlpha = this.renderer.getClearAlpha();
    (this.renderer as unknown as { getClearColor(target: THREE.Color): THREE.Color }).getClearColor(this.clearColour);
    camera.layers.set(Layer.LightmapDemand);
    this.scene.overrideMaterial = this.material;
    this.scene.background = null;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.scene, camera);
    this.renderer.setRenderTarget(previousTarget);
    this.renderer.setClearColor(this.clearColour as unknown as THREE.ColorRepresentation, previousAlpha);
    this.scene.background = previousBackground;
    this.scene.overrideMaterial = previousOverride;
    camera.layers.mask = previousLayers;
    if (this.frame % this.spacing === 0) void this.collect();
  }

  private async collect(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const raw = await this.renderer.readRenderTargetPixelsAsync(this.target, 0, 0, this.target.width, this.target.height) as Float32Array;
      const fresh = new Set<number>();
      let drawn = 0;
      let onTail = 0;
      const levels: Record<number, number> = {};
      for (let pixel = 0; pixel < raw.length; pixel += 4) {
        const packed = Math.round(raw[pixel]);
        const chart = Math.floor(packed / LEVELS_PER_CHART) - 1;
        if (chart < 0) continue;
        drawn++;
        const level = packed % LEVELS_PER_CHART;
        levels[level] = (levels[level] ?? 0) + 1;
        const key = this.resolve(chart, level, raw[pixel + 1], raw[pixel + 2]);
        if (key === null) onTail++;
        else fresh.add(key);
      }
      this.requests = fresh;
      this.drawnLastRead = drawn;
      this.levelsLastRead = levels;
      this.onTailLastRead = onTail;
      this.readsDone++;
    } catch (error) {
      console.warn(`[lod] demand readback failed: ${error}`);
    } finally {
      this.reading = false;
    }
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
