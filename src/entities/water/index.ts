import * as THREE from 'three/webgpu';
import {
  Discard,
  Fn,
  abs,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraProjectionMatrixInverse,
  cameraWorldMatrix,
  clamp,
  cos,
  distance,
  dot,
  equirectUV,
  exp,
  float,
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
  sin,
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
import { ShallowWater } from './shallowWater.ts';
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
}

export interface Water {
  group: THREE.Group;
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
  bindScreen(color: THREE.Texture, depth: THREE.Texture): void;
  /** Art-direction knobs over the physics: the swell entering the slab and the wind. */
  controls: {
    swellAmplitude: number;
    swellPeriod: number;
    /** Degrees in the xz plane, 0 = toward +x, 90 = toward +z. */
    swellDirection: number;
    windSpeed: number;
    windDirection: number;
    friction: number;
    apply(): void;
  };
  /** Advances the foam field by the elapsed time and refreshes the sun uniforms. */
  update(elapsedSeconds: number): void;
  /** Called with the live foam/wetness field texture after every step. */
  onField?: (field: THREE.Texture) => void;
  /** Foam (R) and wetness (G) fields read back from the GPU, for the inspector. */
  readFoamField(): Promise<{ size: number; foam: Float32Array; wetness: Float32Array }>;
}

/** One Gerstner wave: direction, wavelength, amplitude, steepness. */
type Wave = { dx: number; dz: number; wavelength: number; amplitude: number; steepness: number };

/**
 * Swell rolling toward the beach (+x, −z is land) with two shorter cross seas.
 * Amplitudes are a calm lagoon's; shoaling grows them over the shallows.
 */
const WAVES: Wave[] = [
  { dx: 0.92, dz: -0.39, wavelength: 3.2, amplitude: 0.030, steepness: 0.55 },
  { dx: 0.74, dz: -0.67, wavelength: 1.7, amplitude: 0.016, steepness: 0.5 },
  { dx: 0.98, dz: 0.2, wavelength: 0.95, amplitude: 0.009, steepness: 0.45 },
  { dx: -0.35, dz: -0.94, wavelength: 0.55, amplitude: 0.005, steepness: 0.4 },
];
const GRAVITY = 9.81;

/**
 * Lagoon water as a single layer drawn over the composited scene (docs/water/knowledge-base.md).
 *
 * The material never blends: it reads the composited scene colour through a refracted
 * screen UV and the scene depth, reconstructs the floor under every pixel, and composes
 * the answer itself — scene colour under a per-channel Beer–Lambert transmittance along
 * the real underwater path, in-scattered light, caustics projected onto the floor, sky by
 * Fresnel, the sun's own GGX highlight and shadow from the standard light loop, and foam
 * where the water is shallow against anything (sand, a boulder) or where a Gerstner wave
 * folds (Jacobian < 0). Waves displace the surface mesh and shoal over the shallows.
 *
 * Only the pipeline's overlay pass draws it (`Layer.Overlay`); the GI never sees it.
 */
