import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, clamp, dot, float, floor, fract, int, ivec2, length, max, min, mix, perspectiveDepthToViewZ,
  rtt, smoothstep, textureLoad, uniform, uv, vec2, vec4,
} from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export interface MotionBlurSettings {
  enabled: boolean;
  /** Fraction of the frame interval the shutter is open (film: 180° = 0.5). */
  shutter: number;
  /** Samples along the blur line per pixel. */
  samples: number;
  /**
   * Longest blur in pixels and the TileMax tile size (boot-time: it sizes the tile
   * targets). 20 px at 1600 wide is a 180° shutter at a brisk pan.
   */
  maxRadius: number;
  /** Depth separation, metres, over which a sample stops counting as "same surface". */
  depthExtent: number;
}

/** Off by default: the user finds motion blur unnatural and turns it off in every game. */
export const DEFAULT_MOTION_BLUR: Readonly<MotionBlurSettings> = {
  enabled: false,
  shutter: 0.5,
  samples: 12,
  maxRadius: 20,
  depthExtent: 0.1,
};

/**
 * Per-pixel motion blur as a reconstruction filter (McGuire, Hennessy, Bukowski,
 * Osman, "A Reconstruction Filter for Plausible Motion Blur", I3D 2012), reworked for
 * this frame graph rather than imported:
 *
 *  - the velocity is the scene pass's own motion-vector attachment (three's velocity
 *    node for rigid meshes, `vertexMotion.ts` for wind-displaced foliage), an NDC
 *    delta per pixel, turned into a pixel displacement scaled by the shutter fraction
 *    and clamped to `maxRadius`;
 *  - TileMax (dominant velocity per k×k tile) and NeighborMax (3×3 tiles) are render-
 *    to-texture nodes inside the composite graph, so they run in the same frame as
 *    the colour they blur, in dependency order, with no CPU dispatch and no lag;
 *  - the reconstruction gathers S samples along the tile's dominant velocity through
 *    the pixel, weighting each by the paper's three cases — a blurry sample in front
 *    of the pixel smears over it (its own cone), the pixel's own blur reveals what is
 *    behind it (the pixel's cone), and two samples moving together share their
 *    cylinders — with a soft depth comparison in view-space metres and a blue-noise
 *    jitter along the line so the sample pattern does not band. The centre sample is
 *    weighted 1/|v| so a still pixel keeps its exact colour.
 *
 * Runs after the temporal resolve (the history stays sharp) and before exposure.
 */
export class MotionBlur {
  readonly settings: MotionBlurSettings;
  readonly uShutter = uniform(0.5);
  readonly uSamples = uniform(12, 'int');
  readonly uDepthExtent = uniform(0.1);
  private readonly uSize = uniform(new THREE.Vector2(1, 1));
  private readonly uTiles = uniform(new THREE.Vector2(1, 1));
  private readonly k: number;
  private tileMax: N = null;
  private neighborMax: N = null;
  private width = 0;
  private height = 0;

  constructor(settings: Partial<MotionBlurSettings> = {}) {
    this.settings = { ...DEFAULT_MOTION_BLUR, ...settings };
    this.k = Math.max(4, Math.round(this.settings.maxRadius));
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  /**
   * Per-frame uniforms; call before the composite renders. On a camera cut (`cut`)
   * the shutter closes for the frame: the velocities are a teleport, not motion.
   */
  update(width: number, height: number, cut = false): void {
    const s = this.settings;
    this.uShutter.value = cut ? 0 : s.shutter;
    this.uSamples.value = Math.max(1, Math.min(32, Math.round(s.samples)));
    this.uDepthExtent.value = Math.max(1e-3, s.depthExtent);
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.uSize.value.set(width, height);
      const tx = Math.ceil(width / this.k), ty = Math.ceil(height / this.k);
      this.uTiles.value.set(tx, ty);
      this.tileMax?.setSize(tx, ty);
      this.neighborMax?.setSize(tx, ty);
    }
  }

  /** Pixel-space velocity of the texel at `px` (integer coords), shutter-scaled and clamped. */
  private pixelVelocity(velocityTex: THREE.Texture, px: N): N {
    const ndc = textureLoad(velocityTex, px).xy;
    // NDC delta (current − previous), y up; pixels, y down.
    const v = vec2(ndc.x.mul(0.5).mul(this.uSize.x), ndc.y.mul(-0.5).mul(this.uSize.y)).mul(this.uShutter);
    const len = length(v);
    return v.mul(min(len, float(this.k)).div(max(len, 1e-4)));
  }

