import * as THREE from 'three/webgpu';
import { Fn, float, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';

/**
 * The free surface, baked once per frame into one texture over the slab
 * (docs/water/grill-session.md Q11/Q23/Q31): D = (η − level, ∂η/∂x, ∂η/∂z, film depth).
 *
 * Everything that needs the surface — the mesh, the fragment normal, the foam field,
 * the caustic map, the sand — samples this texture. The spectral wind sum and the
 * solver's height are evaluated here, at field resolution, exactly once; the cost of
 * the surface no longer scales with the screen.
 */
export interface SurfaceFieldOptions {
  renderer: THREE.WebGPURenderer;
  /** Texels across the slab. */
  size?: number;
  half: number;
  waterLevel: number;
  /** Absolute height of the simulated surface at world xz (metres). */
  simHeight: (xz: THREE.Node) => THREE.Node;
  /** Wind waves at world xz: (height, ∂/∂x, ∂/∂z). */
  wind: (xz: THREE.Node) => THREE.Node;
  /** 0 at the slab boundary, 1 inside: the surface stays sealed to the cut faces. */
  rim: (xz: THREE.Node) => THREE.Node;
  /** The wind sum is capped so a freak superposition cannot pierce the sand. */
  windCap: number;
  /** Water depth over the bed at world xz, smoothly reconstructed; goes to W. */
  film: (xz: THREE.Node) => THREE.Node;
}

export class SurfaceField {
  readonly size: number;
  /** Metres per texel. */
  readonly texel: number;
  /** The field as its readers sample it. */
  readonly node: ReturnType<typeof texture>;
  private readonly target: THREE.RenderTarget;
  private readonly quad: THREE.QuadMesh;
  private readonly renderer: THREE.WebGPURenderer;

  constructor(options: SurfaceFieldOptions) {
    const { renderer, size = 1024, half, waterLevel, simHeight, wind, rim, windCap, film } = options;
    this.renderer = renderer;
    this.size = size;
    this.texel = (2 * half) / size;
    this.target = new THREE.RenderTarget(size, size, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.name = 'waterSurfaceField';
    this.target.texture.minFilter = THREE.LinearFilter;
    this.target.texture.magFilter = THREE.LinearFilter;
    this.target.texture.wrapS = this.target.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.node = texture(this.target.texture);

    const level = uniform(waterLevel);
    const slabHalf = uniform(half);
    const material = new THREE.MeshBasicNodeMaterial();
    material.name = 'waterSurfaceField';
    material.transparent = false;
    material.blending = THREE.NoBlending;
    material.depthTest = false;
    material.depthWrite = false;
    const h = float(this.texel);
    material.toneMapped = false;
    // Signed data (slopes), so the raw fragment output, not the colour chain.
    material.fragmentNode = Fn(() => {
      const q = uv();
      // Texture v runs down the image; world +z runs down the slab in the same sense
      // as the simulation and the foam field (see ShallowWater.uvOf).
      const xz = q.sub(0.5).mul(2.0).mul(slabHalf);
      type F = ReturnType<typeof float>;
      type V3 = ReturnType<typeof vec3>;
      const mask = rim(xz) as F;
      const at = (o: ReturnType<typeof vec2>) => simHeight(xz.add(o)) as F;
      // Solver surface: height and its slope by central differences at the texel.
      const etaC = simHeight(xz) as F;
      const etaL = at(vec2(h.negate(), 0.0));
      const etaR = at(vec2(h, 0.0));
      const etaB = at(vec2(0.0, h.negate()));
      const etaF = at(vec2(0.0, h));
      const simSlope = vec2(etaR.sub(etaL), etaF.sub(etaB)).div(h.mul(2.0));
      // Wind waves ride on it; the rim seals both to the still-water line.
      const w = wind(xz) as V3;
      const eta = etaC.sub(level).add(w.x.min(float(windCap))).mul(mask);
      const slope = simSlope.add(w.yz).mul(mask);
      return vec4(eta, slope.x, slope.y, film(xz) as F);
    })();
    this.quad = new THREE.QuadMesh(material);
  }

  /** Re-bakes the field from the current solver state and wind clock. */
  update(): void {
    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    renderer.setRenderTarget(previousTarget);
  }

  /**
   * The free surface at one world point, read back from the GPU: height over the
   * still-water line and the two slopes, bilinear between the four texels around it.
   * One 2x2 read; for a body floating on the water, not for the frame's shading.
   */
  async readAt(x: number, z: number): Promise<{ eta: number; slopeX: number; slopeZ: number }> {
    const span = this.texel * this.size;
    const px = (x / span + 0.5) * this.size - 0.5;
    const pz = (z / span + 0.5) * this.size - 0.5;
    const i = Math.max(0, Math.min(this.size - 2, Math.floor(px)));
    const j = Math.max(0, Math.min(this.size - 2, Math.floor(pz)));
    const raw = await this.renderer.readRenderTargetPixelsAsync(this.target, i, j, 2, 2);
    const decode = raw instanceof Uint16Array ? (v: number) => THREE.DataUtils.fromHalfFloat(v) : (v: number) => v;
    const fx = Math.max(0, Math.min(1, px - i));
    const fz = Math.max(0, Math.min(1, pz - j));
    const at = (corner: number, channel: number) => decode(raw[corner * 4 + channel]);
    const lerp2 = (channel: number) =>
      (at(0, channel) * (1 - fx) + at(1, channel) * fx) * (1 - fz) + (at(2, channel) * (1 - fx) + at(3, channel) * fx) * fz;
    return { eta: lerp2(0), slopeX: lerp2(1), slopeZ: lerp2(2) };
  }

  /** Field uv of a world xz. */
  uvOf(xz: THREE.Node) {
    return (xz as ReturnType<typeof vec2>).div(this.texel * this.size).add(0.5);
  }
}
