import * as THREE from 'three/webgpu';
import {
  Discard,
  Fn,
  If,
  abs,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraProjectionMatrixInverse,
  cameraViewMatrix,
  cameraProjectionMatrix,
  refract,
  cameraWorldMatrix,
  clamp,
  distance,
  dot,
  equirectUV,
  exp,
  float,
  fwidth,
  getViewPosition,
  max,
  min,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  mx_worley_noise_vec2,
  normalWorld,
  normalize,
  perspectiveDepthToViewZ,
  positionLocal,
  positionView,
  positionWorld,
  pow,
  reflect,
  screenUV,
  select,
  smoothstep,
  texture,
  time,
  transformNormalToView,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { IslandField } from '../island/heightField.ts';
import { WATER_ABSORB } from './medium.ts';
import { SurfaceField } from './surfaceField.ts';
import { Spray } from './spray.ts';
import { ShallowWater } from './shallowWater.ts';
import { WorkerWaterSim } from './simHost.ts';
import type { WaterSim } from './waterSim.ts';
import { WaterInspector } from './waterInspector.ts';
import { WindWaves } from './windWaves.ts';

export interface WaterOptions {
  renderer: THREE.WebGPURenderer;
  field: IslandField;
  /** Equirectangular HDR the sky reflection is read from. */
  environment: THREE.Texture;
  sun: THREE.DirectionalLight;
  /** How far below the water line the cut faces reach; the sand wall hides the rest. */
  cutDepth?: number;
  /** The bed as a height texture over the slab (see bathymetry.ts); the field's stamps otherwise. */
  bathymetry?: THREE.Texture;
  /**
   * Frames of shallow-water solver, foam and spray to run before the water holds
   * still. `Infinity` (the default) is live simulation. A finite count settles the
   * lagoon into its rest shape at boot and then freezes every field, so the surface
   * still refracts, reflects, absorbs and casts caustics — only its motion stops.
   * Only meaningful with `offThread: false`: the off-thread solver costs the frame
   * nothing to run, so there is nothing to freeze for.
   */
  simulationFrames?: number;
  /**
   * Run the solver on its own thread and its own WebGPU device (simWorker.ts).
   * Default. `false` keeps it in the frame, which is the A/B baseline: measured
   * 2026-09-08 at 4K, in-frame it is 25 quad renders of 384x384 per frame for
   * 0.37 ms GPU and 1.2 ms main-thread CPU.
   */
  offThread?: boolean;
}

/**
 * The bed exactly as the solver has it: the baked bathymetry read back once, so a
 * body floating on the water measures the same free surface the solver computed.
 * The analytic height field is not that bed — it carries the boulder stamps, and a
 * surface derived from it stood centimetres below the water the solver drew.
 */
class SolverBed {
  private grid: Float32Array | null = null;
  private size = 0;
  private reading = false;

  constructor(private readonly renderer: THREE.WebGPURenderer, private readonly bathymetry: THREE.Texture, private readonly field: IslandField) {}

  /** Reads the bed once, off the render loop; until it lands the analytic bed stands in. */
  request(): void {
    const target = this.bathymetry.userData.renderTarget as THREE.RenderTarget | undefined;
    if (this.grid || this.reading || !target) return;
    this.reading = true;
    setTimeout(() => {
      void this.renderer.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height).then((raw) => {
        const decode = raw instanceof Uint16Array ? (v: number) => THREE.DataUtils.fromHalfFloat(v) : (v: number) => v;
        const grid = new Float32Array(target.width * target.height);
        for (let i = 0; i < grid.length; i++) grid[i] = decode(raw[i * 4]);
        this.size = target.width;
        this.grid = grid;
      }).catch(() => undefined);
    }, 0);
  }

  at(x: number, z: number): number {
    const { grid, size } = this;
    if (!grid) return this.field.obstacleHeight(x, z);
    const half = this.field.half;
    const i = Math.max(0, Math.min(size - 1, Math.round(((x + half) / (2 * half)) * size - 0.5)));
    const j = Math.max(0, Math.min(size - 1, Math.round(((z + half) / (2 * half)) * size - 0.5)));
    return grid[j * size + i];
  }
}

/**
 * The free surface at one world point, taken from the solver's own thread: three
 * rows of cells around it, η = bed + depth, and the slopes by differences. No
 * readback of a render target on the frame — those stall the water they draw.
 */
async function sampleSurfaceAt(sim: WaterSim, bed: SolverBed, half: number, x: number, z: number) {
  const size = sim.size;
  const cell = (2 * half) / size;
  const column = Math.max(1, Math.min(size - 2, Math.round((x + half) / cell - 0.5)));
  const row = Math.max(1, Math.min(size - 2, Math.round((z + half) / cell - 0.5)));
  const [back, here, front] = await Promise.all([sim.readRow(row - 1), sim.readRow(row), sim.readRow(row + 1)]);
  const worldX = (i: number) => -half + (i + 0.5) * cell;
  const worldZ = (j: number) => -half + (j + 0.5) * cell;
  const eta = (depths: Float32Array, i: number, j: number) => bed.at(worldX(i), worldZ(j)) + depths[i];
  return {
    eta: eta(here, column, row),
    slopeX: (eta(here, column + 1, row) - eta(here, column - 1, row)) / (2 * cell),
    slopeZ: (eta(front, column, row + 1) - eta(back, column, row - 1)) / (2 * cell),
  };
}

/** What a body floating on this water needs to know (see entities/ball). */
export interface WaterFields {
  /** The free surface at a world point: height over the still line and its slopes. */
  sampleSurface(x: number, z: number): Promise<{ eta: number; slopeX: number; slopeZ: number }>;
  /** Bed height under a world point, absolute metres. */
  bedAt(x: number, z: number): number;
  waterLevel: number;
  half: number;
}

export interface Water {
  group: THREE.Group;
  fields: WaterFields;
  /**
   * Called with the time the solver itself advanced, every step: whatever floats
   * on this water moves on its clock, not the frame's.
   */
  onStep: ((simDelta: number) => void) | null;
  uniforms: {
    absorb: ReturnType<typeof uniform>;
    scatter: ReturnType<typeof uniform>;
    scatterStrength: ReturnType<typeof uniform>;
    envStrength: ReturnType<typeof uniform>;
    foamStrength: ReturnType<typeof uniform>;
    causticStrength: ReturnType<typeof uniform>;
    refractionStrength: ReturnType<typeof uniform>;
    sunColor: ReturnType<typeof uniform>;
    sunDir: ReturnType<typeof uniform>;
  };
  /**
   * Gives the water the frame graph's composited colour and the scene depth. The
   * materials are rebuilt around the new textures (texture identity is baked into the
   * pipeline), so this is called once per frame-graph rebuild, not per frame.
   */
  bindScreen(color: THREE.Texture, depth: THREE.Texture, normal: THREE.Texture): void;
  /** Art-direction knobs over the physics: the swell entering the slab and the wind. */
  controls: {
    swellAmplitude: number;
    swellPeriod: number;
    /** Degrees in the xz plane, 0 = toward +x, 90 = toward +z. */
    swellDirection: number;
    windSpeed: number;
    windDirection: number;
    /** Manning's n of the bed (sand 0.025, rock 0.035). */
    manning: number;
    apply(): void;
  };
  /** Advances the foam field by the elapsed time and refreshes the sun uniforms. */
  update(elapsedSeconds: number): void;
  /** Resolves once the solver has a field to draw (the off-thread preroll). */
  ready: Promise<void>;
  /** Called with the live foam/wetness field texture after every step. */
  onField?: (field: THREE.Texture) => void;
  /** Foam (R) and wetness (G) fields read back from the GPU, for the inspector. */
  readFoamField(): Promise<{ size: number; foam: Float32Array; wetness: Float32Array }>;
}


