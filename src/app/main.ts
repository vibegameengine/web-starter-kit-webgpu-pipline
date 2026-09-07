import * as THREE from 'three/webgpu';
import GUI from 'lil-gui';

import { FrameGraph, GiMode, SplitView, initRenderer } from '../shared/render/index.ts';
import { CacheStats, WorldState } from '../shared/world/index.ts';
import { Hud } from '../shared/ui/hud.ts';
import { SurfelGI } from '../shared/gi/index.ts';
import {
  applyLightmap,
  assignLightmapUvs,
  measureCoverage,
  rasteriseLightmapGBuffer,
} from '../shared/gi/bake/index.ts';
import { uniform } from 'three/tsl';
import { readFloatTexture, readValidationTexture } from '../shared/render/gpuReadback.ts';
import { createLightmapPages, type LightmapPageSource } from '../shared/render/virtualTexture/lightmapPages.ts';
import { VirtualLightmap } from '../shared/render/virtualTexture/virtualLightmap.ts';
import { createLightmapDemand } from '../shared/render/virtualTexture/lightmapDemand.ts';
import { bakeKey, loadBake, saveBake } from '../shared/gi/bake/persistedBake.ts';
import { loadStreamedBake } from '../shared/gi/bake/streamedBake.ts';
import { giKnobs } from '../shared/gi/surfel/knobs.ts';
import {
  createLightControls,
  findSunPositionWeighted,
  setLightAngles,
  setLightAnglesFromEnvMapSunUVLocation,
} from '../shared/gi/surfel/lighting.ts';
import { applyOcclusionSettings } from '../shared/gi/surfel/surfelRadialDepth.ts';
import { MAX_TEMPORAL_M } from '../shared/gi/surfel/constants.ts';
import { U_GI_MEDIUM, giLightSummary } from '../shared/gi/surfel/sceneLights.ts';
import {
  addDynamicSphere,
  createBeachScene,
  createCornellScene,
  populateCornell,
} from '../widgets/world/index.ts';

const loadingOverlay = document.querySelector<HTMLElement>('#loading-overlay');
const loadingMessage = document.querySelector<HTMLElement>('#loading-message');
const errorOverlay = document.querySelector<HTMLElement>('#error-overlay');
const errorMessage = document.querySelector<HTMLElement>('#error-message');

let fatal = false;

function setLoading(message: string): void {
  if (loadingMessage) loadingMessage.textContent = message;
  loadingOverlay?.classList.remove('hidden');
  if (loadingOverlay) loadingOverlay.hidden = false;
}

function clearLoading(): void {
  loadingOverlay?.classList.add('hidden');
  if (loadingOverlay) loadingOverlay.hidden = true;
}

function showError(error: unknown): void {
  if (fatal) return;
  fatal = true;
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(text);
  if (errorMessage) errorMessage.textContent = text;
  errorOverlay?.classList.remove('hidden');
  if (errorOverlay) errorOverlay.hidden = false;
  clearLoading();
}

