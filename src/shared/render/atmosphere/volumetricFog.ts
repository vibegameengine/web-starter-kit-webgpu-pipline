import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  abs,
  exp,
  float,
  int,
  length,
  log,
  max,
  mix,
  mx_noise_float,
  normalize,
  perspectiveDepthToViewZ,
  pow,
  screenUV,
  select,
  smoothstep,
  texture3D,
  textureLoad,
  textureStore,
  uniform,
  uvec2,
  uvec3,
  vec2,
  vec3,
  vec4,
  globalId,
} from 'three/tsl';

/**
 * TSL's fluent API returns a different concrete class per operator; inside a shader
 * body the nodes are treated as one loosely typed surface, as `frameGraph.ts` does.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/**
 * Authoring knobs. Everything here is a uniform: changing a value takes effect on the
 * next frame without recompiling a shader. Distances are metres, densities 1/m.
 */
export interface VolumetricFogSettings {
  enabled: boolean;
  /** Extinction σ_t at `baseHeight`, 1/m. */
  density: number;
  /** Density decays as exp(-(y - baseHeight) * heightFalloff) above `baseHeight`. */
  heightFalloff: number;
  baseHeight: number;
  /** Scattering albedo σ_s/σ_t per channel; slightly blue reads as air, grey as smoke. */
  albedo: THREE.Color;
  /** Multiplier on the sun's in-scatter. 1 is physical; a diorama wants more. */
  sunIntensity: number;
  /** Henyey–Greenstein g of the sun lobe; 0.6–0.8 gives the halo toward the sun. */
  anisotropy: number;
  /** Multiplier on the sky ambient in-scatter (mean environment radiance). */
  ambientIntensity: number;
  /** Density modulation by two octaves of Perlin noise: 0 = uniform, 1 = ±100 %. */
  noiseStrength: number;
  /** Noise frequency, 1/m. */
  noiseScale: number;
  /** Wind carrying the noise, m/s and compass degrees. */
  windSpeed: number;
  windDirection: number;
  /** Soft box the fog lives in: outside `halfExtents` it fades over `softness`. */
  center: THREE.Vector3;
  halfExtents: THREE.Vector3;
  softness: number;
  /** Depth range of the froxel grid. Nothing beyond `far` scatters. */
  near: number;
  far: number;
  /** History weight of the temporal filter, 0 = off. */
  temporalBlend: number;
}

export const DEFAULT_FOG_SETTINGS: Readonly<VolumetricFogSettings> = {
  enabled: true,
  density: 0.02,
  heightFalloff: 0.3,
  baseHeight: 0,
  albedo: new THREE.Color(0.9, 0.94, 1.0),
  sunIntensity: 3,
  anisotropy: 0.65,
  ambientIntensity: 0.6,
  noiseStrength: 0.5,
  noiseScale: 0.18,
  windSpeed: 0.6,
  windDirection: 30,
  center: new THREE.Vector3(0, 0, 0),
  halfExtents: new THREE.Vector3(10, 4, 10),
  softness: 5,
  near: 0.5,
  far: 80,
  temporalBlend: 0.9,
};

/** What `apply` returns: the fogged image, or one of its two terms for inspection. */
export type FogView = 'fogged' | 'inscatter' | 'transmittance';

export interface VolumetricFogOptions {
  /** Froxel grid; the screen is divided into this many columns/rows, `depth` slices. */
  width?: number;
  height?: number;
  depth?: number;
  settings?: Partial<VolumetricFogSettings>;
}

