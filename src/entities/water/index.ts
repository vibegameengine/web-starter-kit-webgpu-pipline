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
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { IslandField } from '../island/heightField.ts';
import { WATER_ABSORB } from './medium.ts';

export interface WaterOptions {
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
  update(): void;
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
  const { field, environment, sun, cutDepth = 3.0 } = options;
  const half = field.half;

  const heightTexture = field.toTexture(256);
  heightTexture.name = 'islandHeight';

  const uniforms = {
    absorb: uniform(WATER_ABSORB.clone()),
    scatter: uniform(new THREE.Color(0.012, 0.105, 0.115)),
    scatterStrength: uniform(1.0),
    envStrength: uniform(0.55),
    foamStrength: uniform(1.0),
    causticStrength: uniform(1.4),
    refractionStrength: uniform(0.06),
    sunColor: uniform(new THREE.Color(1, 0.95, 0.85)),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
  };
  const waterLevel = uniform(field.waterLevel);
  const slabHalf = uniform(half);
  const debugMode = new URLSearchParams(window.location.search).get('waterDebug');

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

  /** Two drifting Worley layers; the cell edges are the bright caustic filaments. */
  const caustic = Fn(([xz, depth]: [ReturnType<typeof vec2>, ReturnType<typeof float>]) => {
    const t = time;
    const q1 = vec3(xz.x.mul(3.0).add(t.mul(0.12)), xz.y.mul(3.0).sub(t.mul(0.09)), t.mul(0.30));
    const q2 = vec3(xz.x.mul(4.2).sub(t.mul(0.08)), xz.y.mul(4.2).add(t.mul(0.13)), t.mul(0.24).add(5.0));
    const w1 = mx_worley_noise_vec2(q1, 1.0);
    const w2 = mx_worley_noise_vec2(q2, 1.0);
    const line1 = smoothstep(0.07, 0.0, w1.y.sub(w1.x));
    const line2 = smoothstep(0.07, 0.0, w2.y.sub(w2.x));
    const filaments = line1.mul(0.6).add(line2.mul(0.6)).add(line1.mul(line2).mul(1.8));
    // Fade in just below the surface, decay with depth as the light spreads.
    const fade = smoothstep(0.0, 0.05, depth).mul(exp(depth.mul(-1.5)));
    return filaments.mul(fade);
  });

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
      material.positionNode = positionLocal.add(gerstnerDisplacement(positionLocal.xz));
    }

    // --- normal ------------------------------------------------------------------
    const wave = top ? gerstnerNormalJacobian(p.xz) : vec4(normalWorld, 1.0);
    const nWorld = Fn(() => {
      if (!top) return normalWorld;
      const base = wave.xyz;
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
    const pathLength = clamp(distance(p, floorWorld), 0.0, 10.0);
    const verticalDepth = max(waterLevel.sub(floorWorld.y), 0.0);
    const sceneColor = texture(screen.color, uvF).rgb;

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
      const shoreShape = lace.mul(0.75).add(fine.mul(0.3)).add(surge.mul(0.4).mul(band)).add(band.mul(0.9)).add(edge.mul(0.35)).sub(1.05);
      const shore = smoothstep(0.0, 0.45, shoreShape).mul(band.mul(0.9).add(0.1)).mul(smoothstep(0.0, 0.05, band));
      // Folding crest: the Jacobian goes negative where a face steepens past itself.
      const crest = smoothstep(0.15, -0.35, wave.w).mul(smoothstep(0.3, 0.7, lace.mul(0.5).add(0.5)));
      return clamp(shore.add(crest), 0.0, 1.0).mul(uniforms.foamStrength);
    })();
    const foamLight = vec3(uniforms.sunColor).mul(sunUp.mul(1.3)).add(vec3(0.35, 0.4, 0.45));
    const foamColor = vec3(0.92, 0.95, 0.96).mul(foamLight);

    // Thin crest lit from behind: more of the sun makes it through the peak.
    const peak = top ? clamp(p.y.sub(waterLevel).div(0.05), 0.0, 1.0) : float(0.0);
    const peakGlow = vec3(uniforms.scatter).mul(sunLight).mul(peak).mul(1.5);

    const shaded: THREE.Node = mix(under.add(reflection).add(peakGlow), foamColor, foamMask);
    const debug: THREE.Node | null =
      debugMode === 'depth' ? vec3(verticalDepth.mul(0.5))
      : debugMode === 'path' ? vec3(pathLength.mul(0.3))
      : debugMode === 'foam' ? vec3(foamMask)
      : debugMode === 'jacobian' ? vec3(clamp(wave.w.negate().add(0.5), 0.0, 1.0))
      : null;
    const shown = debug ?? shaded;
    material.emissiveNode = Fn(() => {
      Discard(behindScene);
      return shown;
    })();
    return material;
  }

  // --- geometry ------------------------------------------------------------------
  const group = new THREE.Group();
  group.name = 'water';

  const top = new THREE.PlaneGeometry(2 * half, 2 * half, 192, 192);
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

  const sunDirection = new THREE.Vector3();
  return {
    group,
    uniforms,
    bindScreen,
    update() {
      sunDirection.copy(sun.position).sub(sun.target.position).normalize();
      (uniforms.sunDir.value as THREE.Vector3).copy(sunDirection);
      (uniforms.sunColor.value as THREE.Color).copy(sun.color).multiplyScalar(Math.min(1.5, sun.intensity * 0.5));
    },
  };
}
