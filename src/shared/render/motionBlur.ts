import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, clamp, dot, float, floor, fract, instancedArray, int, ivec2, length, max, min, mix,
  perspectiveDepthToViewZ, rtt, smoothstep, texture, textureLoad, uniform, uv, vec2, vec4,
} from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/**
 * Whose motion the blur is relative to. `camera`: the film camera — every pixel
 * smears by its own screen velocity over the shutter. `centre`: the eye — the pixel
 * smears by its velocity relative to the point the eye is assumed to pursue, the
 * centre of the frame, over the visual system's integration window; the pursued
 * region stays sharp on its own (docs/render-research-2026-09-07.md, motion blur
 * as perception).
 */
export type MotionBlurGaze = 'camera' | 'centre';

export interface MotionBlurSettings {
  enabled: boolean;
  gaze: MotionBlurGaze;
  /** `camera` only: fraction of the frame interval the shutter is open (film: 180° = 0.5). */
  shutter: number;
  /**
   * `centre` only: the visual system's effective integration window, ms. Early
   * vision integrates ~100 ms (Burr 1980) but suppresses most of the smear it would
   * cause, by a third and more during pursuit (Bedell & Lott 1996); 30 ms is the
   * working estimate, not a measurement.
   */
  integrationMs: number;
  /** `centre` only: smooth-pursuit gain — the eye tracks ~90% of the target's velocity. */
  pursuitGain: number;
  /** `centre` only: time constant of the pursuit catching up with a new target velocity, ms. */
  pursuitLagMs: number;
  /** `centre` only: radius of the central window the gaze velocity is averaged over, fraction of the width. */
  gazeRadius: number;
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
  gaze: 'centre',
  shutter: 0.5,
  integrationMs: 30,
  pursuitGain: 0.9,
  pursuitLagMs: 120,
  gazeRadius: 0.08,
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
  /** Blur length per unit of per-frame pixel velocity: the shutter fraction, or the integration window in frames. */
  readonly uShutter = uniform(0.5);
  /** Pursuit gain applied to the gaze velocity; zero in `camera` mode. */
  private readonly uGazeGain = uniform(0);
  private readonly uGazeRadius = uniform(64);
  private readonly uGazeBlend = uniform(1);
  /** Storage, two floats: the smoothed gaze velocity in pixels per frame, written by the gaze kernel. */
  private readonly gazeBuffer: N;
  private gazeKernel: THREE.ComputeNode | null = null;
  private gazeSource: THREE.Texture | null = null;
  private lastTime = 0;
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
    this.gazeBuffer = instancedArray(new Float32Array(2), 'float').setName('motionBlurGaze');
  }

  /** The smoothed gaze velocity, pixels per frame (audit only; the frame never waits on it). */
  async readGaze(renderer: THREE.WebGPURenderer): Promise<[number, number]> {
    const data = new Float32Array(await renderer.getArrayBufferAsync(this.gazeBuffer.value));
    return [data[0], data[1]];
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  /**
   * Per-frame uniforms and the gaze kernel; call before the composite renders. On a
   * camera cut (`cut`) the shutter closes for the frame — the velocities are a
   * teleport, not motion — and the pursuit restarts on the new target (a saccade).
   */
  update(renderer: THREE.WebGPURenderer, velocityTex: THREE.Texture, depthTex: THREE.Texture, width: number, height: number, cut = false): void {
    const s = this.settings;
    const now = performance.now();
    const dt = this.lastTime === 0 ? 1 / 60 : Math.min(0.1, Math.max(1e-3, (now - this.lastTime) / 1000));
    this.lastTime = now;
    const perception = s.gaze === 'centre';
    this.uShutter.value = cut ? 0 : perception ? s.integrationMs / 1000 / dt : s.shutter;
    this.uGazeGain.value = perception ? s.pursuitGain : 0;
    this.uGazeRadius.value = Math.max(8, s.gazeRadius * width);
    this.uGazeBlend.value = cut ? 1 : 1 - Math.exp(-dt / Math.max(1e-3, s.pursuitLagMs / 1000));
    if (perception) {
      if (velocityTex !== this.gazeSource || !this.gazeKernel) {
        this.gazeSource = velocityTex;
        this.gazeKernel = this.buildGazeKernel(velocityTex, depthTex);
      }
      renderer.compute(this.gazeKernel, [1, 1, 1]);
    }
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

  /** NDC delta (current − previous, y up) to pixels per frame (y down). */
  private toPixels(ndc: N): N {
    return vec2(ndc.x.mul(0.5).mul(this.uSize.x), ndc.y.mul(-0.5).mul(this.uSize.y));
  }

  /**
   * The gaze velocity: the mean velocity of the surfaces under a 16x16 sample grid
   * over the central window, smoothed toward the previous value with the pursuit
   * lag. Samples with nothing drawn (depth at the far plane) do not count — the eye
   * pursues a thing, not the empty background between things; when the window holds
   * no surface at all the estimate stays where it was, the way pursuit coasts across
   * a gap. One thread, no readback; the composite reads the buffer.
   */
  private buildGazeKernel(velocityTex: THREE.Texture, depthTex: THREE.Texture): THREE.ComputeNode {
    const gaze = this.gazeBuffer;
    const size = this.uSize;
    const radius = this.uGazeRadius;
    const blend = this.uGazeBlend;
    return Fn(() => {
      const sum = vec2(0).toVar();
      const count = float(0).toVar();
      const centre = size.mul(0.5);
      Loop({ start: int(0), end: int(16), type: 'int', condition: '<' }, ({ i }: { i: N }) => {
        Loop({ start: int(0), end: int(16), type: 'int', condition: '<' }, ({ i: j }: { i: N }) => {
          const offset = vec2(float(j).add(0.5).div(16).sub(0.5), float(i).add(0.5).div(16).sub(0.5)).mul(radius.mul(2));
          const at = clamp(centre.add(offset).div(size), 0, 1);
          If(texture(depthTex, at).level(float(0)).r.lessThan(1), () => {
            sum.addAssign(this.toPixels(texture(velocityTex, at).level(float(0)).xy));
            count.addAssign(1);
          });
        });
      });
      const previous = vec2(gaze.element(0), gaze.element(1));
      const mean = sum.div(max(count, 1));
      const next = count.greaterThan(0).select(mix(previous, mean, blend), previous);
      gaze.element(0).assign(next.x);
      gaze.element(1).assign(next.y);
    })().computeKernel([1, 1, 1]).setName('Motion blur gaze');
  }

  /**
   * Blur-space velocity of the texel at `px` (integer coords): pixels per frame
   * relative to the pursued point, scaled to a blur length and clamped.
   */
  private pixelVelocity(velocityTex: THREE.Texture, px: N): N {
    const own = this.toPixels(textureLoad(velocityTex, px).xy);
    const pursued = vec2(this.gazeBuffer.element(0), this.gazeBuffer.element(1)).mul(this.uGazeGain);
    const v = own.sub(pursued).mul(this.uShutter);
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
        // Two sample lines, alternating (Guertin, McKee, Nowrouzezahrai, "A Fast and
        // Stable Feature-Aware Motion Blur Filter", HPG 2014): the tile's dominant
        // velocity, so a fast neighbour can smear over this pixel, and the pixel's
        // own, so a slow pixel inside a fast tile gathers its own short blur densely
        // instead of catching one or two of the tile's samples at random — measured
        // here as a striped 10 px smear on a coconut whose own motion was 3 px.
        const ownLine = length(vX).greaterThan(0.5).select(vX, vN);
        Loop({ start: int(0), end: samples, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
          const t = mix(float(-1), float(1), float(i).add(jitter).add(1).div(float(samples).add(1)));
          const line = i.mod(2).equal(0).select(vN, ownLine);
          const py = clamp(ivec2(floor(vec2(px).add(0.5).add(line.mul(t)))), ivec2(0), maxPx);
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

// bake-key probe: an edit outside the bake code