  /**
   * The blurred colour for the composite. `colour(uv)` samples the resolved frame,
   * `velocityTex`/`depthTex` are the scene pass's attachments, `near`/`far` the
   * camera's planes as nodes.
   */
  apply(colour: (uv: N) => N, velocityTex: THREE.Texture, depthTex: THREE.Texture, near: N, far: N): N {
    const k = this.k;
    const size = this.uSize;
    const tiles = this.uTiles;
    const tx = Math.max(1, Math.ceil(Math.max(1, this.width) / k)), ty = Math.max(1, Math.ceil(Math.max(1, this.height) / k));

    // TileMax: the dominant (longest) velocity of each k×k tile.
    const tileMaxFn = Fn(() => {
      const tile = ivec2(floor(uv().mul(tiles)));
      const origin = tile.mul(k);
      const best = vec2(0).toVar();
      const bestLen = float(-1).toVar();
      Loop({ start: int(0), end: int(k), type: 'int', condition: '<' }, ({ i }: { i: N }) => {
        Loop({ start: int(0), end: int(k), type: 'int', condition: '<' }, ({ i: j }: { i: N }) => {
          const px = origin.add(ivec2(j, i));
          If(px.x.lessThan(int(size.x)).and(px.y.lessThan(int(size.y))), () => {
            const v = this.pixelVelocity(velocityTex, px);
            const l = dot(v, v);
            If(l.greaterThan(bestLen), () => { bestLen.assign(l); best.assign(v); });
          });
        });
      });
      return vec4(best, 0, 1);
    });
    this.tileMax = rtt(tileMaxFn(), tx, ty, { type: THREE.HalfFloatType });
    this.tileMax.renderTarget.texture.name = 'MotionBlur.tileMax';

    // NeighborMax: the dominant velocity over the 3×3 tile neighbourhood, so a fast
    // tile smears into its neighbours (the blur reaches past the tile edge).
    // Read through the RTT nodes themselves (not their textures): a node that is not in
    // the graph is never rendered.
    const tileNode = this.tileMax;
    const neighborMaxFn = Fn(() => {
      const tile = ivec2(floor(uv().mul(tiles)));
      const best = vec2(0).toVar();
      const bestLen = float(-1).toVar();
      for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
        const t = clamp(tile.add(ivec2(x, y)), ivec2(0), ivec2(tiles).sub(1));
        const v = tileNode.load(t).xy;
        const l = dot(v, v);
        If(l.greaterThan(bestLen), () => { bestLen.assign(l); best.assign(v); });
      }
      return vec4(best, 0, 1);
    });
    this.neighborMax = rtt(neighborMaxFn(), tx, ty, { type: THREE.HalfFloatType });
    this.neighborMax.renderTarget.texture.name = 'MotionBlur.neighborMax';
    const neighborNode = this.neighborMax;

    const viewDepth = (px: N) => perspectiveDepthToViewZ(textureLoad(depthTex, px).r, near, far).negate();
    // 1 when `a` is in front of (nearer than) `b`, fading to 0 over the depth extent.
    const softDepthCompare = (a: N, b: N) => clamp(float(1).sub(a.sub(b).div(this.uDepthExtent)), 0, 1);
    const cone = (dist: N, v: N) => clamp(float(1).sub(dist.div(max(length(v), 1e-4))), 0, 1);
    const cylinder = (dist: N, v: N) => {
      const l = length(v);
      return float(1).sub(smoothstep(l.mul(0.95), l.mul(1.05).add(1e-4), dist));
    };

    return Fn(() => {
      const fragUv = uv();
      const px = ivec2(floor(fragUv.mul(size))).toVar();
      const maxPx = ivec2(size).sub(1);
      const tile = clamp(px.div(int(k)), ivec2(0), ivec2(tiles).sub(1));
      const vN = neighborNode.load(tile).xy;
      const centre = colour(fragUv);
      const result = vec4(centre).toVar();
      If(length(vN).greaterThan(0.5), () => {
        const vX = this.pixelVelocity(velocityTex, px);
        const zX = viewDepth(px);
        // Karis-free: the centre counts 1/|v|, so a still pixel is exactly itself.
        const weight = float(1).div(max(length(vX), 0.5)).toVar();
        const sum = vec4(centre).mul(weight).toVar();
        // Jitter along the line per pixel so the sample pattern does not band. The TAA
        // has already run, so this is display noise: interleaved gradient noise
        // (Jimenez 2014), a fine regular dither, and no frame term — a per-frame seed
        // would crawl with nothing left to average it, and its large products lost
        // float32 precision.
        const jitter = fract(float(52.9829189).mul(fract(float(px.x).mul(0.06711056).add(float(px.y).mul(0.00583715))))).sub(0.5);
        const samples = this.uSamples;
        Loop({ start: int(0), end: samples, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
          const t = mix(float(-1), float(1), float(i).add(jitter).add(1).div(float(samples).add(1)));
          const py = clamp(ivec2(floor(vec2(px).add(0.5).add(vN.mul(t)))), ivec2(0), maxPx);
          If(py.x.notEqual(px.x).or(py.y.notEqual(px.y)), () => {
            const dist = length(vec2(py.sub(px)));
            const vY = this.pixelVelocity(velocityTex, py);
            const zY = viewDepth(py);
            const front = softDepthCompare(zY, zX);
            const back = softDepthCompare(zX, zY);
            const w = front.mul(cone(dist, vY))
              .add(back.mul(cone(dist, vX)))
              .add(cylinder(dist, vY).mul(cylinder(dist, vX)).mul(2));
            const uvY = vec2(py).add(0.5).div(size);
            sum.addAssign(vec4(colour(uvY)).mul(w));
            weight.addAssign(w);
          });
        });
        result.assign(sum.div(max(weight, 1e-4)));
      });
      return result;
    })();
  }

  dispose(): void {
    this.tileMax?.renderTarget.dispose();
    this.neighborMax?.renderTarget.dispose();
  }
}
