import * as THREE from 'three/webgpu';
import {
  Fn,
  abs,
  clamp,
  float,
  length,
  max,
  min,
  mix,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec4,
} from 'three/tsl';

/**
 * Shallow-water simulation of the lagoon on the GPU.
 *
 * Physics: the Saint-Venant (shallow water) equations, depth-averaged — the right
 * model when the wavelength is long against the depth, which a 2.5 m lagoon with a
 * 3 m swell is. Discretised with the virtual-pipe scheme (Mei, Decaudin, Hu 2007;
 * the same family as Kass & Miller 1990's height-field waves): every cell holds a
 * water column `d` over the bathymetry `b`, and exchanges volume with its four
 * neighbours through pipes whose flow accelerates with the free-surface difference
 * `g·(H − H_n)/l`, `H = b + d`. Volume is conserved exactly, cells run dry and wet
 * again on the beach (run-up), waves refract around the boulders, shoal over the
 * shallows and reflect off the walls, all from the equations rather than from any
 * authored pattern. Wave speed comes out as √(g·d) in the linear limit.
 *
 * Stability is explicit-CFL: `dt < l / √(g·d_max)`; the caller sub-steps.
 *
 * State texture RGBA = (d, u, v, foam source); flux texture RGBA = outflow to
 * (−x, +x, −z, +z). Two ping-pong pairs, four quad draws per sub-step.
 */
export interface ShallowWaterOptions {
  renderer: THREE.WebGPURenderer;
  /** Bathymetry, R16F over the slab square: the island height texture. */
  bathymetry: THREE.Texture;
  half: number;
  waterLevel: number;
  size?: number;
  /** Incoming swell at the open sides (−x and +z faces): amplitude (m) and period (s). */
  swellAmplitude?: number;
  swellPeriod?: number;
}

export class ShallowWater {
  readonly size: number;
  /** Metres per cell. */
  readonly cell: number;
  /** State as the renderer reads it; the texture is swapped after every step. */
  readonly stateNode: ReturnType<typeof texture>;
  readonly swellAmplitude: ReturnType<typeof uniform>;
  readonly swellPeriod: ReturnType<typeof uniform>;
  readonly friction = uniform(0.12);

  private readonly renderer: THREE.WebGPURenderer;
  private readonly half: number;
  private stateRead: THREE.RenderTarget;
  private stateWrite: THREE.RenderTarget;
  private fluxRead: THREE.RenderTarget;
  private fluxWrite: THREE.RenderTarget;
  private readonly statePrev: ReturnType<typeof texture>;
  private readonly fluxPrev: ReturnType<typeof texture>;
  private readonly dt = uniform(0.004);
  private readonly clock = uniform(0);
  private readonly fluxQuad: THREE.QuadMesh;
  private readonly heightQuad: THREE.QuadMesh;
  private readonly initQuad: THREE.QuadMesh;
  private readonly zeroQuad: THREE.QuadMesh;
  private initialised = false;
  private _simTime = 0;

  constructor(options: ShallowWaterOptions) {
    const { renderer, bathymetry, half, waterLevel, size = 512, swellAmplitude = 0.06, swellPeriod = 1.4 } = options;
    this.renderer = renderer;
    this.half = half;
    this.size = size;
    this.cell = (2 * half) / size;
    this.swellAmplitude = uniform(swellAmplitude);
    this.swellPeriod = uniform(swellPeriod);

    const makeTarget = () => {
      const target = new THREE.RenderTarget(size, size, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        depthBuffer: false,
        generateMipmaps: false,
      });
      target.texture.minFilter = THREE.LinearFilter;
      target.texture.magFilter = THREE.LinearFilter;
      target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;
      return target;
    };
    this.stateRead = makeTarget();
    this.stateWrite = makeTarget();
    this.fluxRead = makeTarget();
    this.fluxWrite = makeTarget();
    this.statePrev = texture(this.stateRead.texture);
    this.fluxPrev = texture(this.fluxRead.texture);
    this.stateNode = texture(this.stateRead.texture);