/**
 * Froxel volumetric fog — the UE "Volumetric Fog" / "Local Fog Volume" pair, on
 * the sun this pipeline already has.
 *
 * Every frame:
 *
 * 1. **Scatter** (compute, one thread per froxel). The froxel's jittered world
 *    position gets a density from the height falloff, the soft box and animated
 *    noise; the sun is looked up in the *real* shadow map (raw depth load, the same
 *    matrix the surfaces use), so fronds and rocks carve shafts out of the air; the sky
 *    contributes the environment's mean radiance isotropically. The result is
 *    `(σ_s · L_in, σ_t)`, blended with last frame's volume reprojected through the
 *    previous view-projection.
 * 2. **Integrate** (compute, one thread per screen column). Walks the slices front
 *    to back with the analytic per-segment solution, storing accumulated in-scatter
 *    and transmittance at every slice.
 * 3. **Apply** (in the frame graph's composite). `colour · T + L_in`, trilinearly
 *    sampled at the pixel's depth. Linear HDR, before tone mapping.
 *
 * Slices are exponential in view depth between `near` and `far`, so resolution is
 * spent where the diorama is. The grid is independent of the screen size.
 *
 * What this is not: there is no sky/aerial-perspective LUT (the beach floats in a
 * studio, there is no sky to render), no multiple scattering beyond the isotropic
 * ambient term, and no fog lit by the surfel GI or by local lights yet.
 */
export class VolumetricFog {
  readonly settings: VolumetricFogSettings;
  readonly width: number;
  readonly height: number;
  readonly depth: number;

  private readonly volumes: [THREE.Storage3DTexture, THREE.Storage3DTexture];
  private readonly integrated: THREE.Storage3DTexture;
  private frame = 0;
  private historyValid = false;
  private boundShadowDepth: THREE.Texture | null = null;
  private scatterNodes: [THREE.ComputeNode, THREE.ComputeNode] | null = null;
  private integrateNode: THREE.ComputeNode | null = null;
  private readonly ambient = new THREE.Color(0.3, 0.35, 0.45);

  // --- uniforms ------------------------------------------------------------------
  private readonly uCameraWorld = uniform(new THREE.Matrix4());
  private readonly uProjectionInverse = uniform(new THREE.Matrix4());
  private readonly uPrevViewProjection = uniform(new THREE.Matrix4());
  private readonly uCameraPosition = uniform(new THREE.Vector3());
  private readonly uCameraNear = uniform(0.1);
  private readonly uCameraFar = uniform(1000);
  private readonly uNear = uniform(0.5);
  private readonly uFar = uniform(80);
  private readonly uJitter = uniform(new THREE.Vector3());
  private readonly uBlend = uniform(0);
  /** 1 once a volume has been integrated with the fog enabled; the composite reads it. */
  private readonly uActive = uniform(0);

  private readonly uDensity = uniform(0.02);
  private readonly uHeightFalloff = uniform(0.3);
  private readonly uBaseHeight = uniform(0);
  private readonly uAlbedo = uniform(new THREE.Color());
  private readonly uSunRadiance = uniform(new THREE.Color());
  private readonly uSunDirection = uniform(new THREE.Vector3(0, 1, 0));
  private readonly uAnisotropy = uniform(0.65);
  private readonly uAmbient = uniform(new THREE.Color());
  private readonly uNoiseStrength = uniform(0.5);
  private readonly uNoiseScale = uniform(0.18);
  private readonly uWindOffset = uniform(new THREE.Vector3());
  private readonly uCenter = uniform(new THREE.Vector3());
  private readonly uHalfExtents = uniform(new THREE.Vector3());
  private readonly uSoftness = uniform(5);
  private readonly uShadowMatrix = uniform(new THREE.Matrix4());
  private readonly uShadowMapSize = uniform(new THREE.Vector2(4096, 4096));
  private readonly uShadowBias = uniform(0);
  /** Which scatter volume this frame wrote; the integrate pass reads that one. */
  private readonly uParity = uniform(0);

