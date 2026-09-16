import * as THREE from 'three/webgpu';
import { Fn, attribute, dFdx, dFdy, float, uniform, vec2, vec4 } from 'three/tsl';
import { Layer } from '../../world/index.ts';

const NOT_REQUESTED = 255;

/**
 * @important The demand is read off the frame, not walked over the world. The design says
 * it three times - screen size and actual reads, the camera reports demand instead of
 * iterating, and a CPU pass over every triangle is what the removed version did wrong - so
 * the request is rasterised by the same geometry that will read the light: each fragment
 * writes its chart and the level its own UV derivatives call for, `log2(max(|dX|, |dY|))`
 * over the source-map texel, which is the quantity the document defines.
 *
 * It is a sparse grid of fragments rather than a second full G-buffer, which the document
 * rules out: the target is the frame divided by `spacing` in each direction, one fragment
 * in sixteen at the default 4. Atomics in the material were the first attempt and three's
 * WGSL backend refuses them - "Atomic operations are only supported in compute shaders" -
 * so repeated requests for one chart collapse on the readback instead.
 */
export class DemandFeedback {
  readonly requests: Uint32Array;
  private readonly target: THREE.RenderTarget;
  private readonly material: THREE.NodeMaterial;
  private readonly sourceSize = uniform(new THREE.Vector2(1, 1));
  private reading = false;
  private frame = 0;
  private pixels = 0;
  readsDone = 0;
  drawnLastRead = 0;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly scene: THREE.Scene,
    charts: number,
    sourceAtlas: { width: number; height: number },
    private readonly spacing: number,
  ) {
    this.requests = new Uint32Array(charts).fill(NOT_REQUESTED);
    this.sourceSize.value.set(sourceAtlas.width, sourceAtlas.height);
    this.target = new THREE.RenderTarget(2, 2, { depthBuffer: true, generateMipmaps: false });
    this.target.texture.colorSpace = THREE.NoColorSpace;
    this.material = new THREE.MeshBasicNodeMaterial();
    this.material.colorNode = Fn(() => {
      const chart = attribute('lightmapChart', 'float').add(float(0.5)).floor();
      const sourceTexel = attribute('uv1', 'vec2').mul(vec2(this.sourceSize));
      const lambda = dFdx(sourceTexel).length().max(dFdy(sourceTexel).length()).max(float(1e-6)).log2().clamp(float(0), float(15));
      return vec4(chart.div(float(256)).floor().div(float(255)), chart.mod(float(256)).div(float(255)), lambda.floor().div(float(255)), float(1));
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
  }

  /**
   * @important The request pass runs before the plan and its readback lands a cycle later,
   * so the plan always works from a frame that was actually drawn. Nothing in the render
   * loop waits for it: while a readback is in flight the previous answer stands.
   */
  render(camera: THREE.Camera): void {
    this.frame++;
    if (this.pixels === 0) return;
    const previousTarget = this.renderer.getRenderTarget();
    const previousOverride = this.scene.overrideMaterial;
    const previousLayers = camera.layers.mask;
    camera.layers.set(Layer.LightmapDemand);
    this.scene.overrideMaterial = this.material;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.scene, camera);
    this.renderer.setRenderTarget(previousTarget);
    camera.layers.mask = previousLayers;
    this.scene.overrideMaterial = previousOverride;
    if (this.frame % this.spacing === 0) void this.collect();
  }

  private async collect(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const raw = await this.renderer.readRenderTargetPixelsAsync(this.target, 0, 0, this.target.width, this.target.height);
      const fresh = new Uint32Array(this.requests.length).fill(NOT_REQUESTED);
      this.readsDone++;
      this.drawnLastRead = 0;
      for (let pixel = 0; pixel < raw.length; pixel += 4) {
        if (raw[pixel + 3] === 0) continue;
        this.drawnLastRead++;
        const chart = raw[pixel] * 256 + raw[pixel + 1];
        if (chart >= fresh.length) continue;
        const mip = raw[pixel + 2];
        if (mip < fresh[chart]) fresh[chart] = mip;
      }
      this.requests.set(fresh);
    } catch (error) {
      console.warn(`[lod] demand readback failed: ${error}`);
    } finally {
      this.reading = false;
    }
  }

  requested(chart: number): number | null {
    const mip = this.requests[chart];
    return mip === NOT_REQUESTED ? null : mip;
  }

  count(): number {
    let asked = 0;
    for (const mip of this.requests) if (mip !== NOT_REQUESTED) asked++;
    return asked;
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