/**
 * Lagoon water as a single layer drawn over the composited scene (docs/water/knowledge-base.md).
 *
 * The material never blends: it reads the composited scene colour through a refracted
 * screen UV and the scene depth, reconstructs the floor under every pixel, and composes
 * the answer itself — scene colour under a per-channel Beer–Lambert transmittance along
 * the real underwater path, in-scattered light, caustics projected onto the floor, sky by
 * Fresnel, the sun's own GGX highlight and shadow from the standard light loop, and foam
 * from a persistent field fed by the solver's breaking and run-up sources. The solver's
 * surface plus the wind spectrum displace the mesh (see surfaceField.ts).
 *
 * Only the pipeline's overlay pass draws it (`Layer.Overlay`); the GI never sees it.
 */
export function createWater(options: WaterOptions): Water {
  const { renderer, field, environment, sun, cutDepth = 3.0, bathymetry, simulationFrames = Infinity, offThread = true } = options;
  let stepsLeft = simulationFrames;
  const half = field.half;

  const heightTexture = bathymetry ?? field.toTexture(512);
  if (!bathymetry) heightTexture.name = 'islandHeight';
  // The sand alone, without boulder stamps: says whether a rim position is beach or
  // lagoon, which a stamp lying on the rim must not decide.
  const sandTexture = field.toTexture(128, true);
  sandTexture.name = 'islandSand';

  const uniforms = {
    absorb: uniform(WATER_ABSORB.clone()),
    scatter: uniform(new THREE.Color(0.012, 0.10, 0.10)),
    scatterStrength: uniform(1.0),
    envStrength: uniform(0.55),
    foamStrength: uniform(1.0),
    causticStrength: uniform(1.0),
    refractionStrength: uniform(0.12),
    sunColor: uniform(new THREE.Color(1, 0.95, 0.85)),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
  };
  const waterLevel = uniform(field.waterLevel);
  const slabHalf = uniform(half);
  const params = new URLSearchParams(window.location.search);
  const debugMode = params.get('waterDebug');
  // The physical surface: shallow-water equations on the bathymetry.
  // Mean still-water depth along each open face, for the swell's velocity there.
  const faceDepth = { x: 0, z: 0 };
  for (let k = 0; k < 64; k++) {
    const s = -half + ((k + 0.5) / 64) * 2 * half;
    faceDepth.x += Math.max(0, field.waterLevel - field.obstacleHeight(-half + 0.05, s)) / 64;
    faceDepth.z += Math.max(0, field.waterLevel - field.obstacleHeight(s, half - 0.05)) / 64;
  }
  const SIM_SIZE = 384;
  const PREROLL_SECONDS = 6.0;
  const simSetup = { renderer, bathymetry: heightTexture, half, waterLevel: field.waterLevel, size: SIM_SIZE, faceDepth };
  const workerSim = offThread ? new WorkerWaterSim({ ...simSetup, swellAmplitude: 0.06, swellPeriod: 3.2, swellDirection: Math.atan2(-1, 1), prerollSeconds: PREROLL_SECONDS }) : null;
  const sim: WaterSim = workerSim ?? new ShallowWater(simSetup);
  // Wind waves from the spectrum ride on the simulated surface (see windWaves.ts).
  const wind = new WindWaves({ windSpeed: 4.5, fetch: 800, components: 48, gain: 1.0 });
  const windCap = Math.min(0.12, wind.amplitudeSum);

  if (!workerSim) (sim as ShallowWater).preroll(PREROLL_SECONDS);

  /** Sand height (with boulders stamped in) under (x, z); +z is row-down in the texture. */
  const sandHeight = Fn(([xz]: [ReturnType<typeof vec2>]) => {
    const uvCoord = xz.div(slabHalf).mul(0.5).add(0.5);
    return texture(heightTexture, uvCoord).r;
  });

  /** 0 at the slab boundary, 1 a hand inside: the surface stays sealed to the cut faces. */
  const rimMask = Fn(([xz]: [ReturnType<typeof vec2>]) => {
    const edge = max(abs(xz.x), abs(xz.y));
    return smoothstep(slabHalf.sub(0.02), slabHalf.sub(0.45), edge);
  });

  /** Simulated free surface η = b + d (capped); dry cells sit below the sand. */
  const simBase = Fn(([xz]: [ReturnType<typeof vec2>]) => {
        const q = sim.uvOf(xz) as unknown as ReturnType<typeof vec2>;
        // Interpolate the free surface η = b + d, never b and d apart: between a deep
        // cell and a boulder's flank, depth blended on its own lands metre-deep water
        // on the stone and lifts a ring of teeth around every rock. A dry cell is the
        // still-water line (capped a little above the ground) so the sheet runs level
        // into the stone instead of climbing it; what is drawn there is the fragment's
        // call (see thinFilm). Four taps at half-texel offsets: a 2×2 box.
        const h = float(0.5 / sim.size);
        // Run-up ceiling: about one wave height over still water on a beach (Hunt),
        // but against a steep flank the water cannot climb — it breaks into spray
        // (the foam field's impact channel feeds the spray) — so there the sheet stays
        // within 3 cm of the line.
        const bTex = (o: ReturnType<typeof vec2>) => (texture(heightTexture, q.add(o)).level(float(0.0)) as ReturnType<typeof vec4>).r;
        const t2 = float(2.0 / sim.size);
        const grad = vec2(bTex(vec2(t2, 0.0)).sub(bTex(vec2(t2.negate(), 0.0))), bTex(vec2(0.0, t2)).sub(bTex(vec2(0.0, t2.negate())))).div(float(sim.cell * 4));
        const gentle = smoothstep(1.2, 0.5, grad.length());
        const ceiling = waterLevel.add(float(0.03).add((sim.swellAmplitude as unknown as ReturnType<typeof float>).mul(1.5).mul(gentle)));
        const etaTap = (o: ReturnType<typeof vec2>) => {
          const uv = q.add(o);
          const d = ((sim.stateNode.sample(uv) as typeof sim.stateNode).level(float(0.0)) as ReturnType<typeof vec4>).r;
          const b = (texture(heightTexture, uv).level(float(0.0)) as ReturnType<typeof vec4>).r;
          return select(d.greaterThan(0.002), b.add(d), min(b, waterLevel.add(0.02)));
        };
        const eta = etaTap(vec2(h, h)).add(etaTap(vec2(h.negate(), h))).add(etaTap(vec2(h, h.negate()))).add(etaTap(vec2(h.negate(), h.negate()))).mul(0.25);
        return min(eta, ceiling);
      });
  /** Wind waves at (x, z): height and slope, shoaled by the local depth. */
  const windAt = Fn(([xz]: [ReturnType<typeof vec2>]) => {
    const depth = waterLevel.sub(sandHeight(xz));
    // No wind waves on dry sand or inside the rim seal.
    const alive = smoothstep(0.0, 0.08, depth).mul(rimMask(xz));
    return wind.evaluate(xz, depth).mul(alive);
  });
  /**
   * Water depth over the bed, reconstructed with a cubic B-spline (16 taps) of the
   * solver's cells: the edge of the run-up tongue is then a smooth curve through the
   * cells, not the bilinear contour that shows every 3 cm cell as a kink (grill Q38).
   */
  const filmAt = Fn(([xz]: [ReturnType<typeof vec2>]) => {
    const n = float(sim.size);
    const tc = (sim.uvOf(xz) as unknown as ReturnType<typeof vec2>).mul(n).sub(0.5);
    const base = tc.floor();
    const f = tc.sub(base);
    const weights = (t: ReturnType<typeof float>) => {
      const t2 = t.mul(t);
      const t3 = t2.mul(t);
      return [
        float(1.0).sub(t).pow(3.0).div(6.0),
        t3.mul(3.0).sub(t2.mul(6.0)).add(4.0).div(6.0),
        t3.mul(-3.0).add(t2.mul(3.0)).add(t.mul(3.0)).add(1.0).div(6.0),
        t3.div(6.0),
      ];
    };
    const wx = weights(f.x);
    const wz = weights(f.y);
    const sum = float(0.0).toVar();
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const tap = base.add(vec2(i - 1, j - 1)).add(0.5).div(n);
        const d = ((sim.stateNode.sample(tap as unknown as ReturnType<typeof vec2>) as typeof sim.stateNode).level(float(0.0)) as ReturnType<typeof vec4>).r;
        sum.addAssign(d.mul(wx[i]).mul(wz[j]));
      }
    }
    return sum;
  });
  /** The free surface, baked once per frame: (η − level, ∂η/∂x, ∂η/∂z, film depth). */
  const surface = new SurfaceField({ renderer, size: 1024, half, waterLevel: field.waterLevel, simHeight: simBase, wind: windAt, rim: rimMask, windCap, film: filmAt as unknown as (xz: THREE.Node) => THREE.Node });
  const fieldAt = (xz: THREE.Node) => (surface.node.sample(surface.uvOf(xz) as unknown as ReturnType<typeof vec2>) as typeof surface.node).level(float(0.0)) as unknown as ReturnType<typeof vec4>;

  /** Two drifting Worley layers; the cell edges are the bright caustic filaments. */
  const caustic = Fn(([xz, depth]: [ReturnType<typeof vec2>, ReturnType<typeof float>]) => {
    const t = time;
    const q1 = vec3(xz.x.mul(6.5).add(t.mul(0.12)), xz.y.mul(6.5).sub(t.mul(0.09)), t.mul(0.30));
    const q2 = vec3(xz.x.mul(9.0).sub(t.mul(0.08)), xz.y.mul(9.0).add(t.mul(0.13)), t.mul(0.24).add(5.0));
    const w1 = mx_worley_noise_vec2(q1, 1.0);
    const w2 = mx_worley_noise_vec2(q2, 1.0);
    const line1 = smoothstep(0.10, 0.0, w1.y.sub(w1.x));
    const line2 = smoothstep(0.10, 0.0, w2.y.sub(w2.x));
    // Filaments as a modulation around the mean (≈ ±60 %), so a bright rock under the
    // water is never whitened ×4 and the average light on the floor is unchanged.
    const filaments = line1.mul(0.6).add(line2.mul(0.6)).add(line1.mul(line2).mul(1.8)).sub(0.45).mul(0.55);
    // Fade in just below the surface, decay with depth as the light spreads.
    const fade = smoothstep(0.0, 0.05, depth).mul(exp(depth.mul(-1.5)));
    return filaments.mul(fade);
  });

  // --- persistent foam field ---------------------------------------------------
  // Sea of Thieves / Tidewater recipe: foam is born where the surface folds (Jacobian)
  // and where the water is shallow against sand or a boulder, drifts with the swell
  // toward the beach, spreads, and decays. A ping-pong texture over the slab, one
  // quad draw per frame; the surface shader reads it by world xz.
  const FOAM_SIZE = 1024;
  const makeFoamTarget = () => {
    const target = new THREE.RenderTarget(FOAM_SIZE, FOAM_SIZE, {
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
  let foamRead = makeFoamTarget();
  let foamWrite = makeFoamTarget();
  const foamPrev = texture(foamRead.texture);
  /** The field as the surface reads it; its texture is swapped after every step. */
  const foamField = texture(foamRead.texture);
  const foamDt = uniform(1 / 60);
  const foamDecaySeconds = uniform(2.8);

  const foamSim = new THREE.MeshBasicNodeMaterial();
  foamSim.name = 'lagoonFoamField';
  foamSim.blending = THREE.NoBlending;
  foamSim.depthTest = false;
  foamSim.depthWrite = false;
  foamSim.toneMapped = false;
  foamSim.fragmentNode = Fn(() => {
    const q = uv();
    // Advection: with the simulated flow, or the primary swell's drift without it.
    const flow: THREE.Node = sim.stateNode.sample(q).gb.mul(foamDt);
    const from = q.sub((flow as ReturnType<typeof vec2>).div(slabHalf.mul(2.0)));
    const texel = float(1.5 / FOAM_SIZE);
    const spread = foamPrev.sample(from).r
      .add(foamPrev.sample(from.add(vec2(texel, 0.0))).r)
      .add(foamPrev.sample(from.sub(vec2(texel, 0.0))).r)
      .add(foamPrev.sample(from.add(vec2(0.0, texel))).r)
      .add(foamPrev.sample(from.sub(vec2(0.0, texel))).r)
      .mul(0.2);
    // On water the whitecap e-folding; on sand the swash left behind, the bubbles
    // burst in a couple of seconds — the band follows the run-up, not its history.
    // Bubble lifetime by the water under them: a whitecap's e-folding (Monahan,
    // 3.85 s) on a body of water; on the millimetre sheet of the swash the film
    // drains and they burst in about 1.5 s; the same on the sand they were left on.
    // Foam is on the water. Where the solver says dry the sheet has gone and the
    // bubbles with it — a residue lasts a fraction of a second, no more — so the band
    // stays at the water's edge as the tongue runs up and draws back.
    const depthHere = sim.stateNode.sample(q).r;
    const onWater = smoothstep(0.0008, 0.004, depthHere);
    const tauWet = mix(float(1.5), foamDecaySeconds, smoothstep(0.01, 0.08, depthHere));
    const tau = mix(float(0.5), tauWet, onWater);
    const decayed = spread.mul(exp(foamDt.negate().div(tau)));

    // Only the solver's sources: breaking, the run-up front, impact spray. The
    // analytic "shore lace" band that ignored the water is gone (grill Q12/Q20).
    const crest = sim.stateNode.sample(q).a;
    const foam = max(decayed, crest.mul(0.85));
    // Wetness: where water stands now, or stood in the last half minute. The sand
    // shader reads it; sand the swash has reached stays dark and glossy as it dries.
    // Saturation of the sand: a 2 cm tongue soaks it, a 1 mm film barely does — the
    // run-up limit is where the tongue is thinnest, so the wet edge is a gradient, not
    // a line. Capillary spread (a small blur) and drainage (28 s) follow.
    const standing = smoothstep(0.0005, 0.005, sim.stateNode.sample(q).r);
    const wt = float(0.6 / FOAM_SIZE);
    const wetPrev = foamPrev.sample(q).g.mul(0.4)
      .add(foamPrev.sample(q.add(vec2(wt, 0.0))).g.mul(0.15))
      .add(foamPrev.sample(q.sub(vec2(wt, 0.0))).g.mul(0.15))
      .add(foamPrev.sample(q.add(vec2(0.0, wt))).g.mul(0.15))
      .add(foamPrev.sample(q.sub(vec2(0.0, wt))).g.mul(0.15));
    const wetness = max(standing, wetPrev.mul(exp(foamDt.negate().div(28.0))));
    // Impact: flow driven into a steep rise of the bed (a boulder's face) faster than
    // it can climb — u·∇b is the vertical speed it would need. That energy leaves as
    // spray; the spray emitter reads this channel (see spray.ts).
    const state = sim.stateNode.sample(q);
    const tb = float(1.0 / 512);
    const bL = texture(heightTexture, q.sub(vec2(tb, 0.0))).r;
    const bR = texture(heightTexture, q.add(vec2(tb, 0.0))).r;
    const bB = texture(heightTexture, q.sub(vec2(0.0, tb))).r;
    const bF = texture(heightTexture, q.add(vec2(0.0, tb))).r;
    const gradB = vec2(bR.sub(bL), bF.sub(bB)).div(float(2 * (2 * half) / 512));
    const climb = state.g.mul(gradB.x).add(state.b.mul(gradB.y));
    const steep = smoothstep(0.6, 1.4, gradB.length());
    // Only a boulder that breaks the surface throws spray: the bed a few cells ahead
    // along the flow must stand above the water line. A submerged rock is passed over.
    const flowStep = vec2(state.g, state.b).div(max(vec2(state.g, state.b).length(), 1e-3)).mul(tb);
    const bedAhead = max(max(texture(heightTexture, q.add(flowStep.mul(3.0))).r, texture(heightTexture, q.add(flowStep.mul(7.0))).r), texture(heightTexture, q.add(flowStep.mul(12.0))).r);
    const emergent = smoothstep(-0.06, 0.0, bedAhead.sub(waterLevel));
    const impact = smoothstep(0.3, 1.2, climb).mul(steep).mul(smoothstep(0.01, 0.05, state.r)).mul(emergent);
    // The foot of the impact is aerated white: the burst goes into the foam too.
    // A = the residue on dry sand only (what the swash left), read by the sand; the
    // sheet reads R. One field, two consumers, one threshold each — never the same
    // foam drawn twice at two thresholds.
    const foamOut = max(foam, impact.mul(0.9));
    return vec4(foamOut, wetness, impact, foamOut.mul(float(1.0).sub(onWater)));
  })();
  const foamQuad = new THREE.QuadMesh(foamSim);
  /** Droplets where the water hits the boulders (spray.ts). */
  const spray = new Spray({ renderer, half, waterLevel: field.waterLevel, foamField, simState: sim.stateNode, surface: surface.node, sunDir: uniforms.sunDir, sunColor: uniforms.sunColor, test: Number(params.get('sprayTest') ?? 0) });

  const stepFoam = (dt: number) => {
    foamDt.value = Math.min(0.05, Math.max(0.001, dt));
    foamPrev.value = foamRead.texture;
    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(foamWrite);
    foamQuad.render(renderer);
    renderer.setRenderTarget(previousTarget);
    const swap = foamRead;
    foamRead = foamWrite;
    foamWrite = swap;
    foamField.value = foamRead.texture;
    sim.setSaturation(foamRead.texture);
    water.onField?.(foamRead.texture);
  };

  function buildMaterial(screen: { color: THREE.Texture; depth: THREE.Texture; normal: THREE.Texture }, top: boolean): THREE.MeshStandardNodeMaterial {
    const material = new THREE.MeshStandardNodeMaterial();
    material.name = top ? 'lagoonWaterSurface' : 'lagoonWaterCut';
    material.transparent = false;
    material.side = THREE.FrontSide;
    material.color = new THREE.Color(0.02, 0.1, 0.12);
    material.metalness = 0;
    material.roughness = 0.07;
    // The scene under the water IS the diffuse term; the light loop only adds specular.
    material.colorNode = vec3(0.0);
    material.metalnessNode = float(0.0);

    const p = positionWorld;
    const t = time;

    if (top) {
      // The sheet rides 4 mm high: the sand *mesh* is piecewise linear at 6 cm and
      // strays a few millimetres from the analytic bed the solver runs on, and a
      // millimetre tongue drawn exactly on that bed vanished under the mesh — the
      // visible water ended a metre short of where the solver had it.
      // The tongue of the swash is millimetres thick over sand that, in the scene, is
      // a 6 cm mesh straying ±5 mm from the analytic bed the solver runs on. Where
      // the solver says wet, the sheet is seated on the *rendered* sand: the vertex
      // projects itself, reads the scene depth there, and rises to that floor plus
      // the film — so the visible water reaches exactly where the water is.
      // The sheet is the free surface, lifted by the millimetres the sand mesh
      // strays from the analytic bed it is drawn on. It is never seated on the scene
      // depth: a vertex behind a rock, the ball or a nearer fold of sand reads THAT
      // surface and rises to it, which stood a curtain of water at every contact.
      material.positionNode = vec3(positionLocal.x, waterLevel.add(fieldAt(positionLocal.xz).x).add(0.004), positionLocal.z);
    }

    // --- normal ------------------------------------------------------------------
    // From the field's slopes, per pixel: the solver's surface plus every wind
    // component the field resolves. Sub-texel slopes are the roughness's business.
    const nWorld = Fn(() => {
      if (!top) return normalWorld;
      const slope = fieldAt(p.xz).yz;
      return normalize(vec3(slope.x.negate(), 1.0, slope.y.negate()));
    })();
    const nView = transformNormalToView(nWorld);
    material.normalNode = nView;
    material.roughnessNode = float(top ? 0.07 : 0.10);

    // --- the scene behind this pixel ----------------------------------------------
    const viewZ = positionView.z; // negative, farther is more negative
    const depthAt = (uvNode: THREE.Node) => texture(screen.depth, uvNode as ReturnType<typeof vec2>).x;
    const sceneDepth0 = depthAt(screenUV);
    const sceneZ0 = perspectiveDepthToViewZ(sceneDepth0, cameraNear, cameraFar);
    // The overlay pass has its own depth buffer; the scene's is applied by hand, inside
    // the emissive Fn below — a bare `Discard` outside a stack is never emitted.
    const behindScene = viewZ.lessThan(sceneZ0.sub(0.003));

    // --- Snell refraction (grill Q26/Q39) -------------------------------------------
    // The view ray bends at the surface (n = 1.333). The refracted ray is intersected
    // with the plane of the floor seen straight below this pixel (position from the
    // depth, orientation from the G-buffer normal), the hit is projected back to the
    // screen and the floor there is read; a second pass with that floor's plane
    // refines it. Nothing standing in front of the surface is ever pulled under it.
    const viewDirEarly = normalize(p.sub(cameraPosition));
    const refracted = refract(viewDirEarly, nWorld, float(1.0 / 1.333));
    type V2 = ReturnType<typeof vec2>;
    type V3 = ReturnType<typeof vec3>;
    type F1 = ReturnType<typeof float>;
    const floorAt = (uvNode: THREE.Node, depthNode: THREE.Node): V3 =>
      cameraWorldMatrix.mul(vec4(getViewPosition(uvNode as V2, depthNode as F1, cameraProjectionMatrixInverse), 1.0)).xyz as unknown as V3;
    const normalAt = (uvNode: THREE.Node): V3 => {
      const nv = texture(screen.normal, uvNode as V2).xyz;
      return normalize(cameraWorldMatrix.mul(vec4(nv, 0.0)).xyz) as unknown as V3;
    };
    const project = (world: THREE.Node): V2 => {
      const clip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(world as V3, 1.0)));
      const ndc = clip.xy.div(max(clip.w, 1e-4));
      return vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)));
    };
    const planeHit = (floor: V3, planeN: V3): F1 => {
      const denom = dot(refracted, planeN);
      const t = dot(floor.sub(p), planeN).div(denom);
      const straight = distance(floor, p);
      return select(denom.lessThan(-1e-3).and(t.greaterThan(0.0)), min(t, straight.mul(4.0)), straight) as unknown as F1;
    };
    const inside01 = (u: V2) => u.x.greaterThan(0.0).and(u.x.lessThan(1.0)).and(u.y.greaterThan(0.0)).and(u.y.lessThan(1.0));
    const floor0 = floorAt(screenUV, sceneDepth0);
    const t0 = planeHit(floor0, normalAt(screenUV));
    const uv1raw = project(p.add(refracted.mul(t0)) as unknown as V3);
    const uv1c = clamp(uv1raw, vec2(0.0), vec2(1.0)) as unknown as V2;
    const depth1 = depthAt(uv1c);
    // A hit counts only if what the screen shows there is (nearly) the point the ray
    // reached: a sample that landed on a boulder's face above the water, or on the
    // far side of it, is a different surface and would tear the floor apart.
    const hit1 = p.add(refracted.mul(t0));
    const seen1 = floorAt(uv1c, depth1);
    const consistent1 = distance(seen1, hit1).lessThan(0.15).and(seen1.y.lessThan(waterLevel.add(0.02)));
    const valid1 = inside01(uv1raw).and(perspectiveDepthToViewZ(depth1, cameraNear, cameraFar).lessThan(viewZ)).and(consistent1);
    const uv1 = select(valid1, uv1c, screenUV) as unknown as V2;
    const depthAt1 = select(valid1, depth1, sceneDepth0) as unknown as F1;
    const floor1 = floorAt(uv1, depthAt1);
    const t1 = planeHit(floor1, normalAt(uv1));
    const uv2raw = project(p.add(refracted.mul(t1)) as unknown as V3);
    const uv2c = clamp(uv2raw, vec2(0.0), vec2(1.0)) as unknown as V2;
    const depth2 = depthAt(uv2c);
    const hit2 = p.add(refracted.mul(t1));
    const seen2 = floorAt(uv2c, depth2);
    const consistent2 = distance(seen2, hit2).lessThan(0.15).and(seen2.y.lessThan(waterLevel.add(0.02)));
    const valid2 = inside01(uv2raw).and(perspectiveDepthToViewZ(depth2, cameraNear, cameraFar).lessThan(viewZ)).and(consistent2);
    // Where no plane hit is consistent (a boulder's flank, its far side) the refracted
    // ray is marched through the depth buffer in eight steps: the first step whose
    // point lies behind what the screen shows there is the hit.
    // `If` only exists inside a Fn stack, hence the wrapper; it returns (uv, depth, t)
    // with t = 0 when nothing was hit.
    const march = Fn(() => {
      const hitUv = screenUV.toVar();
      const hitDepth = sceneDepth0.toVar();
      const hitT = float(0.0).toVar();
      const span = distance(floor0, p).mul(2.0).min(4.0).max(0.05);
      for (let i = 1; i <= 8; i++) {
        const t = span.mul(i / 8);
        const q = p.add(refracted.mul(t)) as unknown as V3;
        const uvq = project(q);
        const uvqc = clamp(uvq, vec2(0.0), vec2(1.0)) as unknown as V2;
        const dq = depthAt(uvqc);
        const zq = perspectiveDepthToViewZ(dq, cameraNear, cameraFar);
        const qz = cameraViewMatrix.mul(vec4(q, 1.0)).z;
        const behind = zq.greaterThan(qz);
        // What the screen shows there must itself be under water: a boulder's face
        // above the line is not what a ray inside the water reaches.
        const underLine = floorAt(uvqc, dq).y.lessThan(waterLevel.add(0.02));
        If(hitT.equal(0.0).and(behind).and(inside01(uvq)).and(underLine), () => {
          hitUv.assign(uvqc);
          hitDepth.assign(dq);
          hitT.assign(t);
        });
      }
      return vec4(hitUv, hitDepth, hitT);
    })();
    const marchUv = march.xy as unknown as V2;
    const marchDepth = march.z as unknown as F1;
    const marchT = march.w as unknown as F1;
    const marchFound = marchT.greaterThan(0.0);
    const uvF = select(valid2, uv2c, select(valid1, uv1c, select(marchFound, marchUv, screenUV))) as unknown as V2;
    const depthF = select(valid2, depth2, select(valid1, depth1, select(marchFound, marchDepth, sceneDepth0))) as unknown as F1;
    const floorWorld = floorAt(uvF, depthF);
    // Length of the refracted path to the floor, held to the distance the sampled
    // floor actually is from the surface.
    const refractedPath = clamp(select(valid2, t1, select(valid1, t0, select(marchFound, marchT, distance(p, floorWorld)))), 0.0, distance(p, floorWorld).mul(1.5));
    const floorOutside = max(abs(floorWorld.x), abs(floorWorld.z)).greaterThan(slabHalf.add(0.6));
    const boundaryT = Fn(() => {
      const tx = select(refracted.x.greaterThan(0.0), slabHalf.sub(p.x), slabHalf.negate().sub(p.x)).div(select(abs(refracted.x).greaterThan(1e-4), refracted.x, float(1e-4)));
      const tz = select(refracted.z.greaterThan(0.0), slabHalf.sub(p.z), slabHalf.negate().sub(p.z)).div(select(abs(refracted.z).greaterThan(1e-4), refracted.z, float(1e-4)));
      return clamp(min(abs(tx), abs(tz)), 0.0, 10.0);
    })();
    const pathLength = select(floorOutside, boundaryT, clamp(refractedPath, 0.0, 10.0));
    const verticalDepth = select(floorOutside, float(2.0), max(waterLevel.sub(floorWorld.y), 0.0));
    const sceneColor = select(floorOutside, vec3(0.0), texture(screen.color, uvF).rgb);

    // --- light through the water --------------------------------------------------
    const sunDir = vec3(uniforms.sunDir);
    const sunUp = clamp(sunDir.y, 0.0, 1.0);
    const sunLight = vec3(uniforms.sunColor).mul(sunUp.mul(1.6).add(0.5));
    const causticMask = caustic(floorWorld.xz, verticalDepth).mul(sunUp);
    const transmittance = exp(vec3(uniforms.absorb).mul(pathLength).negate());
    const scatterAmount = float(1.0).sub(exp(pathLength.mul(-0.3)));
    const scatter = vec3(uniforms.scatter).mul(sunLight).mul(scatterAmount).mul(uniforms.scatterStrength);
    const under = sceneColor.mul(float(1.0).add(causticMask.mul(uniforms.causticStrength))).mul(transmittance).add(scatter);

    // --- sky by Fresnel -----------------------------------------------------------
    const viewDir = normalize(p.sub(cameraPosition));
    const reflected = reflect(viewDir, nWorld);
    const reflectedUp = vec3(reflected.x, abs(reflected.y), reflected.z);
    const sky = texture(environment, equirectUV(reflectedUp)).rgb;
    const cosTheta = clamp(dot(nWorld, viewDir.negate()), 0.0, 1.0);
    const fresnel = float(0.02).add(float(0.98).mul(pow(float(1.0).sub(cosTheta), 5.0)));
    const reflection = sky.mul(fresnel).mul(uniforms.envStrength);

    // --- foam -----------------------------------------------------------------------
    const foamMask = Fn(() => {
      if (!top) return float(0.0);
      // The persistent field only (grill Q12/Q21): its sources are the solver's.
      // Noise is sub-cell detail of that mask — lace inside the patch, never a patch
      // of its own — and nothing here depends on where the camera is.
      const lace = mx_fractal_noise_float(vec3(p.x.mul(5.0), p.z.mul(5.0), t.mul(0.45)), 4, 2.3, 0.55);
      const fine = mx_noise_float(vec3(p.x.mul(22.0), p.z.mul(22.0), t.mul(0.8)));
      const field = foamField.sample(p.xz.div(slabHalf.mul(2.0)).add(0.5)).r;
      const coverage = float(1.0).sub(exp(field.negate().mul(6.0)));
      const drifting = smoothstep(0.0, 0.8, coverage.mul(1.2).add(lace.mul(0.45)).add(fine.mul(0.25)).sub(0.55));
      return clamp(drifting, 0.0, 1.0).mul(uniforms.foamStrength);
    })();
    const foamLight = vec3(uniforms.sunColor).mul(sunUp.mul(1.3)).add(vec3(0.35, 0.4, 0.45));
    // Froth: fine fractal grain, not cells — a foam sheet has no polka dots.
    const grain = mx_fractal_noise_float(vec3(p.x.mul(30.0), p.z.mul(30.0), t.mul(0.9)), 3, 2.1, 0.6);
    const froth = smoothstep(-0.6, 0.5, grain).mul(0.35).add(0.7);
    const foamColor = vec3(0.92, 0.95, 0.96).mul(foamLight).mul(froth);

    const shaded: THREE.Node = mix(under.add(reflection), foamColor, foamMask);
    const simState = sim.stateNode.sample(sim.uvOf(p.xz) as unknown as ReturnType<typeof vec2>) as ReturnType<typeof vec4>;
    // Run-up thinner than a few millimetres is wet sand, not a water surface; up to a
    // couple of centimetres the sheet fades into the (wet) sand under it.
    // Run-up thinner than a few millimetres is wet sand, not a water surface. On
    // ground above the water line (a boulder's flank) the run-up must be deeper still
    // before it reads as a surface: a film there is wet stone.
    const groundHere = sandHeight(p.xz);
    // The swash is a film of millimetres running up a beach that stands above the
    // water line: it must be drawn. Only against a steep flank (a boulder) does the
    // ground's height over the line demand more depth before a film counts.
    const gs = float(2.0 / 512);
    const gUv = p.xz.div(slabHalf).mul(0.5).add(0.5);
    const gradGround = vec2(
      texture(heightTexture, gUv.add(vec2(gs, 0.0))).r.sub(texture(heightTexture, gUv.sub(vec2(gs, 0.0))).r),
      texture(heightTexture, gUv.add(vec2(0.0, gs))).r.sub(texture(heightTexture, gUv.sub(vec2(0.0, gs))).r),
    ).div(float(4 * (2 * half) / 512));
    const steepGround = smoothstep(0.35, 0.9, gradGround.length());
    const needed = float(0.0015).add(max(groundHere.sub(waterLevel), 0.0).mul(steepGround));
    // The sheet's real height over the real floor (scene depth), not the solver's
    // column over its own bathymetry: the two floors differ by centimetres, and a film
    // judged on the wrong one pokes through the sand as a row of teeth.
    // Judged on the floor straight behind the pixel, never the refracted one: a
    // refracted sample that lands on a boulder above the line is not this pixel's floor.
    const floor0Outside = max(abs(floor0.x), abs(floor0.z)).greaterThan(slabHalf.add(0.6));
    const sheetAboveFloor = select(floor0Outside, float(1.0), p.y.sub(floor0.y));
    // A cut face is water only where the rim floor is under the water line; on the
    // beach side the block is sand and the cliff shows instead.
    const bareSand = texture(sandTexture, p.xz.div(slabHalf).mul(0.5).add(0.5)).r;
    const cutDry = bareSand.greaterThan(waterLevel.sub(0.01));
    // `?waterFilm=0` draws every sheet pixel: a hole is then either geometry or the
    // scene depth, never this gate.
    const gateOn = params.get('waterFilm') !== '0';
    // The film depth from the field's smooth reconstruction, not the raw cells.
    const filmDepth = fieldAt(p.xz).w;
    // Coverage, not a threshold. The film's edge is a contour of a field sampled at
    // 1.17 cm and the sheet's own mesh at 2.34 cm; a binary test of either draws that
    // contour as a staircase of its cells. Dividing by the screen derivative makes
    // the transition one pixel wide wherever the bed slopes, at any resolution.
    const edge = (value: THREE.Node, at: number) =>
      clamp((value as ReturnType<typeof float>).sub(at).div(max(fwidth(value as ReturnType<typeof float>), 1e-5)).add(0.5), 0.0, 1.0);
    const filmCoverage = edge(filmDepth.sub(needed), 0);
    const floorCoverage = edge(sheetAboveFloor, 0.0005);
    // A waterline, not a silhouette: as the sheet comes within a few centimetres of
    // whatever the scene drew behind it — a boulder, the ball, the sand — it fades
    // out over that depth instead of ending on the object's hard edge.
    const contact = smoothstep(0.0, 0.06, viewZ.sub(sceneZ0));
    const covered = filmCoverage.mul(floorCoverage);
    const thinFilm = !gateOn ? float(0.0).greaterThan(1.0) : top ? covered.lessThanEqual(0.0) : cutDry;
    const filmFade = !gateOn ? float(1.0) : top ? covered.mul(contact) : contact;
    const debug: THREE.Node | null =
      debugMode === 'depth' ? vec3(verticalDepth.mul(0.5))
      : debugMode === 'path' ? vec3(pathLength.mul(0.3))
      : debugMode === 'foam' ? vec3(foamMask)
      : debugMode === 'impact' ? vec3(foamField.sample(p.xz.div(slabHalf.mul(2.0)).add(0.5)).b, simState.a, 0.0)
      : debugMode === 'sim' ? vec3(p.y.sub(waterLevel).mul(8.0).add(0.5), simState.gb.abs().mul(0.5))
      : null;
    const sceneHere = texture(screen.color, screenUV).rgb;
    const shown = debug ?? mix(sceneHere, shaded, filmFade);
    material.emissiveNode = Fn(() => {
      Discard(behindScene.or(thinFilm));
      return shown;
    })();
    return material;
  }

  // --- geometry ------------------------------------------------------------------
  const group = new THREE.Group();
  group.name = 'water';
  group.add(spray.mesh);

  const top = new THREE.PlaneGeometry(2 * half, 2 * half, 512, 512);
  top.rotateX(-Math.PI / 2);
  top.translate(0, field.waterLevel, 0);
  const topMesh = new THREE.Mesh(top);
  topMesh.name = 'waterSurface';
  topMesh.frustumCulled = false;
  group.add(topMesh);

  // Cut faces on the two open sides (front +z, left -x). A hair outside the slab
  // so they never z-fight with the wall's rim row.
  const skin = 0.004;
  const wantCuts = new URLSearchParams(window.location.search).get('waterCuts') !== '0';
  const front = new THREE.PlaneGeometry(2 * half, cutDepth, 96, 24);
  front.translate(0, field.waterLevel - cutDepth / 2, half + skin);
  const frontMesh = new THREE.Mesh(front);
  frontMesh.name = 'waterCutFront';
  group.add(frontMesh);

  const left = new THREE.PlaneGeometry(2 * half, cutDepth, 96, 24);
  left.rotateY(-Math.PI / 2);
  left.translate(-half - skin, field.waterLevel - cutDepth / 2, 0);
  const leftMesh = new THREE.Mesh(left);
  leftMesh.name = 'waterCutLeft';
  group.add(leftMesh);

  // The back and right faces too: from a low camera the far rim is a cut like any
  // other, and where the sand at the rim stands above the water the fragment
  // discards them (see `cutDry`), so the beach side shows the cliff, not water.
  const back = new THREE.PlaneGeometry(2 * half, cutDepth, 96, 24);
  back.rotateY(Math.PI);
  back.translate(0, field.waterLevel - cutDepth / 2, -half - skin);
  const backMesh = new THREE.Mesh(back);
  backMesh.name = 'waterCutBack';
  group.add(backMesh);

  const right = new THREE.PlaneGeometry(2 * half, cutDepth, 96, 24);
  right.rotateY(Math.PI / 2);
  right.translate(half + skin, field.waterLevel - cutDepth / 2, 0);
  const rightMesh = new THREE.Mesh(right);
  rightMesh.name = 'waterCutRight';
  group.add(rightMesh);

  if (!wantCuts) group.remove(frontMesh, leftMesh, backMesh, rightMesh);
  for (const mesh of [topMesh, frontMesh, leftMesh, backMesh, rightMesh]) {
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.giExclude = true;
  }

  // Until the frame graph binds its buffers, 1×1 stand-ins keep the materials valid:
  // depth 1 (nothing in front) and black behind.
  const placeholderDepth = new THREE.DepthTexture(1, 1);
  const placeholderColor = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  placeholderColor.needsUpdate = true;
  let materials: THREE.MeshStandardNodeMaterial[] = [];
  const bindScreen = (color: THREE.Texture, depth: THREE.Texture, normal: THREE.Texture) => {
    spray.bindScreen(color, depth);
    const previous = materials;
    const surface = buildMaterial({ color, depth, normal }, true);
    const cut = buildMaterial({ color, depth, normal }, false);
    topMesh.material = surface;
    frontMesh.material = cut;
    leftMesh.material = cut;
    backMesh.material = cut;
    rightMesh.material = cut;
    materials = [surface, cut];
    for (const m of previous) m.dispose();
  };
  bindScreen(placeholderColor, placeholderDepth, placeholderColor);

  // Numbers, not impressions: `__water.simStats()` reads the state back, and
  // `?waterInspect=1` (or `=z:<metres>`) draws the map and a section on screen.
  (window as unknown as Record<string, unknown>).__water = {
    simStats: async () => sim.readStats(),
    simProbe: async () => sim.readProbe(),
    sprayStats: async () => spray.readStats(),
    /** Along the row z: the x of the wet edge (last wet cell toward +x), the depth 30 cm seaward of it, the beach slope there. */
    /** The bare beach profile along x at row z: [x, height − level] every 10 cm. */
    profile: (z: number) => {
      const out: number[][] = [];
      for (let x = -half; x <= half; x += 0.1) out.push([Number(x.toFixed(2)), Number((field.height(x, z) - field.waterLevel).toFixed(3))]);
      return out;
    },
    simRow: async (z: number) => {
      const size = sim.size;
      const j = Math.max(0, Math.min(size - 1, Math.floor(((z + half) / (2 * half)) * size)));
      const depth = await sim.readRow(j);
      // From the sea (−x) toward the beach: the edge is the last wet cell before the
      // first dry run of three cells; the two boundary rings are skipped.
      let edge = 2;
      for (let i = 2; i < size - 4; i++) {
        if (depth[i] > 0.001) edge = i;
        else if (depth[i + 1] <= 0.001 && depth[i + 2] <= 0.001 && i > size * 0.3) break;
      }
      const cell = (2 * half) / size;
      const edgeX = -half + (edge + 0.5) * cell;
      const back = Math.max(0, edge - Math.round(0.3 / cell));
      let hNearShore = 0;
      for (let i = back; i <= edge; i++) hNearShore = Math.max(hNearShore, depth[i]);
      const slope = Math.abs(field.height(edgeX + 0.25, z) - field.height(edgeX - 0.25, z)) / 0.5;
      return { edgeX, hNearShore, slope };
    },
    /** The GUI knobs, for scripts: set fields, then `apply()`. */
    controls: () => water.controls,
    foamDebug: () => ({ isRenderTarget: (foamRead as unknown as { isRenderTarget?: boolean }).isRenderTarget, textures: foamRead.textures?.length, width: foamRead.width }),
    foamStats: async () => {
      const { size, foam, wetness } = await water.readFoamField();
      let foamMax = 0, wetMax = 0, wetCount = 0;
      for (let i = 0; i < size * size; i++) { foamMax = Math.max(foamMax, foam[i]); wetMax = Math.max(wetMax, wetness[i]); if (wetness[i] > 0.2) wetCount++; }
      return { foamMax, wetMax, wetFraction: wetCount / (size * size) };
    },
    /** Solver clock against wall time, for the real-time question. */
    simClock: () => ({ simTime: sim.simTime, now: performance.now() }),
    /**
     * Read-only critic measurer: one GPU moment along the row z — solver depth / u / v /
     * foam source per cell, the bicubic film the sheet gate reads, the foam field (R) and
     * wetness (G) at that cell, and the analytic bed over the water line.
     */
    shoreSnapshot: async (z: number) => {
      const [state, fieldData] = await Promise.all([sim.readState(), water.readFoamField()]);
      const simTimeAt = sim.simTime;
      const size = state.size;
      const cell = (2 * half) / size;
      const j = Math.max(1, Math.min(size - 2, Math.floor(((z + half) / (2 * half)) * size)));
      const fs = fieldData.size;
      const jf = Math.max(0, Math.min(fs - 1, Math.floor(((z + half) / (2 * half)) * fs)));
      const w = [1 / 6, 4 / 6, 1 / 6];
      const rows: number[][] = [];
      for (let i = 0; i < size; i++) {
        let film = 0;
        for (let b = -1; b <= 1; b++) {
          for (let a = -1; a <= 1; a++) {
            const ii = Math.max(0, Math.min(size - 1, i + a));
            film += state.depth[(j + b) * size + ii] * w[a + 1] * w[b + 1];
          }
        }
        const x = -half + (i + 0.5) * cell;
        const fi = Math.max(0, Math.min(fs - 1, Math.floor(((x + half) / (2 * half)) * fs)));
        const k = jf * fs + fi;
        const c = j * size + i;
        rows.push([x, state.depth[c], film, state.u[c], state.v[c], state.foam[c], fieldData.foam[k], fieldData.wetness[k], field.height(x, z) - field.waterLevel]);
      }
      return { simTime: simTimeAt, now: performance.now(), z, cell, level: field.waterLevel, rows };
    },
  };
  const inspectParam = params.get('waterInspect');
  const inspector = inspectParam
    ? new WaterInspector(renderer, sim, field, { sectionZ: inspectParam.startsWith('z:') ? Number(inspectParam.slice(2)) : undefined, readFoam: () => water.readFoamField(), bathymetry: heightTexture })
    : null;

  const sunDirection = new THREE.Vector3();
  let previousTime = -1;
  const controls: Water['controls'] = {
    swellAmplitude: sim.swellAmplitude.value as number,
    swellPeriod: sim.swellPeriod.value as number,
    swellDirection: -45,
    windSpeed: wind.windSpeed,
    windDirection: (wind.windDirection * 180) / Math.PI,
    manning: sim.manning.value as number,
    apply() {
      sim.swellAmplitude.value = controls.swellAmplitude;
      sim.swellPeriod.value = controls.swellPeriod;
      sim.setSwellDirection((controls.swellDirection * Math.PI) / 180);
      sim.manning.value = controls.manning;
      wind.setWind(controls.windSpeed, (controls.windDirection * Math.PI) / 180);
    },
  };
  // Audit only: the solver's own clock and where it runs. `scripts/check-water-sim.mjs`
  // reads it to prove the water advanced in a frame that encoded none of its passes,
  // and stops the off-thread solver mid-session to measure what its device costs the
  // main one — the two cannot be separated by comparing two browser launches.
  (window as unknown as Record<string, unknown>).__water = () => ({
    simTime: sim.simTime, offThread: workerSim !== null, size: sim.size, stepsLeft, cost: workerSim?.cost ?? null,
  });
  (window as unknown as Record<string, unknown>).__waterRun = (running: boolean) => sim.setRunning?.(running);

  // `?still=1` holds the scene's animation for a check; the worker must stop too,
  // or it keeps a second device busy on a frame nobody looks at.
  if (workerSim && params.get('still') === '1') void workerSim.ready.then(() => workerSim.setRunning(false));

  const solverBed = new SolverBed(renderer, heightTexture, field);
  const water: Water = {
    group,
    fields: {
      sampleSurface: (x, z) => { solverBed.request(); return sampleSurfaceAt(sim, solverBed, half, x, z); },
      bedAt: (x, z) => solverBed.at(x, z),
      waterLevel: field.waterLevel,
      half,
    },
    onStep: null,
    ready: workerSim ? workerSim.ready : Promise.resolve(),
    async readFoamField() {
      const raw = await renderer.readRenderTargetPixelsAsync(foamRead, 0, 0, FOAM_SIZE, FOAM_SIZE);
      const n = FOAM_SIZE * FOAM_SIZE;
      const foam = new Float32Array(n);
      const wetness = new Float32Array(n);
      const decode = raw instanceof Uint16Array ? (x: number) => THREE.DataUtils.fromHalfFloat(x) : (x: number) => x;
      for (let i = 0; i < n; i++) { foam[i] = decode(raw[i * 4]); wetness[i] = decode(raw[i * 4 + 1]); }
      return { size: FOAM_SIZE, foam, wetness };
    },
    uniforms,
    bindScreen,
    controls,
    update(elapsedSeconds) {
      const dt = previousTime < 0 ? 1 / 60 : elapsedSeconds - previousTime;
      previousTime = elapsedSeconds;
      // The sun still follows the time of day when the water is frozen: it is the
      // simulation that stops, not the shading.
      if (stepsLeft <= 0) {
        if (stepsLeft === 0) { sim.setRunning?.(false); stepsLeft = -1; }
        sunDirection.copy(sun.position).sub(sun.target.position).normalize();
        (uniforms.sunDir.value as THREE.Vector3).copy(sunDirection);
        (uniforms.sunColor.value as THREE.Color).copy(sun.color).multiplyScalar(Math.min(1.5, sun.intensity * 0.5));
        return;
      }
      stepsLeft--;
      const simBefore = sim.simTime;
      sim.step(Math.min(0.05, Math.max(0.001, dt)));
      // Everything downstream of the solver runs on the solver's clock: when the
      // solver falls behind wall time (a heavy frame) the foam must not decay and the
      // droplets must not fall in wall time, or they come apart from the water.
      const simDelta = Math.max(0.0005, sim.simTime - simBefore);
      wind.clock.value = sim.simTime;
      surface.update();
      inspector?.update(performance.now());
      stepFoam(simDelta);
      spray.update(simDelta);
      water.onStep?.(simDelta);
      sunDirection.copy(sun.position).sub(sun.target.position).normalize();
      (uniforms.sunDir.value as THREE.Vector3).copy(sunDirection);
      (uniforms.sunColor.value as THREE.Color).copy(sun.color).multiplyScalar(Math.min(1.5, sun.intensity * 0.5));
    },
  };
  return water;
}
