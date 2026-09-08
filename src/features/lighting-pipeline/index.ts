import * as THREE from 'three/webgpu';
import type GUI from 'lil-gui';
import { FrameGraph, GiMode, SplitView, VolumetricFog, type Antialiasing, type FogView, type VolumetricFogSettings } from '../../shared/render/index.ts';
import { installReceiverPlaneShadows } from '../../shared/render/receiverPlaneShadow.ts';
import { installSoftSunShadows, U_SUN_ANGULAR_DIAMETER_DEG } from '../../shared/render/softSunShadow.ts';
import { CacheStats, WorldState, Layer, Mobility, applyMobility } from '../../shared/world/index.ts';
import { Hud } from '../../shared/ui/hud.ts';
import { SurfelGI } from '../../shared/gi/index.ts';
import {
  applyLightmap,
  assignLightmapUvs,
  measureCoverage,
  rasteriseLightmapGBuffer,
} from '../../shared/gi/bake/index.ts';
import { uniform, float, uint, vec4, mix } from 'three/tsl';
import { ContactOcclusionPass, DEFAULT_CONTACT_SETTINGS, type ContactOcclusionSettings } from '../../shared/gi/contact/contactOcclusionPass.ts';
import { createContactBVH, type ContactBVHBundle } from '../../shared/gi/contact/contactBvh.ts';
import { ReflectionPass, type ReflectionSettings } from '../../shared/gi/reflect/reflectionPass.ts';
import { meanEnvironmentRadiance } from '../../shared/render/atmosphere/volumetricFog.ts';
import { AutoExposure } from '../../shared/render/exposure.ts';
import { DEFAULT_MOTION_BLUR, MotionBlur, type MotionBlurGaze, type MotionBlurSettings } from '../../shared/render/motionBlur.ts';
import { readFloatTexture, readValidationTexture } from '../../shared/render/gpuReadback.ts';
import { bakeKey, loadBake, saveBake } from '../../shared/gi/bake/persistedBake.ts';
import { padLightmapCharts } from '../../shared/gi/bake/chartPadding.ts';
import {
  createLightControls,
  findSunPositionWeighted,
  setLightAngles,
  setLightAnglesFromEnvMapSunUVLocation,
} from '../../shared/gi/surfel/lighting.ts';
import { applyOcclusionSettings } from '../../shared/gi/surfel/surfelRadialDepth.ts';
import { MAX_TEMPORAL_M } from '../../shared/gi/surfel/constants.ts';
import { giLightSummary } from '../../shared/gi/surfel/sceneLights.ts';
import { addDynamicDemoObject, type DynamicObject } from '../../shared/gi/surfel/content.ts';

/**
 * What a scene has to hand the pipeline. Everything about *lighting* — sun, shadow,
 * GI, bake, streaming, frame graph, debug hooks, the render loop — lives here and
 * nowhere else; a scene only supplies geometry, a camera and, if it has one, a
 * per-frame update for its own animation.
 */
export interface SceneHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: { update(): void; target: THREE.Vector3 };
  sun: THREE.DirectionalLight;
  /** Per-frame animation owned by the scene (wind, water). Never lighting. */
  update?: (elapsedSeconds: number) => void;
  /** The scene's own knobs (waves, wind) in the shared GUI. Never lighting. */
  bindGui?: (gui: GUI) => void;
  /** Draw the lighting environment behind the scene (Cornell) or not (a diorama). */
  skyIsBackground: boolean;
  /** Whether the orbiting demo sphere is in the scene unless `?mover=0`. */
  moverByDefault: boolean;
  /**
   * Present when the scene has single-layer translucents on `Layer.Overlay` (water):
   * the frame graph adds the overlay pass and calls this with the composited colour
   * and the scene depth every time those textures are (re)created.
   */
  bindScreen?: (color: THREE.Texture, depth: THREE.Texture, normal: THREE.Texture) => void;
  /**
   * Volumetric fog preset for this scene (density, height, the box it lives in). Absent
   * = no fog unless `?fog=1`; present = on unless `?fog=0`. Runtime toggle in the GUI.
   */
  atmosphere?: Partial<VolumetricFogSettings>;
  /**
   * Veiling glare preset (see `FrameGraph.setGlare`). Absent = off unless `?glare=1`;
   * present = on unless `?glare=0`. Runtime toggle in the GUI.
   */
  glare?: { strength: number; radius: number };
  /**
   * Contact occlusion preset (radius, rays, strength). On by default (`?contact=0`
   * turns it off); idle in `lightmap` mode, which has no BVH.
   */
  contact?: Partial<ContactOcclusionSettings>;
  /**
   * The scene has no movable GI receiver: once the cache is warmed or restored the
   * whole surfel lifecycle can stop — no spawning, ageing, allocation or ray
   * integration, only the camera-centred grid and the per-pixel resolve. `?freezeAll=`
   * overrides. Measured on the beach at 4K, 2026-09-08: 31.1 ms of frame with the
   * lifecycle live, 23.8 ms frozen.
   */
  staticLighting?: boolean;
  /** Traced reflections preset. On by default (`?reflections=0` turns it off). */
  reflections?: Partial<ReflectionSettings>;
  /** Motion blur preset. Off by default (`?motionBlur=1` turns it on, `?gaze=centre|camera`, `?shutter=`, `?integration=` ms). */
  motionBlur?: Partial<MotionBlurSettings>;
}

export interface PipelineUi {
  setLoading(message: string): void;
  clearLoading(): void;
  showError(error: unknown): void;
  /** `?hud=0`: no HUD, no GUI, no inspector widget in a judged frame. */
  showChrome: boolean;
}

export interface LightingPipeline {
  gi: SurfelGI;
  /** The one environment: it lights every scene and can be its background. */
  envTexture: THREE.Texture;
  /** Wires the host into the pipeline and starts the render loop. */
  run(host: SceneHost, gui: GUI, ui: PipelineUi): Promise<void>;
}

/**
 * The sun's shadow, configured in one place for every scene: the Cornell values
 * (content.ts), with the ortho footprint grown to cover a scene larger than the box.
 */
export function configureSunShadow(sun: THREE.DirectionalLight, scene: THREE.Scene): void {
  const bounds = new THREE.Box3();
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.layers.isEnabled(Layer.GiStatic)) bounds.expandByObject(mesh);
  });
  const radius = bounds.isEmpty() ? 0 : bounds.getSize(new THREE.Vector3()).length() * 0.5;
  const extent = Math.max(15, Math.ceil(radius * 1.1));
  sun.castShadow = true;
  sun.shadow.mapSize.width = 4096;
  sun.shadow.mapSize.height = 4096;
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 100;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.bias = -0.0003;
  sun.shadow.camera.updateProjectionMatrix();
}

/** The orbiting demo sphere, tagged Movable so it lands in the dynamic BVH. */
function addDynamicSphere(scene: THREE.Scene, options: { radius?: number } = {}): DynamicObject {
  const dynamic = addDynamicDemoObject(scene, options);
  applyMobility(dynamic.mesh, Mobility.Movable);
  return dynamic;
}

/**
 * Creates the pipeline's GPU-side state (surfel GI, environment) before any scene
 * exists, so a scene can read the environment while it builds.
 */
export async function createLightingPipeline(renderer: THREE.WebGPURenderer, ui: PipelineUi): Promise<LightingPipeline> {
  const params = new URLSearchParams(window.location.search);
  ui.setLoading('Loading GI assets');
  const gi = await SurfelGI.create(renderer);
  gi.liveCoverage = params.get('liveCoverage') !== 'legacy';
  return {
    gi,
    envTexture: gi.envTexture,
    run: (host, gui, runUi) => runPipeline(renderer, gi, host, gui, runUi),
  };
}