window.addEventListener('error', (event) => showError(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => showError(event.reason));

async function boot(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const num = (key: string): number | null => {
    const raw = params.get(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  // `?hud=0` strips the overlays so a capture can be diffed against webgiya's
  // output pixel for pixel without chrome getting in the way.
  const showChrome = params.get('hud') !== '0';

  setLoading('Initializing WebGPU');
  const { renderer } = await initRenderer();

  const gui = new GUI({ title: 'Elderwood' });
  if (!showChrome) {
    gui.hide();
    // The Inspector's fps widget is chrome too; a judged frame must not carry it.
    (renderer.inspector as unknown as { domElement?: HTMLElement }).domElement?.style.setProperty('display', 'none');
  }

  setLoading('Loading GI assets');
  const gi = await SurfelGI.create(renderer);
  gi.liveCoverage = params.get('liveCoverage') !== 'legacy';

  setLoading('Building scene');
  const world = new WorldState();
  const stats = new CacheStats();
  // `?scene=beach` is the diorama lab (concepts/beach.png); the Cornell box stays the
  // reference frame every earlier measurement was taken against.
  const sceneName = params.get('scene') === 'beach' ? 'beach' : 'cornell';
  const beach = sceneName === 'beach' ? await createBeachScene(renderer, gi.envTexture) : null;
  const { scene, camera, controls, sun } = beach ?? createCornellScene(renderer);
  gi.rigidSurfels = params.get('rigidSurfels') !== '0';

  // Sun direction comes from the brightest region of the environment map, not from
  // authored angles — that is what keeps the analytic sun and the image-based
  // ambient agreeing with each other. Same call webgiya makes on every scene load.
  const sunUv = findSunPositionWeighted(gi.envTexture);
  setLightAnglesFromEnvMapSunUVLocation(sunUv[0], sunUv[1]);

  const { updateAnimation, updateLightFromAngles, lightCfg } = createLightControls(
    gui,
    sun,
  );
  // `?sun=0` puts the sun out without removing it, which is the only way to show that
  // an emissive surface is a *light source* rather than a surface that happens to look
  // bright when something else is lighting it. Pair with `?env=0`; the sky is the other
  // thing in this frame that emits.
  const sunIntensity = num('sun');
  if (sunIntensity !== null) lightCfg.intensity = sunIntensity;
  else if (beach) lightCfg.intensity = 2.6;
  // The diorama is art-directed: `?sunAz=&sunEl=` override the env-derived angles.
  // The sky still lights and reflects from where it is; only the key light moves.
  const sunAz = num('sunAz') ?? (beach ? 28 : null);
  const sunEl = num('sunEl') ?? (beach ? 52 : null);
  if (sunAz !== null && sunEl !== null) setLightAngles(sunAz, sunEl);
  const exposure = num('exposure');
  if (exposure !== null) renderer.toneMappingExposure = exposure;
  else if (beach) renderer.toneMappingExposure = 1.15;
  applyOcclusionSettings({ shadowStrength: 0.5 });

  if (!beach) {
    setLoading('Building Cornell box');
    populateCornell(scene, sun);
  }

  // AFTER populate, deliberately: buildCornellScene ends by hard-coding
  // dirLight.position to (1,3,1), which throws away the env-derived sun and leaves
  // the analytic light disagreeing with the image-based ambient. Re-applying the
  // angles here is what puts this build's sun at (19.4, 32.0, 14.2) — the same place
  // webgiya's ends up.
  updateLightFromAngles();

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
  const requestedLightingMode = params.get('mode');
  gi.freezeCompletely = params.get('freezeAll') === '1';

  // Unconditionally, and before the BVH. Unconditionally because the mode is a
  // runtime switch and the unwrap cannot be redone later: it must be in the geometry
  // by the time the BVH merges it. Before the BVH because the unwrapper gives uv1 to
  // some meshes and not others, and the merge is what has to cope with that.
  setLoading('Unwrapping lightmap UVs');
  assignLightmapUvs(scene, {
    padding: num('pad') ?? 0.12,
    // The atlas edge is what turns cells into texels, so the density report is
    // meaningless without it. It is only used for reporting and refusal — the layout
    // itself is resolution-independent.
    atlasSize: lightmapSize,
  });

  // Before the BVH, deliberately: being in the scene at build time is what gets the
  // sphere's material an id in the shared diffuse array, without which a ray that hits
  // it cannot be shaded. `?mover=0` leaves it out entirely.
  // The beach has no mover in its reference; `?mover=1` puts the sphere in anyway.
  const wantMover = beach ? params.get('mover') === '1' : params.get('mover') !== '0';
  const dynamic = wantMover
    ? addDynamicSphere(scene, { radius: num('moverRadius') ?? undefined })
    : null;

  setLoading('Building static BVH');
  gi.buildScene(renderer, scene);
  gi.setDynamicTracing(params.get('dyntrace') !== '0');

  // Applied here, not with the rest of the GUI defaults further down: the bake runs
  // before those exist, and a knob that only takes effect after the cache has converged
  // is a knob that does nothing.
  // The diorama sits under an open sky: a stronger skylight is what keeps the shaded
  // side of a boulder pale rather than black.
  const envIntensityParam = num('env') ?? (beach ? 1.6 : 1);
  gi.setEnvControls(envIntensityParam, 4);

  const lightmapIntensity = uniform(0);
  // Read by the mode switch, written by the GUI slider: a plain const here meant the
  // slider's value was silently discarded on every switch.
  const lightmapParams = { intensity: num('lmi') ?? 1 };
  let lightmapTexture: THREE.Texture | null = null;
  let lightmapGBuffer: ReturnType<typeof rasteriseLightmapGBuffer> | null = null;
  let lightmapCoverage = 0;
  let virtualLightmap: VirtualLightmap | null = null;
  let lightmapDemand: ReturnType<typeof createLightmapDemand> | null = null;
  let nextPageDemandAt = 0;
  let pausePageStreaming = false;
  let bakedSunVersion = -1;
  let baked = false;
  const bakeCache = { source: 'none', storage: 'none', key: '', saved: false, error: '' };
  // The water medium the tracer attenuates sunlight through is bakeable state too,
  // and so are the art-directed sun angles.
  const bakeMedium = () => (U_GI_MEDIUM.value as THREE.Vector4).toArray();
  let readBakeControls = () => ({ envIntensity: envIntensityParam, envLod: 4, fromDirect: 1, fromIndirect: 1, albedoBoost: 1, medium: bakeMedium(), sun: [lightCfg.azimuthDeg, lightCfg.elevationDeg, lightCfg.intensity] });

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
  });

  /**
   * `surfel` resolves the cache on screen every frame; `lightmap` samples a texture
   * and does no GI work at all.
   *
   * These are not two views of one state, they are two consumers of the *same* surfel
   * pool, and the bake spends the whole pool on atlas texels. So a switch is not a
   * toggle — each direction has to re-prepare the pool for its own occupant, which is
   * why this is async and shows the loading overlay rather than flipping instantly.
   */
  type LightingMode = 'surfel' | 'lightmap' | 'hybrid';
  let lightingMode: LightingMode = requestedLightingMode === 'lightmap' || requestedLightingMode === 'surfel' ? requestedLightingMode : 'hybrid';

  async function prepareLightmap(iterations: number, forceBake = false): Promise<void> {
    const persistent = lightingMode === 'hybrid' && params.get('bakeCache') !== '0';
    let key = '';
    bakeCache.source = 'none'; bakeCache.storage = 'none'; bakeCache.saved = false; bakeCache.error = '';
    if (persistent) {
      setLoading('Checking saved static lighting');
      try {
        key = await bakeKey(scene, gi.envTexture, gi.bakeNoiseTexture, {
          size: lightmapSize, iterations, rays: lightmapRays, controls: readBakeControls(),
          knobs: Object.fromEntries(Object.entries(giKnobs).map(([name, read]) => [name, read()])),
          viewpoint: params.get('bakecam') === 'view' ? camera.position.toArray() : null,
        });
        bakeCache.key = key;
        if (!forceBake && params.get('vt') !== '0') {
          const streamed = await loadStreamedBake(key);
          if (streamed) {
            gi.restoreStaticBake(renderer, streamed.surfels);
            publishPages(streamed.pages);
            bakeCache.source = 'saved'; bakeCache.storage = 'streamed'; bakeCache.saved = true;
            console.log(`[bake-cache] restored ${key}; lightmap pages load on demand`);
            return;
          }
        }
        const saved = forceBake ? null : await loadBake(key);
        if (saved) {
          setLoading('Restoring saved static lighting');
          gi.restoreStaticBake(renderer, saved.surfels);
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
        dynamicReceivers: lightingMode === 'hybrid',
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
    await publishLightmap(result.texture, pixels);
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

  async function publishLightmap(texture: THREE.Texture, pixels: Float32Array): Promise<void> {
    if (params.get('vt') !== '0' && lightingMode === 'hybrid') {
      setLoading('Preparing virtual lightmap pages');
      const pageSize = Math.min(128, lightmapSize / 2);
      publishPages(createLightmapPages(pixels, lightmapSize, pageSize, pageSize));
    } else {
      const previousVirtual = virtualLightmap;
      virtualLightmap = null; lightmapDemand = null;
      lightmapTexture = texture;
      applyLightmap(scene, lightmapTexture, lightmapIntensity);
      frameGraph.setLightmapTexture(lightmapTexture);
      previousVirtual?.dispose();
    }
  }

  function publishPages(pages: LightmapPageSource): void {
    const previousVirtual = virtualLightmap;
    virtualLightmap = new VirtualLightmap(renderer, pages, num('vtSlots') ?? 8);
    lightmapDemand = createLightmapDemand(scene, pages);
    applyLightmap(scene, virtualLightmap.fallback, lightmapIntensity, virtualLightmap);
    lightmapTexture = virtualLightmap.fallback;
    nextPageDemandAt = 0;
    frameGraph.setLightmapTexture(lightmapTexture);
    previousVirtual?.dispose();
  }

  async function prepareSurfel(durationMs: number): Promise<void> {
    gi.resetCache(renderer);
    if (durationMs <= 0) return;
    setLoading(`Warming surfel cache (${(durationMs / 1000).toFixed(0)}s)`);
    await gi.bake(renderer, scene, {
      durationMs,
      onProgress: (fraction, frames) => {
        setLoading(`Warming ${(fraction * 100).toFixed(0)}% · ${frames} views`);
      },
    });
  }

  let switching = false;
  /** Set by the GUI so a failed or refused switch can put the control back. */
  let onModeSettled: ((mode: LightingMode) => void) | null = null;

  async function setLightingMode(next: LightingMode, forceBake = false): Promise<void> {
    // Refusing silently would leave the dropdown showing a mode the app is not in,
    // and every later action would target the wrong one. Refuse loudly instead.
    if (switching) {
      console.warn('[lighting] switch ignored: a bake is already running');
      onModeSettled?.(lightingMode);
      return;
    }

    const previous = lightingMode;
    switching = true;
    baked = false;
    try {
      lightingMode = next;
      frameGraph.hybridReceivers.value = next === 'hybrid' ? 1 : 0;
      if (next !== 'surfel') {
        // The composite still holds the last resolve output; without dropping it the
        // scene would be lit by a frozen screen-space GI texture *and* the lightmap.
        frameGraph.setGiTextures(null, null);
        await prepareLightmap(bakeParams.passes, forceBake);
        lightmapIntensity.value = lightmapParams.intensity;
        // Hybrid pins the baked entries while webgiya continues spawning and
        // integrating live surfels for objects without a baked chart.
        gi.setFrozen(next === 'lightmap');
      } else {
        lightmapIntensity.value = 0;
        await prepareSurfel(bakeParams.seconds * 1000);
      }
      bakedSunVersion = world.sunVersion;
      baked = true;
    } catch (error) {
      // A half-applied mode is worse than the old one: the scene would render with
      // neither GI chain running and nothing on screen would say so.
      lightingMode = previous;
      lightmapIntensity.value = previous !== 'surfel' ? lightmapParams.intensity : 0;
      frameGraph.hybridReceivers.value = previous === 'hybrid' ? 1 : 0;
      throw error;
    } finally {
      switching = false;
      onModeSettled?.(lightingMode);
      clearLoading();
    }
  }

  const hud = showChrome
    ? new Hud(world, stats, () =>
        !baked
          ? 'converging'
          : lightingMode !== 'surfel'
            ? // The sun is bakeable state. Moving it does not invalidate anything
              // automatically -- re-baking on every slider tick would be unusable --
              // so the only honest thing is to say the texture is now out of date.
              world.sunVersion !== bakedSunVersion
              ? `lightmap ${lightmapSize}px · STALE (sun moved, re-bake)`
              : `lightmap ${lightmapSize}px · static frozen${lightingMode === 'hybrid' ? ' · dynamics live' : ''}`
            : gi.frozen
              ? 'surfel · fully frozen'
              : 'surfel · movers live',
      )
    : null;

  await setLightingMode(lightingMode);

  const giParams = {
    mode: frameGraph.giMode,
    indirectIntensity: frameGraph.indirectIntensity.value,
    baseSamples: 4,
    envIntensity: envIntensityParam,
    envLod: 4,
    fromDirect: 1,
    fromIndirect: 1,
    albedoBoost: 1,
  };
  readBakeControls = () => ({ envIntensity: giParams.envIntensity, envLod: giParams.envLod, fromDirect: giParams.fromDirect, fromIndirect: giParams.fromIndirect, albedoBoost: giParams.albedoBoost, medium: bakeMedium(), sun: [lightCfg.azimuthDeg, lightCfg.elevationDeg, lightCfg.intensity] });
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
  const modeParams = { mode: lightingMode as LightingMode };
  const modeCtrl = modeFolder
    .add(modeParams, 'mode', ['surfel', 'lightmap', 'hybrid'])
    .name('mode')
    .onChange((v: LightingMode) => void setLightingMode(v).catch(showError));
  const intensityCtrl = modeFolder
    .add(lightmapParams, 'intensity', 0, 8, 0.05)
    .name('lightmap mul')
    .onChange((v: number) => {
      if (lightingMode !== 'surfel') lightmapIntensity.value = v;
    });

  // The control is the app's state, so it has to follow the app rather than lead it.
  let refreshFrozenControl = () => {};
  onModeSettled = (mode) => {
    modeParams.mode = mode;
    modeCtrl.updateDisplay?.();
    if (mode !== 'surfel') intensityCtrl.enable?.();
    else intensityCtrl.disable?.();
    refreshFrozenControl();
  };
  onModeSettled(lightingMode);

  const bakeFolder = gui.addFolder('GI bake');
  // Both budgets are always present: the mode is a runtime switch now, so hiding the
  // other one only means the value it would use is invisible when it gets used.
  bakeFolder.add(bakeParams, 'passes', 8, 256, 1).name('lightmap passes');
  bakeFolder.add(bakeParams, 'seconds', 1, 30, 0.5).name('surfel budget s');
  const frozenCtrl = bakeFolder
    .add(bakeParams, 'frozen')
    .name('frozen')
    .onChange((v: boolean) => {
      if (lightingMode === 'surfel') gi.setFrozen(v);
      refreshFrozenControl();
    })
    .listen?.();
  refreshFrozenControl = () => {
    const staticBaked = lightingMode !== 'surfel';
    bakeParams.frozen = staticBaked || gi.frozen;
    frozenCtrl?.name(staticBaked ? 'static frozen' : 'freeze all GI');
    if (staticBaked) frozenCtrl?.disable();
    else frozenCtrl?.enable();
    frozenCtrl?.updateDisplay();
  };
  refreshFrozenControl();
  bakeFolder
    .add(
      {
        // The sun is the one thing that invalidates a bake, and the GUI can move it.
        // Re-baking means whatever the *current* mode needs -- more integration
        // passes into the atlas, or another warm-up of the runtime cache.
        rebake: () => {
          void setLightingMode(lightingMode, true).catch(showError);
        },
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
  let auditRecording = false;
  let auditIntervals: number[] = [];
  (window as unknown as Record<string, unknown>).__audit = {
    bakeCache: () => ({ ...bakeCache }),
    lighting: () => ({ mode: lightingMode, baked, staticFrozen: baked && lightingMode !== 'surfel', runtimeFrozen: gi.frozen }),
    async rigidSurfels() {
      if (!auditPaused) throw new Error('Pause before reading rigid surfel state');
      return gi.readRigidSurfelState(renderer);
    },
    async bakedPixels() {
      if (!auditPaused || !lightmapTexture) throw new Error('Pause a baked scene before lightmap readback');
      return readValidationTexture(renderer, lightmapTexture);
    },
    pages: () => virtualLightmap?.stats() ?? null,
    pageDetail(value: boolean) { if (virtualLightmap) virtualLightmap.enabled.value = value ? 1 : 0; },
    pageStreaming(value: boolean) { pausePageStreaming = !value; },
    clearPages() { virtualLightmap?.clear(); },
    realtimeContribution(value: number) { frameGraph.indirectIntensity.value = value; },
    hideOverlay() { (renderer.inspector as unknown as { domElement: HTMLElement }).domElement.style.display = 'none'; },
    pause(value = true) { auditPaused = value; previous = performance.now(); },
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
        composite: { mode: lightingMode, giMode: frameGraph.giMode, indirectIntensity: frameGraph.indirectIntensity.value, hybridReceivers: frameGraph.hybridReceivers.value },
      };
    },
  };

  renderer.setAnimationLoop(() => {
    if (fatal || auditPaused) return;

    const now = performance.now();
    const dt = (now - previous) / 1000;
    previous = now;
    if (auditRecording && auditIntervals.length < 100000) auditIntervals.push(dt * 1000);

    world.beginFrame(dt);
    controls.update();
    updateAnimation();
    camera.updateMatrixWorld();
    if (!frozen) dynamic?.update(now * 0.001);
    beach?.update(now * 0.001);
    if (!switching && lightingMode === 'hybrid' && virtualLightmap && lightmapDemand) {
      if (now >= nextPageDemandAt) {
        virtualLightmap.setDemand(lightmapDemand(camera, renderer.domElement.width, renderer.domElement.height));
        nextPageDemandAt = now + 150;
      }
      if (!pausePageStreaming) virtualLightmap.update(now);
    }

    // Hybrid retains the atlas for static receivers and runs the existing surfel
    // chain for unbaked receivers. Skip during an asynchronous pool rebuild.
    if (!switching && lightingMode !== 'lightmap') {
      // Immediately after the sphere moved and before anything traces: the dynamic BVH
      // is what makes it visible to a ray at all. It self-gates on the world matrix, so
      // a still scene pays a matrix compare and nothing else.
      gi.updateDynamicScene();
      gi.update(renderer, scene, camera);
      frameGraph.setGiTextures(gi.outputTexture, gi.albedoTexture);
    }

    // The diorama sits in front of its own backdrop; the sky is lighting only there.
    scene.background = beach ? null : gi.envTexture;
    frameGraph.render();

    stats.endFrame(world.dt);
    hud?.update(world.dt);

    if (firstFrame) {
      firstFrame = false;
      clearLoading();
    }
  });
}

boot().catch(showError);