    const level = uniform(waterLevel);
    const slabHalf = uniform(half);
    const l = float(this.cell);
    const texel = float(1 / size);
    const g = float(9.81);
    const dt = this.dt;
    const bathy = texture(bathymetry);

    type Uv = Parameters<typeof bathy.sample>[0];
    const bAt = (q: Uv) => bathy.sample(q).r;
    const dAt = (q: Uv) => this.statePrev.sample(q).r;
    const inside = (q: ReturnType<typeof vec2>) =>
      step(0.0, q.x).mul(step(q.x, 1.0)).mul(step(0.0, q.y)).mul(step(q.y, 1.0));
    const asUv = (q: THREE.Node) => q as ReturnType<typeof vec2>;

    // Opaque node materials force alpha to 1 unless they do not blend at all, and the
    // fourth channel here is data (the +z flux, the foam source), not coverage.
    const dataMaterial = () => {
      const material = new THREE.MeshBasicNodeMaterial();
      material.transparent = false;
      material.blending = THREE.NoBlending;
      material.depthTest = false;
      material.depthWrite = false;
      return material;
    };

    // --- initial state: still water on the bathymetry --------------------------
    const initMaterial = dataMaterial();
    initMaterial.colorNode = Fn(() => {
      const q = uv();
      const d = max(level.sub(bAt(asUv(q))), 0.0);
      return vec4(d, 0.0, 0.0, 0.0);
    })();
    this.initQuad = new THREE.QuadMesh(initMaterial);
    const zeroMaterial = dataMaterial();
    zeroMaterial.colorNode = vec4(0.0);
    this.zeroQuad = new THREE.QuadMesh(zeroMaterial);

    // --- flux pass: accelerate the four pipes by the surface slope ---------------
    const fluxMaterial = dataMaterial();
    fluxMaterial.colorNode = Fn(() => {
      const q = uv();
      const d = dAt(asUv(q));
      const H = bAt(asUv(q)).add(d);
      const f = this.fluxPrev.sample(asUv(q)).toVar();
      const offsets: Array<[number, number]> = [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ];
      const next = vec4(0.0).toVar();
      const components = ['x', 'y', 'z', 'w'] as const;
      offsets.forEach(([ox, oz], i) => {
        const qn = asUv(q.add(vec2(ox, oz).mul(texel)));
        const dn = dAt(qn);
        const Hn = bAt(qn).add(dn);
        // Pipe cross-section = mean depth × cell width, length l: Δf = dt·A·g·ΔH/l =
        // dt·d̄·g·ΔH. This is what makes the wave speed √(g·d), the shallow-water one.
        const dEdge = max(d.add(dn).mul(0.5), 0.0);
        const accelerated = max(f[components[i]].add(dt.mul(dEdge).mul(g).mul(H.sub(Hn))), 0.0);
        // No pipe through the slab boundary.
        next[components[i]].assign(accelerated.mul(inside(qn)));
      });
      // A little of the neighbours' flow in each pipe: the collocated scheme's
      // odd-even mode (a sawtooth at cell scale) has nothing else to damp it.
      const fl = this.fluxPrev.sample(asUv(q.sub(vec2(texel, 0.0))));
      const fr = this.fluxPrev.sample(asUv(q.add(vec2(texel, 0.0))));
      const fb = this.fluxPrev.sample(asUv(q.sub(vec2(0.0, texel))));
      const ff = this.fluxPrev.sample(asUv(q.add(vec2(0.0, texel))));
      const smoothed = fl.add(fr).add(fb).add(ff).mul(0.25);
      next.assign(mix(next, max(smoothed, 0.0), 0.08));
      // Never drain more than the column holds this step.
      const total = next.x.add(next.y).add(next.z).add(next.w);
      const scale = min(float(1.0), d.mul(l).mul(l).div(total.mul(dt).add(1e-6)));
      // Bottom friction, linear in the flow.
      const damping = float(1.0).sub(dt.mul(this.friction)).max(0.0);
      return next.mul(scale).mul(damping);
    })();
    this.fluxQuad = new THREE.QuadMesh(fluxMaterial);