export function createWater(options: WaterOptions): Water {
  const { renderer, field, environment, sun, cutDepth = 3.0 } = options;
  const half = field.half;

  const heightTexture = field.toTexture(512);
  heightTexture.name = 'islandHeight';

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
  // The physical surface: shallow-water equations on the bathymetry. `?waterSim=0`
  // falls back to the analytic Gerstner swell.
  const useSim = params.get('waterSim') !== '0';
  const sim = useSim
    ? new ShallowWater({ renderer, bathymetry: heightTexture, half, waterLevel: field.waterLevel, size: 512 })
    : null;
  // Wind waves from the spectrum ride on the simulated surface (see windWaves.ts).
  const wind = new WindWaves({ windSpeed: 4.5, fetch: 800, components: 48, gain: 1.0 });
  const windCap = Math.min(0.12, wind.amplitudeSum);

  // The deepest water the floor allows, for the CFL sub-step; the slab bottom is not it.
  let maxDepth = 0.2;
  for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) {
    const x = -half + ((i + 0.5) / 64) * 2 * half;
    const z = -half + ((j + 0.5) / 64) * 2 * half;
    maxDepth = Math.max(maxDepth, field.waterLevel - field.height(x, z));
  }
  maxDepth += 0.15;
  sim?.preroll(4.0, maxDepth);

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

  /** Shoaling: amplitude grows as the floor comes up, and dies on dry sand. */
  const shoaling = Fn(([xz]: [ReturnType<typeof vec2>]) => {
    const depth = waterLevel.sub(sandHeight(xz));
    const grow = mix(float(1.0), float(2.1), smoothstep(1.4, 0.12, depth));
    const wet = smoothstep(-0.02, 0.10, depth);
    return grow.mul(wet).mul(rimMask(xz));
  });

  /** Gerstner displacement of the point at (x, z), metres. */
  const gerstnerDisplacement = Fn(([xz]: [ReturnType<typeof vec2>]) => {
    const scale = shoaling(xz);
    const disp = vec3(0.0).toVar();
    for (const w of WAVES) {
      const k = (2 * Math.PI) / w.wavelength;
      const omega = Math.sqrt(GRAVITY * k);
      const theta = xz.x.mul(w.dx * k).add(xz.y.mul(w.dz * k)).sub(time.mul(omega));
      const a = scale.mul(w.amplitude);
      const q = w.steepness / (k * w.amplitude * WAVES.length);
      disp.addAssign(vec3(cos(theta).mul(a).mul(q * w.dx), sin(theta).mul(a), cos(theta).mul(a).mul(q * w.dz)));
    }
    return disp;
  });

  /** Surface normal (xyz) and Jacobian (w) of the displaced surface at (x, z). */
  const gerstnerNormalJacobian = Fn(([xz]: [ReturnType<typeof vec2>]) => {
    const scale = shoaling(xz);
    // ∂P/∂x = (1 − Σ Q w A Dx² sinθ, Σ w A Dx cosθ, −Σ Q w A Dx Dz sinθ), ∂P/∂z likewise.
    const dxx = float(1.0).toVar();
    const dxy = float(0.0).toVar();
    const dxz = float(0.0).toVar();
    const dzy = float(0.0).toVar();
    const dzz = float(1.0).toVar();
    for (const w of WAVES) {
      const k = (2 * Math.PI) / w.wavelength;
      const omega = Math.sqrt(GRAVITY * k);
      const theta = xz.x.mul(w.dx * k).add(xz.y.mul(w.dz * k)).sub(time.mul(omega));
      const wa = scale.mul(w.amplitude * k);
      const q = w.steepness / (k * w.amplitude * WAVES.length);
      const s = sin(theta).mul(wa);
      const c = cos(theta).mul(wa);
      dxx.subAssign(s.mul(q * w.dx * w.dx));
      dxy.addAssign(c.mul(w.dx));
      dxz.subAssign(s.mul(q * w.dx * w.dz));
      dzy.addAssign(c.mul(w.dz));
      dzz.subAssign(s.mul(q * w.dz * w.dz));
    }
    // N = normalize(∂P/∂z × ∂P/∂x), +Y up.
    const n = normalize(vec3(dxy.negate(), dxx.mul(dzz).sub(dxz.mul(dxz)), dzy.negate()));
    const jacobian = dxx.mul(dzz).sub(dxz.mul(dxz));
    return vec4(n, jacobian);
  });

  /** Simulated free surface η = b + d (capped); dry cells sit below the sand. */
  const simBase = sim
    ? Fn(([xz]: [ReturnType<typeof vec2>]) => {
        const q = sim.uvOf(xz) as unknown as ReturnType<typeof vec2>;
        // A 2×2 box over the cell (four bilinear taps at half-texel offsets): the grid
        // rings at its own scale next to steep ground, and the sheet must not show it.
        const h = float(0.5 / sim.size);
        const dTap = (o: ReturnType<typeof vec2>) => ((sim.stateNode.sample(q.add(o)) as typeof sim.stateNode).level(float(0.0)) as ReturnType<typeof vec4>).r;
        const d = dTap(vec2(h, h)).add(dTap(vec2(h.negate(), h))).add(dTap(vec2(h, h.negate()))).add(dTap(vec2(h.negate(), h.negate()))).mul(0.25);
        const b = (texture(heightTexture, q).level(float(0.0)) as ReturnType<typeof vec4>).r;
        // Continuous everywhere: the sheet is the free surface b + d where there is
        // water and the ground itself where there is none, so no triangle ever spans a
        // wet cell and a dry one as a spike. On ground above the water line the sheet
        // may ride at most a couple of centimetres over the stone (a film, not a wall);
        // whether such a film is drawn at all is the fragment's decision (see thinFilm).
        // The sheet never rises past the run-up ceiling (about one wave height over
        // still water, Hunt): whatever the solver piles against a boulder's flank is
        // clipped to a plane there instead of climbing the stone as a crown of teeth.
        const ceiling = waterLevel.add((sim.swellAmplitude as unknown as ReturnType<typeof float>).mul(1.5).add(0.03));
        return min(b.add(d), ceiling);
      })
    : null;
  /** Wind waves at (x, z): height and slope, shoaled by the local depth. */
  const windAt = Fn(([xz]: [ReturnType<typeof vec2>]) => {
    const depth = waterLevel.sub(sandHeight(xz));
    // No wind waves on dry sand or inside the rim seal.
    const alive = smoothstep(0.0, 0.08, depth).mul(rimMask(xz));
    return wind.evaluate(xz, depth).mul(alive);
  });
  /** Full free surface: simulation plus wind waves. */
  const simSurface = simBase
    ? Fn(([xz]: [ReturnType<typeof vec2>]) => simBase(xz).add(windAt(xz).x.min(float(windCap))))
    : null;

  /** Two drifting Worley layers; the cell edges are the bright caustic filaments. */
  const caustic = Fn(([xz, depth]: [ReturnType<typeof vec2>, ReturnType<typeof float>]) => {
    const t = time;
    const q1 = vec3(xz.x.mul(6.5).add(t.mul(0.12)), xz.y.mul(6.5).sub(t.mul(0.09)), t.mul(0.30));
    const q2 = vec3(xz.x.mul(9.0).sub(t.mul(0.08)), xz.y.mul(9.0).add(t.mul(0.13)), t.mul(0.24).add(5.0));
    const w1 = mx_worley_noise_vec2(q1, 1.0);
    const w2 = mx_worley_noise_vec2(q2, 1.0);
    const line1 = smoothstep(0.10, 0.0, w1.y.sub(w1.x));
    const line2 = smoothstep(0.10, 0.0, w2.y.sub(w2.x));
    const filaments = line1.mul(0.6).add(line2.mul(0.6)).add(line1.mul(line2).mul(1.8));
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
  const foamDriftMetresPerSecond = uniform(0.18);

  const foamSim = new THREE.MeshBasicNodeMaterial();
  foamSim.name = 'lagoonFoamField';
  foamSim.blending = THREE.NoBlending;
  foamSim.depthTest = false;
  foamSim.depthWrite = false;
  foamSim.colorNode = Fn(() => {
    const q = uv();
    const xz = q.sub(0.5).mul(2.0).mul(slabHalf);
    // Advection: with the simulated flow, or the primary swell's drift without it.
    const flow: THREE.Node = sim ? sim.stateNode.sample(q).gb.mul(foamDt) : vec2(WAVES[0].dx, WAVES[0].dz).mul(foamDriftMetresPerSecond).mul(foamDt);
    const from = q.sub((flow as ReturnType<typeof vec2>).div(slabHalf.mul(2.0)));
    const texel = float(1.5 / FOAM_SIZE);
    const spread = foamPrev.sample(from).r
      .add(foamPrev.sample(from.add(vec2(texel, 0.0))).r)
      .add(foamPrev.sample(from.sub(vec2(texel, 0.0))).r)
      .add(foamPrev.sample(from.add(vec2(0.0, texel))).r)
      .add(foamPrev.sample(from.sub(vec2(0.0, texel))).r)
      .mul(0.2);
    const decayed = spread.mul(exp(foamDt.negate().div(foamDecaySeconds)));

    const depth = waterLevel.sub(sandHeight(xz));
    const lace = mx_fractal_noise_float(vec3(xz.x.mul(3.0), xz.y.mul(3.0), time.mul(0.3)), 3, 2.2, 0.55).mul(0.5).add(0.5);
    const crest = sim ? sim.stateNode.sample(q).a : smoothstep(0.15, -0.35, gerstnerNormalJacobian(xz).w);
    const shallow = smoothstep(0.42, 0.0, depth).mul(smoothstep(-0.04, 0.04, depth));
    const shore = shallow.mul(smoothstep(0.25, 0.75, lace)).mul(0.9);
    const born = max(crest.mul(0.85), shore);
    const foam = max(decayed, born);
    // Wetness: where water stands now, or stood in the last half minute. The sand
    // shader reads it; sand the swash has reached stays dark and glossy as it dries.
    const standing = sim ? smoothstep(0.0005, 0.006, sim.stateNode.sample(q).r) : smoothstep(0.02, 0.0, depth.negate());
    const wetPrev = foamPrev.sample(q).g;
    const wetness = max(standing, wetPrev.mul(exp(foamDt.negate().div(28.0))));
    return vec4(foam, wetness, 0.0, 1.0);
  })();
  const foamQuad = new THREE.QuadMesh(foamSim);

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
    water.onField?.(foamRead.texture);
  };

  function buildMaterial(screen: { color: THREE.Texture; depth: THREE.Texture }, top: boolean): THREE.MeshStandardNodeMaterial {
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
      material.positionNode = simSurface
        ? vec3(positionLocal.x, simSurface(positionLocal.xz).mul(rimMask(positionLocal.xz)).add(waterLevel.mul(rimMask(positionLocal.xz).oneMinus())), positionLocal.z)
        : positionLocal.add(gerstnerDisplacement(positionLocal.xz));
    }

    // --- normal ------------------------------------------------------------------
    const wave = top && !sim ? gerstnerNormalJacobian(p.xz) : vec4(normalWorld, 1.0);
    const simNormal = sim && simBase && top
      ? Fn(() => {
          // Gradient of the simulated surface at cell spacing, plus the analytic wind slope.
          const h = float(sim.cell);
          const ex = simBase(p.xz.add(vec2(h, 0.0))).sub(simBase(p.xz.sub(vec2(h, 0.0)))).div(h.mul(2.0));
          const ez = simBase(p.xz.add(vec2(0.0, h))).sub(simBase(p.xz.sub(vec2(0.0, h)))).div(h.mul(2.0));
          const w = windAt(p.xz);
          return normalize(vec3(ex.add(w.y).negate(), 1.0, ez.add(w.z).negate()));
        })()
      : null;
    const nWorld = Fn(() => {
      if (!top) return normalWorld;
      const base = simNormal ?? wave.xyz;
      // Ripple detail: gradient of drifting noise at two scales.
      const e = float(0.03);
      const q1 = vec3(p.x.mul(5.5).add(t.mul(0.35)), p.z.mul(5.5).sub(t.mul(0.2)), t.mul(0.25));
      const n0 = mx_noise_float(q1);
      const nx = mx_noise_float(q1.add(vec3(e, 0.0, 0.0)));
      const nz = mx_noise_float(q1.add(vec3(0.0, e, 0.0)));
      const q2 = vec3(p.x.mul(17.0).sub(t.mul(0.5)), p.z.mul(17.0).add(t.mul(0.4)), t.mul(0.6).add(3.0));
      const m0 = mx_noise_float(q2);
      const mx = mx_noise_float(q2.add(vec3(e, 0.0, 0.0)));
      const mz = mx_noise_float(q2.add(vec3(0.0, e, 0.0)));
      const dx = nx.sub(n0).div(e).mul(0.035).add(mx.sub(m0).div(e).mul(0.010));
      const dz = nz.sub(n0).div(e).mul(0.035).add(mz.sub(m0).div(e).mul(0.010));
      return normalize(base.add(vec3(dx.negate(), 0.0, dz.negate())));
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

    // Refraction: bend the lookup by the surface normal, less with distance; never pull
    // something that stands in front of the surface into the water.
    const offset = nView.xy.mul(vec3(uniforms.refractionStrength).x).div(max(float(1.0), viewZ.negate()));
    const uvR = screenUV.add(vec2(offset.x, offset.y.negate()));
    const depthR = depthAt(uvR);
    const zR = perspectiveDepthToViewZ(depthR, cameraNear, cameraFar);
    const refractionValid = zR.lessThan(viewZ);
    const uvF = select(refractionValid, uvR, screenUV);
    const depthF = select(refractionValid, depthR, sceneDepth0);

    const floorView = getViewPosition(uvF, depthF, cameraProjectionMatrixInverse);
    const floorWorld = cameraWorldMatrix.mul(vec4(floorView, 1.0)).xyz;
    // A ray that leaves the slab before it meets anything (the back and right edges
    // have no cut face; the water block simply ends) is deep water to the boundary:
    // the path stops at the boundary and nothing shows through.
    const floorOutside = max(abs(floorWorld.x), abs(floorWorld.z)).greaterThan(slabHalf.add(0.6));
    const viewDirEarly = normalize(p.sub(cameraPosition));
    const boundaryT = Fn(() => {
      const tx = select(viewDirEarly.x.greaterThan(0.0), slabHalf.sub(p.x), slabHalf.negate().sub(p.x)).div(select(abs(viewDirEarly.x).greaterThan(1e-4), viewDirEarly.x, float(1e-4)));
      const tz = select(viewDirEarly.z.greaterThan(0.0), slabHalf.sub(p.z), slabHalf.negate().sub(p.z)).div(select(abs(viewDirEarly.z).greaterThan(1e-4), viewDirEarly.z, float(1e-4)));
      return clamp(min(abs(tx), abs(tz)), 0.0, 10.0);
    })();
    const pathLength = select(floorOutside, boundaryT.add(1.5), clamp(distance(p, floorWorld), 0.0, 10.0));
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
      const lace = mx_fractal_noise_float(vec3(p.x.mul(5.0), p.z.mul(5.0), t.mul(0.45)), 4, 2.3, 0.55);
      const fine = mx_noise_float(vec3(p.x.mul(22.0), p.z.mul(22.0), t.mul(0.8)));
      // Shallow against anything: sand, a boulder, the cut of a rock. Real depth, per pixel.
      const band = smoothstep(0.55, 0.0, verticalDepth);
      const edge = smoothstep(0.08, 0.0, verticalDepth);
      const surge = cos(verticalDepth.mul(28.0).sub(t.mul(2.0)).add(lace.mul(4.0))).mul(0.5).add(0.5);
      // Thin contact line against anything, from the real per-pixel depth.
      const contact = smoothstep(0.0, 0.7, edge.mul(0.9).add(fine.mul(0.55)).add(lace.mul(0.3)).add(band.mul(0.3)).sub(0.7)).mul(band).mul(0.7);
      // The drifting field, broken into lace by the noise so it never reads as a wash.
      const field = foamField.sample(p.xz.div(slabHalf.mul(2.0)).add(0.5)).r;
      const drifting = smoothstep(0.0, 0.8, field.mul(1.1).add(lace.mul(0.5)).add(fine.mul(0.25)).add(surge.mul(0.15).mul(band)).sub(0.6));
      return clamp(max(contact, drifting), 0.0, 1.0).mul(uniforms.foamStrength);
    })();
    const foamLight = vec3(uniforms.sunColor).mul(sunUp.mul(1.3)).add(vec3(0.35, 0.4, 0.45));
    // Froth: fine fractal grain, not cells — a foam sheet has no polka dots.
    const grain = mx_fractal_noise_float(vec3(p.x.mul(30.0), p.z.mul(30.0), t.mul(0.9)), 3, 2.1, 0.6);
    const froth = smoothstep(-0.6, 0.5, grain).mul(0.35).add(0.7);
    const foamColor = vec3(0.92, 0.95, 0.96).mul(foamLight).mul(froth);

    // Glitter: the sun caught by micro-facets the mesh cannot carry. A high-frequency
    // noise tilts the normal; the half-vector test is sharpened well past the GGX lobe.
    const glitter = Fn(() => {
      if (!top) return vec3(0.0);
      const jitter = vec3(
        mx_noise_float(vec3(p.x.mul(60.0), p.z.mul(60.0), t.mul(1.7))),
        float(0.0),
        mx_noise_float(vec3(p.x.mul(60.0).add(7.0), p.z.mul(60.0), t.mul(1.3))),
      ).mul(0.12);
      const nGlint = normalize(nWorld.add(jitter));
      const halfVector = normalize(sunDir.sub(viewDir));
      const spec = pow(clamp(dot(nGlint, halfVector), 0.0, 1.0), 900.0);
      const sparkle = smoothstep(0.55, 0.9, mx_noise_float(vec3(p.x.mul(40.0), p.z.mul(40.0), t.mul(2.5))).mul(0.5).add(0.5));
      return vec3(uniforms.sunColor).mul(spec).mul(sparkle).mul(sunUp).mul(6.0);
    })();

    // Thin crest lit from behind: more of the sun makes it through the peak.
    const peak = top ? clamp(p.y.sub(waterLevel).div(0.06), 0.0, 1.0) : float(0.0);
    const peakGlow = vec3(uniforms.scatter).mul(sunLight).mul(peak).mul(1.5);

    const shaded: THREE.Node = mix(under.add(reflection).add(peakGlow), foamColor, foamMask).add(glitter);
    const simState = (sim ? sim.stateNode.sample(sim.uvOf(p.xz) as unknown as ReturnType<typeof vec2>) : vec4(0.0)) as ReturnType<typeof vec4>;
    // Run-up thinner than a few millimetres is wet sand, not a water surface; up to a
    // couple of centimetres the sheet fades into the (wet) sand under it.
    // Run-up thinner than a few millimetres is wet sand, not a water surface. On
    // ground above the water line (a boulder's flank) the run-up must be deeper still
    // before it reads as a surface: a film there is wet stone.
    const groundHere = sandHeight(p.xz);
    const needed = float(0.004).add(max(groundHere.sub(waterLevel), 0.0));
    // Run-up on a slope reaches about one wave height above still water (Hunt);
    // ground higher than that never carries a surface, whatever the solver piles there.
    const runupCeiling = sim ? (sim.swellAmplitude as unknown as ReturnType<typeof float>).mul(1.5).add(0.03) : float(1.0);
    const tooHigh = groundHere.sub(waterLevel).greaterThan(runupCeiling);
    // The sheet's real height over the real floor (scene depth), not the solver's
    // column over its own bathymetry: the two floors differ by centimetres, and a film
    // judged on the wrong one pokes through the sand as a row of teeth.
    const sheetAboveFloor = select(floorOutside, float(1.0), p.y.sub(floorWorld.y));
    const thinFilm = top && sim ? simState.r.lessThan(needed).or(tooHigh).or(sheetAboveFloor.lessThan(0.004)) : float(0.0).greaterThan(1.0);
    const filmFade = top && sim ? smoothstep(needed, needed.add(0.026), simState.r).mul(smoothstep(0.004, 0.03, sheetAboveFloor)) : float(1.0);
    const debug: THREE.Node | null =
      debugMode === 'depth' ? vec3(verticalDepth.mul(0.5))
      : debugMode === 'path' ? vec3(pathLength.mul(0.3))
      : debugMode === 'foam' ? vec3(foamMask)
      : debugMode === 'jacobian' ? vec3(clamp(wave.w.negate().add(0.5), 0.0, 1.0))
      : debugMode === 'sim' && sim ? vec3(p.y.sub(waterLevel).mul(8.0).add(0.5), simState.gb.abs().mul(0.5))
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

  if (!wantCuts) group.remove(frontMesh, leftMesh);
  for (const mesh of [topMesh, frontMesh, leftMesh]) {
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
  const bindScreen = (color: THREE.Texture, depth: THREE.Texture) => {
    const previous = materials;
    const surface = buildMaterial({ color, depth }, true);
    const cut = buildMaterial({ color, depth }, false);
    topMesh.material = surface;
    frontMesh.material = cut;
    leftMesh.material = cut;
    materials = [surface, cut];
    for (const m of previous) m.dispose();
  };
  bindScreen(placeholderColor, placeholderDepth);

  // Numbers, not impressions: `__water.simStats()` reads the state back, and
  // `?waterInspect=1` (or `=z:<metres>`) draws the map and a section on screen.
  (window as unknown as Record<string, unknown>).__water = {
    simStats: async () => (sim ? sim.readStats() : null),
    foamDebug: () => ({ isRenderTarget: (foamRead as unknown as { isRenderTarget?: boolean }).isRenderTarget, textures: foamRead.textures?.length, width: foamRead.width }),
    foamStats: async () => {
      const { size, foam, wetness } = await water.readFoamField();
      let foamMax = 0, wetMax = 0, wetCount = 0;
      for (let i = 0; i < size * size; i++) { foamMax = Math.max(foamMax, foam[i]); wetMax = Math.max(wetMax, wetness[i]); if (wetness[i] > 0.2) wetCount++; }
      return { foamMax, wetMax, wetFraction: wetCount / (size * size) };
    },
  };
  const inspectParam = params.get('waterInspect');
  const inspector = sim && inspectParam
    ? new WaterInspector(renderer, sim, field, { sectionZ: inspectParam.startsWith('z:') ? Number(inspectParam.slice(2)) : undefined, readFoam: () => water.readFoamField() })
    : null;

  const sunDirection = new THREE.Vector3();
  let previousTime = -1;
  const controls: Water['controls'] = {
    swellAmplitude: sim ? (sim.swellAmplitude.value as number) : 0.06,
    swellPeriod: sim ? (sim.swellPeriod.value as number) : 1.4,
    swellDirection: -45,
    windSpeed: wind.windSpeed,
    windDirection: (wind.windDirection * 180) / Math.PI,
    friction: sim ? (sim.friction.value as number) : 0.12,
    apply() {
      if (sim) {
        sim.swellAmplitude.value = controls.swellAmplitude;
        sim.swellPeriod.value = controls.swellPeriod;
        sim.setSwellDirection((controls.swellDirection * Math.PI) / 180);
        sim.friction.value = controls.friction;
      }
      wind.setWind(controls.windSpeed, (controls.windDirection * Math.PI) / 180);
    },
  };
  const water: Water = {
    group,
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
      sim?.step(Math.min(0.05, Math.max(0.001, dt)), maxDepth);
      inspector?.update(performance.now());
      stepFoam(dt);
      sunDirection.copy(sun.position).sub(sun.target.position).normalize();
      (uniforms.sunDir.value as THREE.Vector3).copy(sunDirection);
      (uniforms.sunColor.value as THREE.Color).copy(sun.color).multiplyScalar(Math.min(1.5, sun.intensity * 0.5));
    },
  };
  return water;
}