  private readonly prevViewProjection = new THREE.Matrix4();
  private readonly windOffset = new THREE.Vector3();
  private lastTimeMs = 0;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly sun: THREE.DirectionalLight,
    environment: THREE.DataTexture | null,
    options: VolumetricFogOptions = {},
  ) {
    this.width = options.width ?? 160;
    this.height = options.height ?? 90;
    this.depth = options.depth ?? 64;
    const defaults = DEFAULT_FOG_SETTINGS;
    const given = options.settings ?? {};
    this.settings = {
      ...defaults,
      ...given,
      albedo: (given.albedo ?? defaults.albedo).clone(),
      center: (given.center ?? defaults.center).clone(),
      halfExtents: (given.halfExtents ?? defaults.halfExtents).clone(),
    };
    if (environment) this.ambient.copy(meanEnvironmentRadiance(environment));

    const make = (name: string) => {
      const tex = new THREE.Storage3DTexture(this.width, this.height, this.depth);
      tex.name = name;
      tex.type = THREE.HalfFloatType;
      tex.format = THREE.RGBAFormat;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      return tex;
    };
    this.volumes = [make('fogScatterA'), make('fogScatterB')];
    this.integrated = make('fogIntegrated');
    this.integrateNode = this.buildIntegrate();
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  /** Off costs nothing: no dispatch, and the composite drops the sample entirely. */
  setEnabled(value: boolean): void {
    if (value === this.settings.enabled) return;
    this.settings.enabled = value;
    this.historyValid = false;
    if (!value) this.uActive.value = 0;
  }

  /** Forget the temporal history, e.g. after a camera cut. */
  invalidateHistory(): void {
    this.historyValid = false;
  }

  /**
   * Runs the two compute passes for this frame. Call after the camera's matrices are
   * current and before the frame graph renders. The first frame after a scene starts
   * has no shadow map yet; the fog stays inactive until it exists.
   */
  update(nowMs: number): void {
    if (!this.settings.enabled) return;
    const depthTexture = this.shadowDepthTexture();
    if (!depthTexture) return;
    if (depthTexture !== this.boundShadowDepth) {
      this.boundShadowDepth = depthTexture;
      this.scatterNodes = [this.buildScatter(0, depthTexture), this.buildScatter(1, depthTexture)];
      this.historyValid = false;
    }

    this.pushUniforms(nowMs);

    const parity = this.frame & 1;
    this.uParity.value = parity;
    this.renderer.compute(this.scatterNodes![parity], [
      Math.ceil(this.width / 8),
      Math.ceil(this.height / 8),
      this.depth,
    ]);
    this.renderer.compute(this.integrateNode!, [Math.ceil(this.width / 8), Math.ceil(this.height / 8), 1]);

    this.prevViewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.historyValid = true;
    this.uActive.value = 1;
    this.frame++;
  }

  /**
   * Fog over an HDR colour at a raw (non-linear) scene depth, both screen-space nodes
   * evaluated in the composite. Returns the input untouched while the fog is off or not
   * yet integrated, so the toggle is seamless.
   */
  apply(beauty: N, depth: N, view: FogView = 'fogged'): N {
    const s = this;
    return Fn(() => {
      const viewZ = perspectiveDepthToViewZ(depth, s.uCameraNear, s.uCameraFar);
      const dist = viewZ.negate().clamp(s.uNear, s.uFar);
      const ratio = log(s.uFar.div(s.uNear));
      // Texel k holds the integral up to the far boundary of slice k.
      const w = log(dist.div(s.uNear)).div(ratio).sub(0.5 / s.depth).clamp(0, 1);
      const fog = texture3D(s.integrated, vec3(screenUV, w));
      let fogged: N;
      if (view === 'inscatter') fogged = vec4(fog.rgb, 1);
      else if (view === 'transmittance') fogged = vec4(vec3(fog.a), 1);
      else fogged = vec4(vec3(beauty).mul(fog.a).add(fog.rgb), vec4(beauty).a);
      return mix(vec4(beauty), fogged, s.uActive);
    })();
  }

  dispose(): void {
    for (const v of this.volumes) v.dispose();
    this.integrated.dispose();
  }

  // --- internals -----------------------------------------------------------------

  private shadowDepthTexture(): THREE.Texture | null {
    const map = this.sun.shadow.map as (THREE.RenderTarget & { depthTexture?: THREE.Texture }) | null;
    return map?.depthTexture ?? null;
  }

  private pushUniforms(nowMs: number): void {
    const { settings: s, camera, sun } = this;
    const dt = this.lastTimeMs === 0 ? 0 : Math.min(0.1, (nowMs - this.lastTimeMs) / 1000);
    this.lastTimeMs = nowMs;

    camera.updateMatrixWorld();
    this.uCameraWorld.value.copy(camera.matrixWorld);
    this.uProjectionInverse.value.copy(camera.projectionMatrixInverse);
    this.uPrevViewProjection.value.copy(this.prevViewProjection);
    this.uCameraPosition.value.setFromMatrixPosition(camera.matrixWorld);
    this.uCameraNear.value = camera.near;
    this.uCameraFar.value = camera.far;
    this.uNear.value = s.near;
    this.uFar.value = Math.max(s.near * 2, s.far);

    // Halton (2, 3, 5): the froxel centre wanders inside its cell; the temporal blend
    // turns that into supersampling of the density and shadow.
    const f = (this.frame % 64) + 1;
    this.uJitter.value.set(halton(f, 2), halton(f, 3), halton(f, 5));
    this.uBlend.value = this.historyValid ? s.temporalBlend : 0;

    this.uDensity.value = s.density;
    this.uHeightFalloff.value = s.heightFalloff;
    this.uBaseHeight.value = s.baseHeight;
    this.uAlbedo.value.copy(s.albedo);
    this.uAnisotropy.value = THREE.MathUtils.clamp(s.anisotropy, -0.95, 0.95);
    this.uAmbient.value.copy(this.ambient).multiplyScalar(s.ambientIntensity);
    this.uNoiseStrength.value = s.noiseStrength;
    this.uNoiseScale.value = s.noiseScale;
    const wind = THREE.MathUtils.degToRad(s.windDirection);
    this.windOffset.x -= Math.sin(wind) * s.windSpeed * dt * s.noiseScale;
    this.windOffset.z -= Math.cos(wind) * s.windSpeed * dt * s.noiseScale;
    this.windOffset.y -= 0.15 * s.windSpeed * dt * s.noiseScale;
    this.uWindOffset.value.copy(this.windOffset);
    this.uCenter.value.copy(s.center);
    this.uHalfExtents.value.copy(s.halfExtents);
    this.uSoftness.value = Math.max(0.01, s.softness);

    // Irradiance from the analytic sun: colour × intensity, as the materials see it.
    this.uSunRadiance.value.copy(sun.color).multiplyScalar(sun.intensity * s.sunIntensity);
    sunPosition.setFromMatrixPosition(sun.matrixWorld);
    sunTarget.setFromMatrixPosition(sun.target.matrixWorld);
    this.uSunDirection.value.copy(sunPosition).sub(sunTarget).normalize();
    // The same world → shadow-map transform the surfaces use, refreshed now so a moving
    // sun does not leave the fog one frame behind.
    sun.shadow.updateMatrices(sun);
    this.uShadowMatrix.value.copy(sun.shadow.matrix);
    this.uShadowMapSize.value.set(sun.shadow.mapSize.width, sun.shadow.mapSize.height);
    this.uShadowBias.value = sun.shadow.bias;
  }

  /** View-space ray through the centre of froxel column `uv` (0..1, y down). */
  private viewRay(uv: N): N {
    const ndc = vec2(uv.x.mul(2).sub(1), float(1).sub(uv.y.mul(2)));
    const h = this.uProjectionInverse.mul(vec4(ndc, 0.5, 1));
    return h.xyz.div(h.w);
  }

  private buildScatter(writeIndex: 0 | 1, shadowDepth: THREE.Texture): THREE.ComputeNode {
    const s = this;
    const write = this.volumes[writeIndex];
    const read = this.volumes[1 - writeIndex];
    const dims = vec3(this.width, this.height, this.depth);

    return Fn(() => {
      const id = globalId;
      If(id.x.lessThan(s.width).and(id.y.lessThan(s.height)).and(id.z.lessThan(s.depth)), () => {
        // Jittered position inside the froxel.
        const cell = vec3(id).add(0.5).add(s.uJitter.sub(0.5));
        const uvw = cell.div(dims);
        const dirView = s.viewRay(uvw.xy);
        const ratio = s.uFar.div(s.uNear);
        const dist = s.uNear.mul(pow(ratio, uvw.z));
        const pView = dirView.mul(dist.div(dirView.z.negate()));
        const p = s.uCameraWorld.mul(vec4(pView, 1)).xyz.toVar();

        // --- density -------------------------------------------------------------
        const above = max(p.y.sub(s.uBaseHeight), 0);
        const heightTerm = exp(above.mul(s.uHeightFalloff).negate());
        const q = max(abs(p.sub(s.uCenter)).sub(s.uHalfExtents), vec3(0));
        const boxTerm = float(1).sub(smoothstep(0, 1, length(q).div(s.uSoftness)));
        const np = p.mul(s.uNoiseScale).add(s.uWindOffset);
        const n = mx_noise_float(np).add(mx_noise_float(np.mul(2.3).add(17.0)).mul(0.5));
        const noiseTerm = float(1).add(n.mul(s.uNoiseStrength)).clamp(0, 2);
        const sigmaT = s.uDensity.mul(heightTerm).mul(boxTerm).mul(noiseTerm).toVar();
        const sigmaS = vec3(s.uAlbedo).mul(sigmaT);

        // --- sun, through the real shadow map ------------------------------------
        const V = normalize(p.sub(s.uCameraPosition));
        const cosTheta = s.uSunDirection.dot(V);
        const g = s.uAnisotropy;
        const g2 = g.mul(g);
        const hg = float(1).sub(g2).div(pow(float(1).add(g2).sub(g.mul(cosTheta).mul(2)), 1.5).mul(4 * Math.PI));
        const phase = mix(hg, float(1 / (4 * Math.PI)), float(0.15));
        const sc = s.uShadowMatrix.mul(vec4(p, 1));
        const scp = sc.xyz.div(sc.w);
        const shadowUv = vec2(scp.x, float(1).sub(scp.y));
        const receiver = scp.z.mul(2).sub(1).add(s.uShadowBias);
        const inMap = shadowUv.x.greaterThanEqual(0).and(shadowUv.x.lessThanEqual(1))
          .and(shadowUv.y.greaterThanEqual(0)).and(shadowUv.y.lessThanEqual(1))
          .and(receiver.greaterThanEqual(0)).and(receiver.lessThanEqual(1));
        const texel = uvec2(shadowUv.mul(s.uShadowMapSize).clamp(vec2(0), s.uShadowMapSize.sub(1)));
        const occluder = textureLoad(shadowDepth, texel, 0).r;
        const lit = select(inMap, select(receiver.lessThanEqual(occluder), float(1), float(0)), float(1));
        const sunTerm = vec3(s.uSunRadiance).mul(phase).mul(lit);

        // --- sky ambient, isotropic -----------------------------------------------
        const inScatter = sigmaS.mul(sunTerm.add(s.uAmbient));
        const current = vec4(inScatter, sigmaT).toVar();

        // --- temporal reprojection -----------------------------------------------
        const prevClip = s.uPrevViewProjection.mul(vec4(p, 1));
        const prevNdc = prevClip.xyz.div(prevClip.w);
        const prevUv = vec2(prevNdc.x.mul(0.5).add(0.5), float(0.5).sub(prevNdc.y.mul(0.5)));
        const prevW = log(prevClip.w.max(1e-4).div(s.uNear)).div(log(ratio));
        const prevValid = prevClip.w.greaterThan(s.uNear)
          .and(prevUv.x.greaterThanEqual(0)).and(prevUv.x.lessThanEqual(1))
          .and(prevUv.y.greaterThanEqual(0)).and(prevUv.y.lessThanEqual(1))
          .and(prevW.greaterThanEqual(0)).and(prevW.lessThanEqual(1));
        const history = texture3D(read, vec3(prevUv, prevW)).level(float(0));
        const blend = select(prevValid, s.uBlend, float(0));
        const blended = mix(current, history, blend);

        textureStore(write, uvec3(id.x, id.y, id.z), blended);
      });
    })()
      .computeKernel([8, 8, 1])
      .setName(`Fog Scatter ${writeIndex}`);
  }

  private buildIntegrate(): THREE.ComputeNode {
    const s = this;
    const dims = vec2(this.width, this.height);
    const depth = this.depth;

    return Fn(() => {
      const id = globalId;
      If(id.x.lessThan(s.width).and(id.y.lessThan(s.height)), () => {
        const uv = vec2(id.xy).add(0.5).div(dims);
        const dirView = s.viewRay(uv);
        // Slice thickness is measured along the view axis; the ray through this
        // column is longer by 1/cos.
        const rayScale = length(dirView).div(dirView.z.negate());
        const ratio = s.uFar.div(s.uNear);
        const transmittance = float(1).toVar();
        const radiance = vec3(0).toVar();
        Loop(int(depth), ({ i }: { i: N }) => {
          const k = float(i);
          const d0 = s.uNear.mul(pow(ratio, k.div(depth)));
          const d1 = s.uNear.mul(pow(ratio, k.add(1).div(depth)));
          const segment = d1.sub(d0).mul(rayScale);
          const sample = s.readScatter(uvec3(id.x, id.y, i));
          const sigmaT = sample.a;
          const segmentT = exp(sigmaT.mul(segment).negate());
          // ∫₀ˡ S·e^{-σt} dt = S (1 - e^{-σl}) / σ, with the σ → 0 limit S·l.
          const integral = select(sigmaT.greaterThan(1e-5), float(1).sub(segmentT).div(sigmaT.max(1e-5)), segment);
          radiance.addAssign(sample.rgb.mul(integral).mul(transmittance));
          transmittance.mulAssign(segmentT);
          textureStore(s.integrated, uvec3(id.x, id.y, i), vec4(radiance, transmittance));
        });
      });
    })()
      .computeKernel([8, 8, 1])
      .setName('Fog Integrate');
  }

  /**
   * The scatter volume written this frame. Two nodes reading alternately would need
   * two integrate pipelines; instead both volumes are bound and the parity picks.
   */
  private readScatter(coord: N): N {
    const a = texture3D(this.volumes[0], coord).setSampler(false);
    const b = texture3D(this.volumes[1], coord).setSampler(false);
    return select(this.uParity.equal(0), a, b);
  }
}