    // --- height pass: move the volume, derive velocity, drive the swell -----------
    const heightMaterial = dataMaterial();
    heightMaterial.colorNode = Fn(() => {
      const q = uv();
      const own = this.fluxPrev.sample(asUv(q));
      const left = this.fluxPrev.sample(asUv(q.sub(vec2(texel, 0.0))));
      const right = this.fluxPrev.sample(asUv(q.add(vec2(texel, 0.0))));
      const back = this.fluxPrev.sample(asUv(q.sub(vec2(0.0, texel))));
      const front = this.fluxPrev.sample(asUv(q.add(vec2(0.0, texel))));
      const inflow = left.y.add(right.x).add(back.w).add(front.z);
      const outflow = own.x.add(own.y).add(own.z).add(own.w);
      const d0 = dAt(asUv(q));
      const d = max(d0.add(dt.mul(inflow.sub(outflow)).div(l.mul(l))), 0.0).toVar();

      // Depth-averaged velocity from the net flow through the cell.
      const dMean = max(d0.add(d).mul(0.5), 0.002);
      const flowX = left.y.sub(own.x).add(own.y).sub(right.x).mul(0.5);
      const flowZ = back.w.sub(own.z).add(own.w).sub(front.z).mul(0.5);
      const u = flowX.div(l.mul(dMean));
      const v = flowZ.div(l.mul(dMean));

      // Swell generator on the open faces: the surface there follows the incoming
      // wave, a long crest running along each face and travelling into the slab.
      const b = bAt(asUv(q));
      const omega = float(2 * Math.PI).div(this.swellPeriod);
      const xz = q.sub(0.5).mul(2.0).mul(slabHalf);
      const phase = this.clock.mul(omega).sub(xz.x.add(xz.y.negate()).mul(0.9));
      const swell = level.add(this.swellAmplitude.mul(sin(phase)));
      const generatorL = smoothstep(0.03, 0.0, q.x);
      const generatorF = smoothstep(0.97, 1.0, q.y);
      const generator = max(generatorL, generatorF);
      const forced = max(swell.sub(b), 0.0);
      // Relax toward the incoming wave rather than impose it: a hard-set column next
      // to a free one is a step every sub-step, and the grid rings at its own scale.
      const relax = generator.mul(dt.mul(12.0)).min(1.0);
      d.assign(mix(d, forced, relax));

      // Foam is born where the flow is fast over shallow water (breaking, run-up)
      // and where the flow converges hard.
      const speed = length(vec2(u, v));
      const shallowFast = smoothstep(0.25, 0.9, speed).mul(smoothstep(0.35, 0.02, d)).mul(step(0.004, d));
      const converge = smoothstep(-1.5, -6.0, u.sub(left.y.sub(left.x).div(l.mul(dMean))).div(l).add(v.sub(back.w.sub(back.z).div(l.mul(dMean))).div(l)));
      const foam = clamp(max(shallowFast, converge.mul(0.8)), 0.0, 1.0);
      return vec4(d, clamp(u, -4.0, 4.0), clamp(v, -4.0, 4.0), foam);
    })();
    this.heightQuad = new THREE.QuadMesh(heightMaterial);
    void abs;
  }

  /** Largest stable sub-step for the deepest water the slab can hold. */
  stableStep(maxDepth: number): number {
    return (0.4 * this.cell) / Math.sqrt(9.81 * Math.max(0.05, maxDepth));
  }

  /** Advances the water by `dt` seconds, in as many sub-steps as CFL requires. */
  step(dt: number, maxDepth: number): void {
    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    if (!this.initialised) {
      renderer.setRenderTarget(this.stateRead);
      this.initQuad.render(renderer);
      renderer.setRenderTarget(this.fluxRead);
      this.zeroQuad.render(renderer);
      this.initialised = true;
    }
    const stable = this.stableStep(maxDepth);
    const steps = Math.min(8, Math.max(1, Math.ceil(dt / stable)));
    const sub = Math.min(dt / steps, stable);
    this.dt.value = sub;
    for (let i = 0; i < steps; i++) {
      this._simTime += sub;
      this.clock.value = this._simTime;
      this.statePrev.value = this.stateRead.texture;
      this.fluxPrev.value = this.fluxRead.texture;
      renderer.setRenderTarget(this.fluxWrite);
      this.fluxQuad.render(renderer);
      const fluxSwap = this.fluxRead;
      this.fluxRead = this.fluxWrite;
      this.fluxWrite = fluxSwap;
      this.fluxPrev.value = this.fluxRead.texture;
      renderer.setRenderTarget(this.stateWrite);
      this.heightQuad.render(renderer);
      const stateSwap = this.stateRead;
      this.stateRead = this.stateWrite;
      this.stateWrite = stateSwap;
    }
    renderer.setRenderTarget(previousTarget);
    this.stateNode.value = this.stateRead.texture;
  }

  get simTime(): number {
    return this._simTime;
  }

  /** The state read back from the GPU as floats (the target is half-float; decode it). */
  async readState(): Promise<{ size: number; depth: Float32Array; u: Float32Array; v: Float32Array; foam: Float32Array }> {
    const size = this.size;
    const raw = await this.renderer.readRenderTargetPixelsAsync(this.stateRead, 0, 0, size, size);
    const n = size * size;
    const depth = new Float32Array(n);
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const foam = new Float32Array(n);
    const decode = raw instanceof Uint16Array ? (x: number) => THREE.DataUtils.fromHalfFloat(x) : (x: number) => x;
    for (let i = 0; i < n; i++) {
      depth[i] = decode(raw[i * 4]);
      u[i] = decode(raw[i * 4 + 1]);
      v[i] = decode(raw[i * 4 + 2]);
      foam[i] = decode(raw[i * 4 + 3]);
    }
    return { size, depth, u, v, foam };
  }

  /** Min / max / mean of depth, |velocity| and foam over the grid. */
  async readStats(): Promise<Record<string, number>> {
    const { size, depth, u, v, foam } = await this.readState();
    let dMin = Infinity, dMax = -Infinity, dSum = 0, speedMax = 0, speedSum = 0, foamSum = 0, wet = 0;
    for (let i = 0; i < size * size; i++) {
      const speed = Math.hypot(u[i], v[i]);
      dMin = Math.min(dMin, depth[i]); dMax = Math.max(dMax, depth[i]); dSum += depth[i];
      speedMax = Math.max(speedMax, speed); speedSum += speed; foamSum += foam[i];
      if (depth[i] > 0.003) wet++;
    }
    const n = size * size;
    return { dMin, dMax, dMean: dSum / n, speedMax, speedMean: speedSum / n, foamMean: foamSum / n, wetFraction: wet / n, simTime: this._simTime };
  }

  /** Texture uv of a world (x, z) on the slab. */
  uvOf(xz: THREE.Node) {
    return (xz as ReturnType<typeof vec2>).div(this.half * 2).add(0.5);
  }

  /**
   * Runs the water forward before the first frame so a capture does not show a pond
   * that has not yet heard about the swell. Sub-steps only; no frame is drawn.
   */
  preroll(seconds: number, maxDepth: number): void {
    const stable = this.stableStep(maxDepth);
    const steps = Math.ceil(seconds / stable);
    for (let i = 0; i < steps; i += 8) this.step(Math.min(8, steps - i) * stable, maxDepth);
  }
}
