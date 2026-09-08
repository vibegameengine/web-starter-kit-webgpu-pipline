import * as THREE from 'three/webgpu';
import { Fn, If, atomicAdd, atomicStore, clamp, exp, float, globalId, instancedArray, log2, luminance, max, texture, uint, uniform, vec2 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export interface ExposureSettings {
  /** Adapt to the scene's luminance; off = the fixed `manual` value. */
  auto: boolean;
  manual: number;
  /** Middle grey the metered average is mapped to (0.18 = photographic 18 %). */
  key: number;
  /** Exposure range in stops around 1.0, so a black screen or the sun cannot run away. */
  minEV: number;
  maxEV: number;
  /** Adaptation rates, 1/s; the eye brightens faster than it darkens. */
  speedUp: number;
  speedDown: number;
  /** Histogram percentiles the metered average is taken between (extremes ignored). */
  lowPercentile: number;
  highPercentile: number;
}

export const DEFAULT_EXPOSURE: Readonly<ExposureSettings> = {
  auto: true,
  manual: 1,
  key: 0.18,
  minEV: -3,
  maxEV: 3,
  speedUp: 3,
  speedDown: 1.5,
  lowPercentile: 0.1,
  highPercentile: 0.9,
};

const BINS = 64;
/** log2 luminance range the histogram spans: 2^-10 .. 2^6. */
const LOG_MIN = -10;
const LOG_RANGE = 16;

/**
 * Scene-referred auto exposure — the camera's light meter, not a post effect.
 *
 * Per frame: a 64-bin log2-luminance histogram of the resolved HDR frame (one thread
 * per 4x4 block, atomics on a storage buffer), then a one-thread pass that takes the
 * mean log luminance between the 10th and 90th percentile (so the sun disc or a black
 * border cannot drag it), maps it to middle grey, clamps to the EV range and adapts
 * toward it in log space with separate up/down rates, then zeroes the bins. The
 * result lives on the GPU; the composite multiplies by it before tone mapping, after
 * TAA (the history stays scene-referred). Nothing is read back.
 */
export class AutoExposure {
  readonly settings: ExposureSettings;
  /** Storage buffer, one float: the exposure multiplier the composite reads. */
  private readonly exposureBuffer: N;
  private readonly histogram: N;
  private readonly uDt = uniform(1 / 60);
  private readonly uKey = uniform(0.18);
  private readonly uMinExposure = uniform(0.125);
  private readonly uMaxExposure = uniform(8);
  private readonly uSpeedUp = uniform(3);
  private readonly uSpeedDown = uniform(1.5);
  private readonly uLowPercentile = uniform(0.1);
  private readonly uHighPercentile = uniform(0.9);
  private readonly uSize = uniform(new THREE.Vector2(1, 1));
  private readonly uManual = uniform(1);
  private readonly uAuto = uniform(1);
  private meter: THREE.ComputeNode | null = null;
  private adapt: THREE.ComputeNode | null = null;
  /**
   * The frame being metered, as one node whose texture is swapped per frame.
   *
   * Rebinding by rebuilding the kernel cost the whole compute program every frame:
   * the TAA hands over a ping-pong target, so the texture identity alternates, and
   * `renderer.compute` then re-ran the node builder. Measured 2026-09-08 at 4K:
   * 55% of the main thread inside `getForCompute` -> `build`, 25 ms frames.
   */
  private readonly sourceNode: N = texture(new THREE.Texture());

  constructor(private readonly renderer: THREE.WebGPURenderer, settings: Partial<ExposureSettings> = {}) {
    this.settings = { ...DEFAULT_EXPOSURE, ...settings };
    this.histogram = instancedArray(new Uint32Array(BINS), 'uint').toAtomic().setName('exposureHistogram');
    this.exposureBuffer = instancedArray(new Float32Array([1]), 'float').setName('exposureValue');
  }

  /** The exposure multiplier as a TSL node for the composite. */
  get node(): N {
    return this.exposureBuffer.element(0);
  }

  /** Reads the current multiplier back (audit only; the frame never waits on it). */
  async read(): Promise<number> {
    const data = await this.renderer.getArrayBufferAsync(this.exposureBuffer.value);
    return new Float32Array(data)[0];
  }

  /** Runs the meter on `source` (the resolved HDR frame) for this frame. */
  update(source: THREE.Texture, width: number, height: number, dt: number): void {
    const s = this.settings;
    this.sourceNode.value = source;
    if (!this.meter) this.build();
    this.uAuto.value = s.auto ? 1 : 0;
    this.uManual.value = s.manual;
    this.uSize.value.set(width, height);
    this.uDt.value = Math.min(0.25, Math.max(0, dt));
    this.uKey.value = s.key;
    this.uMinExposure.value = Math.pow(2, s.minEV);
    this.uMaxExposure.value = Math.pow(2, s.maxEV);
    this.uSpeedUp.value = s.speedUp;
    this.uSpeedDown.value = s.speedDown;
    this.uLowPercentile.value = s.lowPercentile;
    this.uHighPercentile.value = s.highPercentile;
    this.renderer.compute(this.meter!, [Math.ceil(width / 32), Math.ceil(height / 32), 1]);
    this.renderer.compute(this.adapt!, [1, 1, 1]);
  }

  private build(): void {
    const hist = this.histogram;
    const size = this.uSize;
    // One thread per 4x4 block of the frame: ~90k samples at 1600x900.
    this.meter = Fn(() => {
      const px = globalId.xy.mul(4).add(2);
      If(px.x.lessThan(uint(size.x)).and(px.y.lessThan(uint(size.y))), () => {
        const uv = vec2(px).add(0.5).div(size);
        const rgb = this.sourceNode.sample(uv).level(float(0)).rgb;
        const lum = max(luminance(rgb), 1e-6);
        const bin = clamp(log2(lum).sub(LOG_MIN).div(LOG_RANGE).mul(BINS), 0, BINS - 1);
        atomicAdd(hist.element(uint(bin)), uint(1));
      });
    })().computeKernel([8, 8, 1]).setName('Exposure meter');

    // One thread: walk the histogram, average the log luminance between the
    // percentiles, adapt, write, zero the bins for the next frame.
    this.adapt = Fn(() => {
      const counts: N[] = [];
      const total = float(0).toVar();
      for (let i = 0; i < BINS; i++) {
        const c = float(atomicAdd(hist.element(i), uint(0))).toVar();
        counts.push(c);
        total.addAssign(c);
      }
      const lowCut = total.mul(this.uLowPercentile);
      const highCut = total.mul(this.uHighPercentile);
      const seen = float(0).toVar();
      const sum = float(0).toVar();
      const count = float(0).toVar();
      for (let i = 0; i < BINS; i++) {
        const before = seen.toVar();
        seen.addAssign(counts[i]);
        // Portion of this bin inside [lowCut, highCut].
        const inside = seen.min(highCut).sub(before.max(lowCut)).max(0);
        sum.addAssign(inside.mul(LOG_MIN + ((i + 0.5) / BINS) * LOG_RANGE));
        count.addAssign(inside);
        atomicStore(hist.element(i), uint(0));
      }
      const avgLog2 = sum.div(count.max(1));
      const avgLum = exp(avgLog2.mul(Math.LN2));
      const target = clamp(this.uKey.div(avgLum.max(1e-6)), this.uMinExposure, this.uMaxExposure);
      const current = this.exposureBuffer.element(0).max(1e-4).toVar();
      const rate = target.greaterThan(current).select(this.uSpeedUp, this.uSpeedDown);
      const blend = float(1).sub(exp(rate.negate().mul(this.uDt)));
      // Adapt in log space so a stop up and a stop down take the same time.
      const next = current.mul(exp(log2(target.div(current)).mul(Math.LN2).mul(blend)));
      this.exposureBuffer.element(0).assign(this.uAuto.greaterThan(0.5).select(next, this.uManual));
    })().computeKernel([1, 1, 1]).setName('Exposure adapt');
  }
}