const sunPosition = new THREE.Vector3();
const sunTarget = new THREE.Vector3();

function halton(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

/**
 * Solid-angle-weighted mean radiance of an equirectangular HDR, with the sun's own
 * pixels clamped away — the sun is added analytically, through the shadow map, and
 * counting it twice would light the shadowed air.
 */
export function meanEnvironmentRadiance(env: THREE.DataTexture): THREE.Color {
  const { data, width, height } = env.image as { data: ArrayLike<number>; width: number; height: number };
  const isHalf = data instanceof Uint16Array;
  const channels = data.length / (width * height);
  const read = (i: number) => (isHalf ? THREE.DataUtils.fromHalfFloat(data[i] as number) : (data[i] as number));

  const rowWeight = (y: number) => Math.sin((Math.PI * (y + 0.5)) / height);
  const pass = (cap: number) => {
    let r = 0, g = 0, b = 0, w = 0;
    for (let y = 0; y < height; y++) {
      const wy = rowWeight(y);
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * channels;
        r += Math.min(cap, read(i)) * wy;
        g += Math.min(cap, read(i + 1)) * wy;
        b += Math.min(cap, read(i + 2)) * wy;
        w += wy;
      }
    }
    return new THREE.Color(r / w, g / w, b / w);
  };
  const rough = pass(Number.POSITIVE_INFINITY);
  const lum = 0.2126 * rough.r + 0.7152 * rough.g + 0.0722 * rough.b;
  return pass(lum * 4);
}