async function runPipeline(renderer: THREE.WebGPURenderer, gi: SurfelGI, host: SceneHost, gui: GUI, ui: PipelineUi): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const num = (key: string): number | null => {
    const raw = params.get(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const { setLoading, clearLoading, showError, showChrome } = ui;
  let fatal = false;
  window.addEventListener('error', () => { fatal = true; });
  window.addEventListener('unhandledrejection', () => { fatal = true; });

  const world = new WorldState();
  const stats = new CacheStats();
  const { scene, camera, controls, sun } = host;
  gi.rigidSurfels = params.get('rigidSurfels') !== '0';
  gi.setLeafTransmit(params.get('giLeafTransmit') !== '0');

  // Sun direction comes from the brightest region of the environment map, not from
  // authored angles — that is what keeps the analytic sun and the image-based
  // ambient agreeing with each other. Same call webgiya makes on every scene load.
  const sunUv = findSunPositionWeighted(gi.envTexture);
  setLightAnglesFromEnvMapSunUVLocation(sunUv[0], sunUv[1]);

  const { updateAnimation, updateLightFromAngles, lightCfg } = createLightControls(
    gui,
    sun,
  );
  const envIntensityParam = num('env') ?? 1;
  // `?sun=0` puts the sun out without removing it, which is the only way to show that
  // an emissive surface is a *light source* rather than a surface that happens to look
  // bright when something else is lighting it. Pair with `?env=0`; the sky is the other
  // thing in this frame that emits.
  const sunIntensity = num('sun');
  if (sunIntensity !== null) lightCfg.intensity = sunIntensity;
  // `?sunAz=&sunEl=` override the env-derived angles for experiments only; every
  // scene defaults to the same env-derived sun the Cornell box uses.
  const sunAz = num('sunAz');
  const sunEl = num('sunEl');
  if (sunAz !== null && sunEl !== null) setLightAngles(sunAz, sunEl);
  // `?exposure=` fixes the exposure (auto metering off); otherwise the meter decides.
  const exposure = num('exposure');
  applyOcclusionSettings({ shadowStrength: 0.5 });

  // AFTER the host populated its scene, deliberately: buildCornellScene ends by
  // hard-coding dirLight.position to (1,3,1), which throws away the env-derived sun
  // and leaves the analytic light disagreeing with the image-based ambient.
  // Re-applying the angles here is what puts this build's sun at (19.4, 32.0, 14.2) —
  // the same place webgiya's ends up.
  updateLightFromAngles();
  configureSunShadow(sun, scene);

  // Sun shadow filter: `soft` (default) is PCSS on the receiver-plane filter — the
  // 0.533° disc's penumbra grows with blocker distance; `receiverPlane` is the hard
  // filter it is built on (iteration 19); `legacy` is three's own PCF.
  const shadowFilter = params.get('shadowFilter') ?? 'soft';
  if (shadowFilter === 'receiverPlane') installReceiverPlaneShadows(sun);
  else if (shadowFilter !== 'legacy') installSoftSunShadows(sun, gi.blueNoiseTexture);
  const sunDisc = num('sunDisc');
  if (sunDisc !== null) U_SUN_ANGULAR_DIAMETER_DEG.value = sunDisc;

  // --- bake a real lightmap --------------------------------------------------
  // UV atlas -> rasterise world position/normal into it -> seed one surfel per texel
  // -> run webgiya's integrator on them -> copy their irradiance into the atlas.
  // The lighting is upstream's, unmodified; only where surfels come from changed.
  const bakeMs = num('bake') ?? 5000;
  // 512 by default, not 1024: the bake gives every covered texel its own surfel, and
  // the pool holds MAX_SURFELS of them. A 1024 atlas at current chart density wants
  // more texels than that, and the overflow would silently come out black.
  const lightmapSize = num('lm') ?? 512;
  // MAX_TEMPORAL_M, read from the constant rather than typed out: below it every texel
  // is short of the temporal convergence the runtime reaches, and the shortfall shows
  // up as per-texel grain. This used to be a literal here and a different literal in
  // `bakeLightmap`'s argument for it, which is worse than either number on its own.
  const lightmapIterations = num('iters') ?? MAX_TEMPORAL_M;
  const lightmapRays = num('rays') ?? 32;
  // Default: frozen static atlas plus live GI for unbaked receivers.
  gi.freezeCompletely = params.get('freezeAll') === null ? host.staticLighting === true : params.get('freezeAll') === '1';

  // Unconditionally, and before the BVH. Unconditionally because the mode is a
  // runtime switch and the unwrap cannot be redone later: it must be in the geometry
  // by the time the BVH merges it. Before the BVH because the unwrapper gives uv1 to
  // some meshes and not others, and the merge is what has to cope with that.
  setLoading('Unwrapping lightmap UVs');
  const lightmapLayout = assignLightmapUvs(scene, {
    padding: num('pad') ?? 0.12,
    // Density and filter guards are packed for this resolution, through the same
    // coarsest mip used by the virtual lightmap's always-resident fallback.
    atlasSize: lightmapSize,
  });

  // Before the BVH, deliberately: being in the scene at build time is what gets the
  // sphere's material an id in the shared diffuse array, without which a ray that hits
  // it cannot be shaded. `?mover=0` leaves it out entirely.
  // A host whose reference has no mover opts out by default; `?mover=1` puts the
  // sphere in anyway, `?mover=0` takes it out of a host that wants it.
  const wantMover = host.moverByDefault ? params.get('mover') !== '0' : params.get('mover') === '1';
  const moverCount = wantMover ? Math.max(1, Math.min(64, Math.floor(num('movers') ?? 1))) : 0;
  const movers = Array.from({ length: moverCount }, () =>
    addDynamicSphere(scene, { radius: num('moverRadius') ?? (moverCount > 1 ? 0.22 : undefined) }));
  const dynamic = movers.length ? {
    update(t: number) {
      movers.forEach((mover, i) => {
        if (moverCount === 1) { mover.update(t); return; }
        // Multi-receiver fixture: separate surfaces, shared static lighting and pool.
        mover.mesh.position.set((i % 4 - 1.5) * 1.25 + Math.sin(t + i) * .15,
          3 + Math.floor(i / 4) * .8, 2.8 + Math.sin(t * .7 + i) * .2);
        mover.mesh.rotation.set(t * .3, t * 1.5 + i, 0);
      });
    },
  } : null;
  dynamic?.update(0);

  setLoading('Building static BVH');
  gi.buildScene(renderer, scene);
  gi.setDynamicTracing(params.get('dyntrace') !== '0');

  // Applied here, not with the rest of the GUI defaults further down: the bake runs
  // before those exist, and a knob that only takes effect after the cache has converged
  // is a knob that does nothing.
  
  gi.setEnvControls(envIntensityParam, 4);

  const lightmapIntensity = uniform(0);
  // Read by the mode switch, written by the GUI slider: a plain const here meant the
  // slider's value was silently discarded on every switch.
  const lightmapParams = { intensity: num('lmi') ?? 1 };
  let lightmapTexture: THREE.Texture | null = null;
  let lightmapGBuffer: ReturnType<typeof rasteriseLightmapGBuffer> | null = null;
  let lightmapCoverage = 0;
  let bakedSunVersion = -1;
  let baked = false;
  const bakeCache = { source: 'none', storage: 'none', key: '', saved: false, error: '' };
  // The water medium the tracer attenuates sunlight through is bakeable state too,
  // and so are the art-directed sun angles.

  // Declared here rather than with the rest of the GUI because the mode switch reads
  // them: switching to lightmap means "bake with the current settings".
  const bakeParams = {
    seconds: bakeMs / 1000,
    passes: lightmapIterations,
    frozen: gi.freezeCompletely,
  };

  setLoading('Compiling frame graph');
  const frameGraph = new FrameGraph(renderer, scene, camera, {
    giMode: (params.get('giMode') as GiMode) ?? GiMode.Combined,
    indirectIntensity: num('gi') ?? 1,
    splitView: (params.get('split') as SplitView) ?? SplitView.Off,
    overlay: host.bindScreen !== undefined,
    // `?aa=taa|fxaa|none`; TAA is the default and the accumulation every later
    // stochastic pass (soft shadows, occlusion, reflections) settles into.
    antialiasing: (['taa', 'fxaa', 'none'] as Antialiasing[]).find((m) => m === params.get('aa')) ?? 'taa',
  });
  if (host.bindScreen) {
    frameGraph.onScreenTextures = host.bindScreen;
    frameGraph.forceRebuild();
  }

  // Volumetric fog (shared/render/atmosphere): the sun's own shadow map lights the air,
  // so it needs nothing from the scene beyond the preset. `?fog=0|1` overrides it.
  const fogParam = params.get('fog');
  const fogEnabled = fogParam === null ? (host.atmosphere?.enabled ?? host.atmosphere !== undefined) : fogParam !== '0';
  const fog = new VolumetricFog(renderer, camera, sun, gi.envTexture, {
    settings: { ...host.atmosphere, enabled: fogEnabled },
  });
  // Tuning overrides and the two term views, for captures: `?fogDensity=&fogSun=&fogSky=
  // &fogNoise=&fogView=inscatter|transmittance`.
  const fogDensity = num('fogDensity'); if (fogDensity !== null) fog.settings.density = fogDensity;
  const fogSun = num('fogSun'); if (fogSun !== null) fog.settings.sunIntensity = fogSun;
  const fogSky = num('fogSky'); if (fogSky !== null) fog.settings.ambientIntensity = fogSky;
  const fogNoise = num('fogNoise'); if (fogNoise !== null) fog.settings.noiseStrength = fogNoise;
  const fogViewParam = params.get('fogView');
  const fogView: FogView = fogViewParam === 'inscatter' || fogViewParam === 'transmittance' ? fogViewParam : 'fogged';
  const applyFog = (beauty: THREE.Node, depth: THREE.Node) => fog.apply(beauty, depth, fogView) as THREE.Node;
  const syncFog = () => frameGraph.setAtmosphere(fog.enabled ? applyFog : null);
  syncFog();

  // Veiling glare, the other half of "air": light spreading in the lens rather than in
  // the scene. Off for the Cornell reference frame unless asked, on where a scene asks.
  const glareParam = params.get('glare');
  const glare = {
    enabled: glareParam === null ? host.glare !== undefined : glareParam !== '0',
    strength: num('glareStrength') ?? host.glare?.strength ?? 0.22,
    radius: num('glareRadius') ?? host.glare?.radius ?? 0.5,
  };
  const syncGlare = () => frameGraph.setGlare(glare.enabled ? { strength: glare.strength, radius: glare.radius } : null);
  syncGlare();

  // Contact occlusion: short rays against the GI's own BVHs from the GI G-buffer, an
  // occlusion of the indirect terms only. `?contact=0|1`, `?contactRadius=`.
  const contactParam = params.get('contact');
  const contact = new ContactOcclusionPass(renderer, camera, gi.blueNoiseTexture, {
    ...host.contact,
    enabled: contactParam === null ? (host.contact?.enabled ?? DEFAULT_CONTACT_SETTINGS.enabled) : contactParam !== '0',
  });
  const contactRadius = num('contactRadius'); if (contactRadius !== null) contact.settings.radius = contactRadius;
  const contactScale = num('contactScale'); if (contactScale !== null) contact.settings.resolutionScale = contactScale;
  const contactRays = num('contactRays'); if (contactRays !== null) contact.settings.rays = contactRays;
  const contactIntensity = uniform(contact.settings.intensity);
  // Full-detail static tree for the contact rays, built once the GI's tree exists (it
  // supplies the material-id table) and only when the pass is on.
  let contactBvh: ContactBVHBundle | null = null;
  const contactTree = () => {
    if (!contact.enabled) return null;
    if (!contactBvh && gi.staticBvh) contactBvh = createContactBVH(scene, gi.staticBvh.materialIdByUUID);
    return contactBvh;
  };
  let contactReaderBound: unknown = null;
  const syncContact = () => {
    const reader = contact.enabled ? contact.reader : null;
    if (reader === contactReaderBound) return;
    contactReaderBound = reader;
    if (!reader) { frameGraph.setContactOcclusion(null); return; }
    const width = reader.width;
    const height = reader.height;
    frameGraph.setContactOcclusion({
      intensity: contactIntensity,
      sample: (uv) => {
        // The pass runs on a coarser grid; bilinear over its four nearest cells.
        const fx = float(uv.x).mul(width).sub(0.5).clamp(0, width - 1);
        const fy = float(uv.y).mul(height).sub(0.5).clamp(0, height - 1);
        const x0 = uint(fx.floor()); const y0 = uint(fy.floor());
        const x1 = x0.add(uint(1)).min(uint(width - 1)); const y1 = y0.add(uint(1)).min(uint(height - 1));
        const tx = fx.fract(); const ty = fy.fract();
        const at = (x: ReturnType<typeof uint>, y: ReturnType<typeof uint>) => {
          const index = y.mul(uint(width)).add(x);
          return reader.parity.lessThan(0.5).select(vec4(reader.current.element(index)), vec4(reader.previous.element(index)));
        };
        const top = mix(at(x0, y0), at(x1, y0), tx);
        const bottom = mix(at(x0, y1), at(x1, y1), tx);
        return mix(top, bottom, ty);
      },
    });
  };

  /**
   * `surfel` resolves the cache on screen every frame; `lightmap` samples a texture
   * and does no GI work at all.
   *
   * These are not two views of one state, they are two consumers of the *same* surfel
   * pool, and the bake spends the whole pool on atlas texels. So a switch is not a
   * toggle — each direction has to re-prepare the pool for its own occupant, which is
   * why this is async and shows the loading overlay rather than flipping instantly.
   */
  // One pipeline: static light baked once into the atlas, dynamics from live
  // surfels, the frame adds them. There used to be three modes — `surfel` ran the
  // live chain alone, `lightmap` switched the whole dynamic half off, `hybrid` was
  // the two together — kept "for comparison" since the first iteration and never
  // collapsed. Each mode had grown its own wiring: the freeze flag was set in three
  // places, one per mode, and none knew about the others, so the GUI's "freeze all
  // GI" silently did nothing in two of the three.

  async function prepareLightmap(iterations: number, forceBake = false): Promise<void> {
    const persistent = params.get('bakeCache') !== '0';
    let key = '';
    bakeCache.source = 'none'; bakeCache.storage = 'none'; bakeCache.saved = false; bakeCache.error = '';
    if (persistent) {
      setLoading('Checking saved static lighting');
      try {
        key = await bakeKey(params.get('scene') ?? 'default');
        bakeCache.key = key;
        const saved = forceBake ? null : await loadBake(key);
        if (saved) {
          setLoading('Restoring saved static lighting');
          // The surfel data the bake left in the pool is not restored: rays read
          // unwrapped static hits from the atlas now, and measured 2026-09-09 on
          // Cornell the data changes the frame by 0.058/255 against a 0.034/255
          // drift, while costing 190976 pool slots and 143 MB against 16384 and
          // 12.8 MB. `?atlasSurfels=1` puts it back.
          gi.restoreStaticBake(renderer, saved.surfels, params.get('atlasSurfels') === '1');
          const texture = new THREE.DataTexture(Uint16Array.from(saved.pixels, THREE.DataUtils.toHalfFloat), saved.size, saved.size, THREE.RGBAFormat, THREE.HalfFloatType);
          texture.magFilter = texture.minFilter = THREE.LinearFilter; texture.needsUpdate = true;
          renderer.initTexture(texture);
          await publishLightmap(texture, saved.pixels);
          bakeCache.source = 'saved'; bakeCache.storage = 'bundle'; bakeCache.saved = true;
          console.log(`[bake-cache] restored ${key}`);
          return;
        }
      } catch (error) {
        bakeCache.error = String(error);
        console.warn(`[bake-cache] cannot reuse saved data: ${error}`);
      }
    }
    if (!lightmapGBuffer) {
      setLoading('Rasterising lightmap G-Buffer');
      lightmapGBuffer = rasteriseLightmapGBuffer(renderer, scene, lightmapSize);
      const coverage = await measureCoverage(renderer, lightmapGBuffer, lightmapSize);
      console.log(
        `[lightmap] atlas coverage ${coverage.covered}/${coverage.total} texels ` +
          `(${(coverage.fraction * 100).toFixed(1)}%)`,
      );
      if (coverage.covered === 0) {
        throw new Error(
          'lightmap: the UV-space rasterisation covered zero texels — nothing to bake',
        );
      }
      lightmapCoverage = coverage.covered;
    }

    // The pool may still hold the runtime cache; the bake needs all of it.
    gi.resetCache(renderer);

    const result = await gi.bakeLightmap(
      renderer,
      scene,
      lightmapGBuffer,
      lightmapSize,
      {
        iterations,
        raysPerSurfel: lightmapRays,
        dilate: 0, // Pad once below, constrained to the chart that owns each texel.
        dynamicReceivers: true,
        viewpoint:
          params.get('bakecam') === 'view' ? camera.position.clone() : undefined,
        onProgress: (fraction, iteration) => {
          setLoading(
            `Baking lightmap ${(fraction * 100).toFixed(0)}% · pass ${iteration}`,
          );
        },
      },
    );

    if (result && result.seeded < lightmapCoverage) {
      throw new Error(
        `[lightmap] surfel pool exhausted: ${result.seeded}/${lightmapCoverage} ` +
          'covered texels got a surfel. Cannot publish an incomplete bake. Lower ?lm=',
      );
    }

    if (!result?.texture) {
      throw new Error(
        'lightmap: the bake produced no texture — see [lightmap] logs above',
      );
    }

    const pixels = (await readFloatTexture(renderer, result.texture)).data;
    // Coverage, not brightness, identifies missing data. Preserve measured black
    // and extend each chart only into its own mip-aligned guard rectangle.
    const filled = padLightmapCharts(pixels, lightmapSize, lightmapLayout.regions);
    let published: THREE.Texture = result.texture;
    if (filled > 0) {
      console.log(`[lightmap] padded ${filled} unmeasured texels within ${lightmapLayout.regions.length} charts; safe mip ${lightmapLayout.safeMip}`);
      const texture = new THREE.DataTexture(Uint16Array.from(pixels, THREE.DataUtils.toHalfFloat), lightmapSize, lightmapSize, THREE.RGBAFormat, THREE.HalfFloatType);
      texture.magFilter = texture.minFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      renderer.initTexture(texture);
      published = texture;
    }
    await publishLightmap(published, pixels);
    bakeCache.source = 'baked'; bakeCache.storage = 'computed';
    if (key) {
      setLoading('Saving static lighting in project');
      try {
        const surfels = await gi.captureStaticBake(renderer, result.seeded);
        await saveBake(key, { size: lightmapSize, pixels, surfels });
        bakeCache.saved = true;
        console.log(`[bake-cache] saved ${key}`);
      } catch (error) {
        bakeCache.error = String(error);
        console.warn(`[bake-cache] bake is usable but could not be saved: ${error}`);
      }
    }
  }

  /**
   * Publishes the baked atlas as one resident texture.
   *
   * It used to have a second path that cut the atlas into 128-pixel pages and
   * streamed them over HTTP, with a CPU pass over every static triangle each frame
   * to decide which pages to fetch. That is for an atlas too large to hold; this one
   * is 512 square and resident in full. Removed 2026-09-08; the machinery is in
   * commit 34de65e if a scene ever needs it.
   */
  async function publishLightmap(texture: THREE.Texture, _pixels: Float32Array): Promise<void> {
    lightmapTexture = texture;
    applyLightmap(scene, lightmapTexture, lightmapIntensity);
    frameGraph.setLightmapTexture(lightmapTexture);
    // The tracer reads the same atlas at static hits (`?atlasHits=0` keeps every hit
    // on the surfel cache, which is the A/B control for what that read changes).
    if (params.get('atlasHits') !== '0') gi.useBakedAtlas(lightmapTexture);
  }

  let refreshFrozenControl = () => {};
  let switching = false;
  /** Set by the GUI so a failed or refused switch can put the control back. */
  /**
   * Produces the static half: the atlas, restored from disk or baked once.
   *
   * `forceBake` ignores the saved cache and integrates again — the GUI's re-bake
   * button and the only thing that ever invalidates the atlas, since the sun is
   * bakeable state the GUI can move.
   */
  async function bakeStatic(forceBake = false): Promise<void> {
    if (switching) {
      console.warn('[lighting] bake ignored: one is already running');
      return;
    }
    switching = true;
    baked = false;
    try {
      // The composite still holds the last resolve output; without dropping it the
      // scene would be lit by a stale screen-space GI texture *and* the atlas.
      frameGraph.setGiTextures(null, null);
      await prepareLightmap(bakeParams.passes, forceBake);
      lightmapIntensity.value = lightmapParams.intensity;
      // The atlas is the static half and never re-integrates. The live chain keeps
      // running for everything that is not in it — unless the scene has said it has
      // no movers at all (`staticLighting`, or `?freezeAll=`), and then there is
      // nothing for it to serve. Collapsing the three modes into one path briefly
      // hard-coded `false` here, which ignored that flag and left the whole chain
      // running on the beach: 33.2 ms a frame at 4K against 15.
      gi.setFrozen(gi.freezeCompletely);
      bakedSunVersion = world.sunVersion;
      baked = true;
    } finally {
      switching = false;
      refreshFrozenControl();
      clearLoading();
    }
  }

  const hud = showChrome
    ? new Hud(world, stats, () =>
        !baked
          ? 'converging'
          : // The sun is bakeable state. Moving it does not invalidate anything
            // automatically -- re-baking on every slider tick would be unusable --
            // so the only honest thing is to say the texture is now out of date.
            world.sunVersion !== bakedSunVersion
            ? `atlas ${lightmapSize}px · STALE (sun moved, re-bake)`
            : `atlas ${lightmapSize}px · static${gi.frozen ? '' : ' + dynamics live'}`,
      )
    : null;

  await bakeStatic();

  const giParams = {
    mode: frameGraph.giMode,
    indirectIntensity: frameGraph.indirectIntensity.value,
    baseSamples: 4,
    rayBudget: 4096,
    envIntensity: envIntensityParam,
    envLod: 4,
    fromDirect: 1,
    fromIndirect: 1,
    albedoBoost: 1,
  };
  gi.setBaseSampleCount(giParams.baseSamples);

  const giFolder = gui.addFolder('GI (surfel)');
  giFolder
    .add(giParams, 'mode', Object.values(GiMode))
    .name('output')
    .onChange((mode: GiMode) => frameGraph.setGiMode(mode));
  giFolder
    .add(giParams, 'indirectIntensity', 0, 8, 0.05)
    .name('indirect')
    .onChange((v: number) => {
      frameGraph.indirectIntensity.value = v;
    });
  giFolder
    .add(giParams, 'baseSamples', 1, 64, 1)
    .name('rays/surfel')
    .onChange((v: number) => gi.setRuntimeSampleCount(v));
  giFolder.add(giParams, 'rayBudget', 256, 16384, 256).name('GI rays/frame')
    .onChange((value: number) => { gi.runtimeRayBudget = value; });

  const atlas = gi.getCacheAtlas();
  frameGraph.setCacheAtlasNode(atlas?.node ?? null);
  frameGraph.setLightmapTexture(lightmapTexture);

  const splitParams = {
    right: (params.get('split') as SplitView) ?? SplitView.Off,
    at: frameGraph.splitPosition,
  };
  const splitFolder = gui.addFolder('Split view');
  splitFolder
    .add(splitParams, 'right', Object.values(SplitView))
    .name('right pane')
    .onChange((v: SplitView) => {
      frameGraph.setSplitView(v);
    });
  if (atlas) {
    splitFolder
      .add({ rows: atlas.rows.value as number }, 'rows', 1, atlas.side, 1)
      .name('cache rows')
      .onChange((v: number) => {
        atlas.rows.value = v;
      });
  }
  splitFolder.add(splitParams, 'at', 0, 1, 0.01).name('divider').onChange((v: number) => {
    frameGraph.splitPosition = v;
    frameGraph.setSplitView(splitParams.right);
    frameGraph.forceRebuild();
  });

  const modeFolder = gui.addFolder('Lighting');
  if (shadowFilter === 'soft') {
    modeFolder.add(U_SUN_ANGULAR_DIAMETER_DEG, 'value', 0, 5, 0.01).name('sun disc (°)');
  }
  modeFolder
    .add(lightmapParams, 'intensity', 0, 8, 0.05)
    .name('atlas mul')
    .onChange((v: number) => { lightmapIntensity.value = v; });

  host.bindGui?.(gui);
  const fogFolder = gui.addFolder('Atmosphere');
  const fogSettings = fog.settings;
  fogFolder.add(fogSettings, 'enabled').name('volumetric fog').onChange((v: boolean) => { fog.setEnabled(v); syncFog(); });
  fogFolder.add(fogSettings, 'density', 0, 0.12, 0.001).name('density (1/m)');
  fogFolder.add(fogSettings, 'heightFalloff', 0, 2, 0.01).name('height falloff (1/m)');
  fogFolder.add(fogSettings, 'baseHeight', -5, 10, 0.05).name('base height (m)');
  fogFolder.add(fogSettings, 'sunIntensity', 0, 12, 0.05).name('sun scatter');
  fogFolder.add(fogSettings, 'anisotropy', -0.9, 0.9, 0.01).name('anisotropy g');
  fogFolder.add(fogSettings, 'ambientIntensity', 0, 3, 0.01).name('sky scatter');
  fogFolder.add(fogSettings, 'noiseStrength', 0, 1, 0.01).name('noise');
  fogFolder.add(fogSettings, 'noiseScale', 0.02, 1, 0.01).name('noise scale (1/m)');
  fogFolder.add(fogSettings, 'windSpeed', 0, 5, 0.05).name('wind (m/s)');
  fogFolder.add(fogSettings, 'temporalBlend', 0, 0.97, 0.01).name('temporal blend');
  fogFolder.close();
  // Reflections: screen trace, then the contact tree + movers, then the environment.
  // `?reflections=0|1`, `?reflectionsRoughness=`.
  const reflectionsParam = params.get('reflections');
  const reflections = new ReflectionPass(renderer, camera, gi.blueNoiseTexture, gi.envTexture, meanEnvironmentRadiance(gi.envTexture).multiplyScalar(0.5), {
    ...host.reflections,
    enabled: reflectionsParam === null ? (host.reflections?.enabled ?? true) : reflectionsParam !== '0',
  });
  const reflectionsRoughness = num('reflectionsRoughness'); if (reflectionsRoughness !== null) reflections.settings.maxRoughness = reflectionsRoughness;
  const reflectionsEvery = num('reflectionsEvery'); if (reflectionsEvery !== null) reflections.settings.traceInterval = reflectionsEvery;
  const contactEvery = num('contactEvery'); if (contactEvery !== null) contact.settings.traceInterval = contactEvery;
  const reflectionsIntensity = uniform(reflections.settings.intensity);
  let reflectionsReaderBound: unknown = null;
  const syncReflections = () => {
    const reader = reflections.enabled ? reflections.reader : null;
    if (reader === reflectionsReaderBound) return;
    reflectionsReaderBound = reader;
    if (!reader) { frameGraph.setReflections(null); return; }
    const width = reader.width;
    const height = reader.height;
    frameGraph.setReflections({
      intensity: reflectionsIntensity,
      specular: gi.specularTexture,
      sample: (uv) => {
        // 3x3 box over the half grid: the cheap half of Stachowiak's neighbour ray
        // reuse. One ray a frame on a moving leaf has no history to lean on, and nine
        // neighbours cut that noise by three before the TAA sees it.
        const cx = uint(float(uv.x).mul(width).clamp(0, width - 1));
        const cy = uint(float(uv.y).mul(height).clamp(0, height - 1));
        const at = (x: ReturnType<typeof uint>, y: ReturnType<typeof uint>) => {
          const index = y.mul(uint(width)).add(x);
          return reader.parity.lessThan(0.5).select(vec4(reader.current.element(index)), vec4(reader.previous.element(index)));
        };
        let sum: THREE.Node = vec4(0);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const x = uint(float(cx).add(dx).clamp(0, width - 1));
          const y = uint(float(cy).add(dy).clamp(0, height - 1));
          sum = (sum as ReturnType<typeof vec4>).add(at(x, y));
        }
        return (sum as ReturnType<typeof vec4>).div(9);
      },
    });
  };
  const reflectionsFolder = gui.addFolder('Reflections');
  reflectionsFolder.add(reflections.settings, 'enabled').name('enabled').onChange((v: boolean) => { reflections.setEnabled(v); syncReflections(); });
  reflectionsFolder.add(reflections.settings, 'maxRoughness', 0.05, 1, 0.01).name('max roughness');
  reflectionsFolder.add(reflections.settings, 'historyWeight', 0, 0.97, 0.01).name('history');
  reflectionsFolder.add(reflections.settings, 'screenSteps', 8, 96, 1).name('screen steps');
  reflectionsFolder.add(reflections.settings, 'intensity', 0, 2, 0.01).name('strength').onChange((v: number) => { reflectionsIntensity.value = v; });
  reflectionsFolder.close();
  // Auto exposure (shared/render/exposure.ts) and film grain, both GPU-side.
  const autoExposure = new AutoExposure(renderer, exposure !== null ? { auto: false, manual: exposure } : {});
  frameGraph.setExposure(autoExposure.node);
  const grainStrength = uniform(num('grain') ?? 0.015);
  const grainState = { enabled: params.get('grain') !== '0' };
  const syncGrain = () => frameGraph.setGrain(grainState.enabled ? grainStrength : null);
  syncGrain();
  const exposureFolder = gui.addFolder('Exposure');
  exposureFolder.add(autoExposure.settings, 'auto').name('auto (meter)');
  exposureFolder.add(autoExposure.settings, 'manual', 0.05, 8, 0.01).name('manual');
  exposureFolder.add(autoExposure.settings, 'key', 0.05, 0.5, 0.01).name('middle grey');
  exposureFolder.add(autoExposure.settings, 'minEV', -6, 0, 0.1).name('min EV');
  exposureFolder.add(autoExposure.settings, 'maxEV', 0, 6, 0.1).name('max EV');
  exposureFolder.add(autoExposure.settings, 'speedUp', 0.1, 10, 0.1).name('speed up (1/s)');
  exposureFolder.add(autoExposure.settings, 'speedDown', 0.1, 10, 0.1).name('speed down (1/s)');
  exposureFolder.add(grainState, 'enabled').name('film grain').onChange(syncGrain);
  exposureFolder.add(grainStrength, 'value', 0, 0.15, 0.005).name('grain strength');
  exposureFolder.close();
  // Motion blur (shared/render/motionBlur.ts): after the temporal resolve, before exposure.
  const motionBlurParam = params.get('motionBlur');
  const motionBlur = new MotionBlur({
    ...host.motionBlur,
    enabled: motionBlurParam === null ? (host.motionBlur?.enabled ?? DEFAULT_MOTION_BLUR.enabled) : motionBlurParam !== '0',
  });
  const shutterParam = num('shutter'); if (shutterParam !== null) motionBlur.settings.shutter = shutterParam;
  const integrationParam = num('integration'); if (integrationParam !== null) motionBlur.settings.integrationMs = integrationParam;
  const gazeParam = params.get('gaze') as MotionBlurGaze | null;
  if (gazeParam === 'centre' || gazeParam === 'camera') motionBlur.settings.gaze = gazeParam;
  const syncMotionBlur = () => frameGraph.setMotionBlur(motionBlur.enabled ? motionBlur : null);
  syncMotionBlur();
  const contactFolder = gui.addFolder('Contact occlusion');
  contactFolder.add(contact.settings, 'enabled').name('enabled').onChange((v: boolean) => { contact.setEnabled(v); syncContact(); });
  contactFolder.add(contact.settings, 'radius', 0.05, 2, 0.01).name('radius (m)');
  contactFolder.add(contact.settings, 'rays', 1, 8, 1).name('rays / frame');
  // Grid scale is boot-time only (`?contactScale=`): reallocating the buffers at
  // runtime left the frame in a broken, seconds-long state (2026-09-08, unexplained).
  contactFolder.add(contact.settings, 'historyWeight', 0, 0.97, 0.01).name('history');
  contactFolder.add(contact.settings, 'intensity', 0, 1, 0.01).name('strength').onChange((v: number) => { contactIntensity.value = v; });
  contactFolder.close();
  const glareFolder = gui.addFolder('Post');
  const aaParams = { mode: frameGraph.antialiasingMode };
  glareFolder.add(aaParams, 'mode', ['taa', 'fxaa', 'none']).name('anti-aliasing').onChange((m: Antialiasing) => frameGraph.setAntialiasing(m));
  glareFolder.add(frameGraph.taa.historyWeight, 'value', 0, 0.97, 0.01).name('taa history');
  const taaUnjitter = num('taaUnjitter'); if (taaUnjitter !== null) frameGraph.taa.unjitterSign.value = taaUnjitter;
  const taaClip = num('taaClip'); if (taaClip !== null) frameGraph.taa.clipGamma.value = taaClip;
  const taaCopy = num('taaCopy'); if (taaCopy !== null) frameGraph.taa.copyMode = taaCopy;
  const taaHistory = num('taaHistory'); if (taaHistory !== null) frameGraph.taa.historyWeight.value = taaHistory;
  glareFolder.add(frameGraph.taa.clipGamma, 'value', 0.5, 2, 0.05).name('taa clip gamma');
  glareFolder.add(glare, 'enabled').name('veiling glare').onChange(syncGlare);
  glareFolder.add(glare, 'strength', 0, 0.5, 0.005).name('glare strength').onChange(syncGlare);
  glareFolder.add(glare, 'radius', 0, 1, 0.01).name('glare radius').onChange(syncGlare);
  glareFolder.add(motionBlur.settings, 'enabled').name('motion blur').onChange(syncMotionBlur);
  glareFolder.add(motionBlur.settings, 'gaze', ['centre', 'camera']).name('blur relative to');
  glareFolder.add(motionBlur.settings, 'integrationMs', 5, 100, 1).name('eye integration (ms)');
  glareFolder.add(motionBlur.settings, 'pursuitGain', 0, 1, 0.01).name('pursuit gain');
  glareFolder.add(motionBlur.settings, 'pursuitLagMs', 20, 400, 5).name('pursuit lag (ms)');
  glareFolder.add(motionBlur.settings, 'shutter', 0, 1, 0.01).name('camera shutter');
  glareFolder.add(motionBlur.settings, 'samples', 4, 24, 1).name('blur samples');
  glareFolder.add(motionBlur.settings, 'depthExtent', 0.01, 1, 0.01).name('blur depth extent (m)');
  glareFolder.close();
  const bakeFolder = gui.addFolder('GI bake');
  // Both budgets are always present: the mode is a runtime switch now, so hiding the
  // other one only means the value it would use is invisible when it gets used.
  bakeFolder.add(bakeParams, 'passes', 8, 256, 1).name('lightmap passes');
  bakeFolder.add(bakeParams, 'seconds', 1, 30, 0.5).name('surfel budget s');
  const frozenCtrl = bakeFolder
    .add(bakeParams, 'frozen')
    .name('frozen')
    .onChange((v: boolean) => {
      gi.setFrozen(v);
      refreshFrozenControl();
    })
    .listen?.();
  refreshFrozenControl = () => {
    // One switch that means one thing everywhere: stop the live chain. The atlas is
    // frozen by construction — it is a texture — so this only ever concerns dynamics.
    bakeParams.frozen = gi.frozen;
    frozenCtrl?.name('freeze live GI');
    frozenCtrl?.updateDisplay();
  };
  refreshFrozenControl();
  bakeFolder
    .add(
      {
        // The sun is the one thing that invalidates a bake, and the GUI can move it.
        // Re-baking means whatever the *current* mode needs -- more integration
        // passes into the atlas, or another warm-up of the runtime cache.
        rebake: () => { void bakeStatic(true).catch(showError); },
      },
      'rebake',
    )
    .name('re-bake now');
  giFolder
    .add(giParams, 'envIntensity', 0, 5, 0.05)
    .name('env')
    .onChange(() => gi.setEnvControls(giParams.envIntensity, giParams.envLod));
  giFolder
    .add(giParams, 'envLod', 0, 10, 0.25)
    .name('env LOD')
    .onChange(() => gi.setEnvControls(giParams.envIntensity, giParams.envLod));
  giFolder
    .add(giParams, 'fromDirect', 0, 4, 0.05)
    .name('bounce 1')
    .onChange(() => gi.setGiScales(giParams.fromDirect, giParams.fromIndirect));
  giFolder
    .add(giParams, 'fromIndirect', 0, 4, 0.05)
    .name('bounce n')
    .onChange(() => gi.setGiScales(giParams.fromDirect, giParams.fromIndirect));
  giFolder
    .add(giParams, 'albedoBoost', 1, 4, 0.05)
    .name('albedo boost')
    .onChange((v: number) => gi.setAlbedoBoost(v));

  // Freeze time-of-day by default: the sun is derived from the env map, and moving it
  // would put the analytic light out of step with the image-based ambient.
  lightCfg.animate = params.get('animate') === '1';
  let still = params.get('still') === '1';

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    frameGraph.setSize(window.innerWidth, window.innerHeight);
    gi.resize(renderer);
  });

  // Mirrors the probe added to the vendored webgiya build, so the two runtimes can be
  // diffed as numbers rather than as impressions.
  (window as unknown as Record<string, unknown>).__probe = () => ({
    sunPos: sun.position.toArray(),
    sunIntensity: sun.intensity,
    sunTarget: sun.target.position.toArray(),
    shadow: {
      mapSize: [sun.shadow.mapSize.width, sun.shadow.mapSize.height],
      bias: sun.shadow.bias,
      cam: [
        sun.shadow.camera.left,
        sun.shadow.camera.right,
        sun.shadow.camera.top,
        sun.shadow.camera.bottom,
        sun.shadow.camera.near,
        sun.shadow.camera.far,
      ],
    },
    camera: camera.position.toArray(),
    target: controls.target.toArray(),
    fov: camera.fov,
    toneMapping: renderer.toneMapping,
    exposure: renderer.toneMappingExposure,
    lightCfg: { ...lightCfg },
    gi: { ...giParams },
    // What the ray tracer thinks the lights are, as opposed to what the scene graph
    // holds. The two disagreeing silently is exactly the failure this list exists to
    // make visible: a light past MAX_GI_LIGHTS still rasters and stops bouncing.
    giLights: giLightSummary(),
  });

  // Puts the camera somewhere exactly, which driving OrbitControls with synthetic
  // mouse events cannot: a wheel-and-drag path lands a slightly different distance
  // every run, and a close-up whose framing moves between runs cannot measure a
  // contact gradient of a few units per 255. Same shape as __freeze — a hook that
  // exists so a measurement is repeatable.
  (window as unknown as Record<string, unknown>).__camera = (
    px: number,
    py: number,
    pz: number,
    tx: number,
    ty: number,
    tz: number,
  ) => {
    camera.position.set(px, py, pz);
    controls.target.set(tx, ty, tz);
    controls.update();
    camera.updateMatrixWorld();
    return true;
  };

  // Reads the surfel buffer back off the GPU: the only way to tell a real cache
  // from a per-frame rebuild without guessing.
  (window as unknown as Record<string, unknown>).__surfels = () =>
    gi.readSurfelStats(renderer);

  // GPU time for the last resolved render/compute pass, in ms. Only meaningful with
  // `?gputime=1` — without it the renderer never enabled timestamp queries and this
  // resolves to `undefined` for both, which is the honest answer to "how expensive is
  // this frame" when nobody asked the GPU to time itself.
  // Per-pass GPU/CPU ms from three's RendererInspector, which records every render
  // and compute of every frame with its timestamp query. `frames` animation frames
  // are collected and the median per pass is returned, largest GPU first, with the
  // median frame interval and the median summed GPU time. Audit only.
  (window as unknown as Record<string, unknown>).__gpuPasses = async (frames = 60) => {
    type Stats = { name: string; gpu: number; cpu: number; renderTarget?: { width: number; height: number; texture?: { name: string }; textures?: { name: string }[] }; isComputeStats?: boolean };
    type Frame = { frameId: number; deltaTime: number; resolvedRender: boolean; resolvedCompute: boolean; renders: Stats[]; computes: Stats[] };
    const inspector = renderer.inspector as unknown as { frames: Frame[]; resolveTimestamp(): Promise<void> };
    const firstFrame = inspector.frames.length ? inspector.frames[inspector.frames.length - 1].frameId + 1 : 0;
    for (let i = 0; i < frames; i++) { await new Promise((r) => requestAnimationFrame(r)); await inspector.resolveTimestamp(); }
    await inspector.resolveTimestamp();
    const label = (s: Stats) => {
      if (s.isComputeStats) return `compute ${s.name || '(unnamed)'}`;
      const rt = s.renderTarget;
      if (!rt) return `${s.name} → screen`;
      const tex = rt.texture?.name || rt.textures?.[0]?.name;
      return `${s.name} → ${tex || 'rt'} ${rt.width}x${rt.height}`;
    };
    const per = new Map<string, { gpu: number[]; cpu: number[]; count: number[] }>();
    const intervals: number[] = [];
    const totals: number[] = [];
    let used = 0;
    for (const f of inspector.frames) {
      if (f.frameId < firstFrame || !f.resolvedRender || !f.resolvedCompute) continue;
      used++;
      intervals.push(f.deltaTime);
      const byLabel = new Map<string, { gpu: number; cpu: number; count: number }>();
      let total = 0;
      for (const s of [...f.renders, ...f.computes]) {
        const key = label(s);
        const e = byLabel.get(key) ?? { gpu: 0, cpu: 0, count: 0 };
        e.gpu += s.gpu; e.cpu += s.cpu; e.count++; byLabel.set(key, e);
        total += s.gpu;
      }
      totals.push(total);
      for (const [key, e] of byLabel) {
        const acc = per.get(key) ?? { gpu: [], cpu: [], count: [] };
        acc.gpu.push(e.gpu); acc.cpu.push(e.cpu); acc.count.push(e.count); per.set(key, acc);
      }
    }
    const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const passes = [...per].map(([name, a]) => ({ name, gpu: median(a.gpu), cpu: median(a.cpu), perFrame: median(a.count), frames: a.gpu.length }))
      .sort((x, y) => y.gpu - x.gpu);
    return { framesUsed: used, frameMs: median(intervals), gpuMs: median(totals), passes };
  };
  (window as unknown as Record<string, unknown>).__gpuTime = async () => ({
    render: await renderer.resolveTimestampsAsync('render'),
    compute: await renderer.resolveTimestampsAsync('compute'),
    // Whether *this* frame submitted any compute work — `.calls` is a lifetime total
    // that never resets, so it stays > 0 forever after the bake's own compute passes.
    // `.frameCalls` is cleared at the top of every rAF and is what actually answers
    // "did this frame do compute", which a stale timestamp from the bake would
    // otherwise misreport as a live per-frame cost.
    computeCalls: renderer.info.compute.frameCalls,
  });

  // Pins the sphere to a fixed pose so a diff against webgiya measures the renderer
  // rather than two animation clocks that were never in step.
  let frozen = false;
  // Fog audit: toggle at runtime (the same path the GUI checkbox takes), read or set
  // the knobs, and report the froxel grid — so a check can prove "off" is the old frame.
  (window as unknown as Record<string, unknown>).__fog = {
    enabled(value?: boolean) {
      if (typeof value === 'boolean') { fog.setEnabled(value); syncFog(); }
      return fog.enabled;
    },
    settings: fog.settings,
    grid: [fog.width, fog.height, fog.depth],
    invalidate: () => fog.invalidateHistory(),
    glare(value?: boolean) {
      if (typeof value === 'boolean') { glare.enabled = value; syncGlare(); }
      return glare.enabled;
    },
    split(view: SplitView, at = 0.5) {
      frameGraph.splitPosition = at;
      frameGraph.setSplitView(view);
      frameGraph.forceRebuild();
    },
    contact(value?: boolean) {
      if (typeof value === 'boolean') { contact.setEnabled(value); syncContact(); }
      return contact.enabled;
    },
    contactSettings: contact.settings,
    reflections(value?: boolean) {
      if (typeof value === 'boolean') { reflections.setEnabled(value); syncReflections(); }
      return reflections.enabled;
    },
    reflectionSettings: reflections.settings,
    exposureSettings: autoExposure.settings,
    exposure: () => autoExposure.read(),
    // Frame-synced readback of the TAA output for stability checks.
    taaFrame: () => readFloatTexture(renderer, frameGraph.taa.resolvedTexture),
    taaState: () => frameGraph.taa.state,
    velocityFrame: () => readFloatTexture(renderer, frameGraph.scenePass.getTexture('velocity')),
    sceneFrame: () => readFloatTexture(renderer, frameGraph.scenePass.getTexture('output')),
    taaInputFrame: () => readFloatTexture(renderer, frameGraph.taa.inputTexture!),
    grain(value?: boolean) {
      if (typeof value === 'boolean') { grainState.enabled = value; syncGrain(); }
      return grainState.enabled;
    },
    motionBlur(value?: boolean) {
      if (typeof value === 'boolean') { motionBlur.settings.enabled = value; syncMotionBlur(); }
      return motionBlur.enabled;
    },
    motionBlurSettings: motionBlur.settings,
    motionBlurGaze: () => motionBlur.readGaze(renderer),
    /** Holds or releases the scene's own animation (wind, water) at runtime. */
    still(value?: boolean) {
      if (typeof value === 'boolean') still = value;
      return still;
    },
    computeCalls: () => renderer.info.compute.frameCalls,
    /** The frame graph itself, for audits that instrument a pass (never production code). */
    frameGraph: () => frameGraph,
    memory: () => ({ ...renderer.info.memory }),
    aa(mode?: Antialiasing) {
      if (mode) { aaParams.mode = mode; frameGraph.setAntialiasing(mode); }
      return frameGraph.antialiasingMode;
    },
  };
  (window as unknown as Record<string, unknown>).__freeze = (t: number) => {
    dynamic?.update(t);
    frozen = true;
    return true;
  };
  const freezeAt = num('freezeAt');
  if (freezeAt !== null) {
    dynamic?.update(freezeAt);
    frozen = true;
  }

  let previous = performance.now();
  let firstFrame = true;
  let auditPaused = false;
  let auditStepOnce = false;
  let auditRecording = false;
  let auditIntervals: number[] = [];
  const originalStaticBvh = gi.getSceneBvh();
  let runtimeMoverSerial = 0;
  const runtimeMovers = new Map<string, THREE.Mesh>();
  let auditGiFrame = 10000;
  (window as unknown as Record<string, unknown>).__audit = {
    bakeCache: () => ({ ...bakeCache }),
    lighting: () => ({ baked, staticFrozen: baked, runtimeFrozen: gi.frozen }),
    bakedTransport: () => gi.bakedTransportStats,
    rayBudget(value: number) {
      if (!Number.isFinite(value)) throw new Error('Finite GI ray budget required');
      gi.runtimeRayBudget = Math.max(0, Math.min(65536, Math.floor(value)));
    },
    integrationSchedule() {
      if (!auditPaused) throw new Error('Pause before reading GI schedule');
      return gi.readIntegrationSchedule(renderer);
    },
    dynamicScene: () => ({ revision: gi.dynamicSceneRevision, movers: gi.getDynamicBvh()?.moverCount,
      triangles: gi.getDynamicBvh()?.triangleCount, enabled: gi.getDynamicBvh()?.enabled.value,
      hierarchy: gi.getDynamicBvh()?.hierarchyStats(),
      staticUnchanged: gi.getSceneBvh() === originalStaticBvh, materialCount: gi.getSceneBvh()?.materialIdByUUID.size }),
    spawnMovers(count: number) {
      const names: string[] = [];
      for (let i = 0; i < count; i++) {
        const material = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color().setHSL((runtimeMoverSerial * .173) % 1, .8, .5), roughness: .55 });
        const mesh = new THREE.Mesh(i % 2 ? new THREE.BoxGeometry(.38, .38, .38) : new THREE.SphereGeometry(.22, 16, 12), material);
        mesh.name = `runtime-mover-${++runtimeMoverSerial}`;
        mesh.position.set((i % 4 - 1.5) * 1.2, 2.7 + Math.floor(i / 4) * .85, 2.8);
        applyMobility(mesh, Mobility.Movable); scene.add(mesh); runtimeMovers.set(mesh.name, mesh); names.push(mesh.name);
      }
      gi.syncDynamicScene(renderer, scene); return names;
    },
    removeMovers(names: string[]) {
      const removed: THREE.Mesh[] = [];
      scene.traverse(object => { const mesh = object as THREE.Mesh;
        if (mesh.isMesh && mesh.userData.mobility === Mobility.Movable && (names.includes(mesh.name) || names.includes('*'))) removed.push(mesh);
      });
      for (const mesh of removed) { mesh.removeFromParent(); runtimeMovers.delete(mesh.name); }
      gi.syncDynamicScene(renderer, scene);
      for (const mesh of removed) { mesh.geometry.dispose(); for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose(); }
    },
    moveRuntimeMovers() {
      for (const [i, mesh] of [...runtimeMovers.values()].entries()) { mesh.position.x += .13; mesh.position.z -= .3; mesh.rotation.set(.2, .4 + i * .1, 0); }
    },
    detachMover(name: string) {
      const mesh = runtimeMovers.get(name);
      if (!mesh || mesh.parent !== scene) throw new Error('Expected an attached runtime mover');
      mesh.removeFromParent(); gi.syncDynamicScene(renderer, scene); return mesh.uuid;
    },
    reinsertMover(name: string) {
      const mesh = runtimeMovers.get(name);
      if (!mesh || mesh.parent) throw new Error('Expected a detached runtime mover');
      scene.add(mesh); gi.syncDynamicScene(renderer, scene); return mesh.uuid;
    },
    async rigidSurfels() {
      if (!auditPaused) throw new Error('Pause before reading rigid surfel state');
      return gi.readRigidSurfelState(renderer);
    },
    async giReceivers() {
      if (!auditPaused) throw new Error('Pause before reading GI receivers');
      return readValidationTexture(renderer, gi.receiverTexture);
    },
    async coverageDebug() {
      if (!auditPaused) throw new Error('Pause before reading coverage state');
      return gi.readCoverageDebug(renderer);
    },
    coveragePixel(x: number, y: number) { gi.setCoverageDebugPixel(x, y); },
    recheckCoverage(rebuild: boolean | 'replay' = false) {
      if (!auditPaused) throw new Error('Pause before rechecking coverage');
      gi.recheckCoverage(renderer, camera, rebuild);
    },
    expireReceiver(owner: number) {
      if (!auditPaused) throw new Error('Pause before expiring receiver samples');
      return gi.expireRigidReceiver(renderer, owner);
    },
    stepGI(count: number) {
      if (!auditPaused || switching || !baked) throw new Error('Pause a ready baked scene before stepping GI');
      const previousFrame = renderer.info.frame;
      try {
        for (let i = 0; i < Math.min(200, Math.max(1, Math.floor(count))); i++) {
          // PassNode caches by NodeFrame.frameId, not renderer.info.frame. Explicit
          // audit steps must advance both or beauty keeps the first step's image.
          (renderer as any)._nodes.nodeFrame.update();
          renderer.info.frame = auditGiFrame++;
          gi.updateDynamicScene(); gi.update(renderer, scene, camera);
          frameGraph.setGiTextures(gi.outputTexture, gi.albedoTexture); frameGraph.render();
        }
      } finally { renderer.info.frame = previousFrame; }
      return auditGiFrame;
    },
    async bakedPixels() {
      if (!auditPaused || !lightmapTexture) throw new Error('Pause a baked scene before lightmap readback');
      return readValidationTexture(renderer, lightmapTexture);
    },
    realtimeContribution(value: number) { frameGraph.indirectIntensity.value = value; },
    shadowContribution(value: number) { sun.shadow.intensity = Math.max(0, Math.min(1, value)); },
    giLeafTransmit(enabled: boolean) { gi.setLeafTransmit(enabled); },
    sun(azimuthDeg: number, elevationDeg: number, intensity?: number) {
      lightCfg.azimuthDeg = azimuthDeg; lightCfg.elevationDeg = elevationDeg;
      if (typeof intensity === 'number') lightCfg.intensity = intensity;
      updateLightFromAngles();
      return [lightCfg.azimuthDeg, lightCfg.elevationDeg, lightCfg.intensity];
    },
    hideOverlay() { (renderer.inspector as unknown as { domElement: HTMLElement }).domElement.style.display = 'none'; },
    pause(value = true) { auditPaused = value; previous = performance.now(); },
    /** Renders exactly one frame while paused, so a check can re-render a held pose with a setting changed. */
    stepFrame() { if (!auditPaused) throw new Error('Pause before stepping a frame'); auditStepOnce = true; },
    measure() { auditIntervals = []; auditRecording = true; },
    stopMeasure() { auditRecording = false; return auditIntervals.slice(); },
    async read() {
      if (!auditPaused) throw new Error('Pause the renderer before coherent buffer readback');
      return {
        base: await readValidationTexture(renderer, frameGraph.scenePass.getTexture('output')),
        normal: await readValidationTexture(renderer, frameGraph.scenePass.getTexture('normal')),
        gi: gi.outputTexture ? await readValidationTexture(renderer, gi.outputTexture) : null,
        albedo: gi.outputTexture ? await readValidationTexture(renderer, gi.albedoTexture) : null,
        receivers: await readValidationTexture(renderer, frameGraph.scenePass.getTexture('albedo')),
        composite: { giMode: frameGraph.giMode, indirectIntensity: frameGraph.indirectIntensity.value, hybridReceivers: frameGraph.hybridReceivers.value },
      };
    },
  };

  renderer.setAnimationLoop(() => {
    if (fatal || (auditPaused && !auditStepOnce)) return;
    auditStepOnce = false;

    const now = performance.now();
    const dt = (now - previous) / 1000;
    previous = now;
    if (auditRecording && auditIntervals.length < 100000) auditIntervals.push(dt * 1000);

    world.beginFrame(dt);
    controls.update();
    updateAnimation();
    camera.updateMatrixWorld();
    frameGraph.beginFrame();
    if (!frozen) dynamic?.update(now * 0.001);
    // `?still=1` holds the scene's own animation (wind, water) so a check can compare
    // two frames of one session without motion between them.
    if (!still) host.update?.(now * 0.001);
    fog.update(now);
    // Hybrid retains the atlas for static receivers and runs the existing surfel
    // chain for unbaked receivers. Skip during an asynchronous pool rebuild.
    if (!switching) {
      // Immediately after the sphere moved and before anything traces: the dynamic BVH
      // is what makes it visible to a ray at all. It self-gates on the world matrix, so
      // a still scene pays a matrix compare and nothing else.
      gi.updateDynamicScene();
      gi.update(renderer, scene, camera);
      frameGraph.setGiTextures(gi.outputTexture, gi.albedoTexture);
      // Same G-buffer, same jittered camera, this frame: trace the contact rays now.
      contact.update(contactTree(), gi.dynamicBvhBundle, gi.gbufferDepthTexture, gi.receiverTexture,
        renderer.domElement.width, renderer.domElement.height, true);
      syncContact();
      // Reflections read last frame's resolved colour: the TAA history. Without TAA the
      // pass still runs, against whatever the history holds (stale after a switch).
      if (reflections.enabled && !contactBvh && gi.staticBvh) contactBvh = createContactBVH(scene, gi.staticBvh.materialIdByUUID);
      reflections.update(contactBvh, gi.dynamicBvhBundle, gi.diffuseArrayTexture, gi.gbufferDepthTexture, gi.receiverTexture,
        gi.specularTexture, frameGraph.taa.historyTexture, renderer.domElement.width, renderer.domElement.height, 1);
      syncReflections();
    }

    // The sky lights every host; whether it is also the picture behind the scene is
    // the host's call (a diorama sits in front of its own backdrop).
    scene.background = host.skyIsBackground ? gi.envTexture : null;
    // Meter last frame's resolved HDR (the TAA history) so the composite of this
    // frame already carries the adapted exposure; nothing is read back.
    autoExposure.update(frameGraph.taa.historyTexture, renderer.domElement.width, renderer.domElement.height, dt);
    frameGraph.render();
    frameGraph.endFrame();

    stats.endFrame(world.dt);
    hud?.update(world.dt);

    if (firstFrame) {
      firstFrame = false;
      clearLoading();
    }
  });
}
