import GUI from 'lil-gui';

import { FrameGraph, GiMode, initRenderer } from '../shared/render/index.ts';
import { CacheStats, WorldState } from '../shared/world/index.ts';
import { Hud } from '../shared/ui/hud.ts';
import { SurfelGI } from '../shared/gi/index.ts';
import {
  createLightControls,
  findSunPositionWeighted,
  setLightAnglesFromEnvMapSunUVLocation,
} from '../shared/gi/surfel/lighting.ts';
import { applyOcclusionSettings } from '../shared/gi/surfel/surfelRadialDepth.ts';
import type { DynamicObject } from '../shared/gi/surfel/content.ts';
import {
  addDynamicSphere,
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
  if (!showChrome) gui.hide();

  setLoading('Building scene');
  const world = new WorldState();
  const stats = new CacheStats();
  const { scene, camera, controls, sun } = createCornellScene(renderer);

  setLoading('Loading GI assets');
  const gi = await SurfelGI.create(renderer);

  // Sun direction comes from the brightest region of the environment map, not from
  // authored angles — that is what keeps the analytic sun and the image-based
  // ambient agreeing with each other. Same call webgiya makes on every scene load.
  const sunUv = findSunPositionWeighted(gi.envTexture);
  setLightAnglesFromEnvMapSunUVLocation(sunUv[0], sunUv[1]);

  const { updateAnimation, updateLightFromAngles, lightCfg } = createLightControls(
    gui,
    sun,
  );
  applyOcclusionSettings({ shadowStrength: 0.5 });

  setLoading('Building Cornell box');
  populateCornell(scene, sun);

  // AFTER populate, deliberately: buildCornellScene ends by hard-coding
  // dirLight.position to (1,3,1), which throws away the env-derived sun and leaves
  // the analytic light disagreeing with the image-based ambient. Re-applying the
  // angles here is what puts this build's sun at (19.4, 32.0, 14.2) — the same place
  // webgiya's ends up.
  updateLightFromAngles();

  setLoading('Building static BVH');
  gi.buildScene(renderer, scene);

  // After the BVH: the mover is raster + shadows only, never part of the static world.
  const dynamic: DynamicObject = addDynamicSphere(scene);

  setLoading('Compiling frame graph');
  const frameGraph = new FrameGraph(renderer, scene, camera, {
    giMode: (params.get('giMode') as GiMode) ?? GiMode.Combined,
    indirectIntensity: num('gi') ?? 1,
  });

  const hud = showChrome ? new Hud(world, stats) : null;

  const giParams = {
    mode: frameGraph.giMode,
    indirectIntensity: frameGraph.indirectIntensity.value,
    baseSamples: 4,
    envIntensity: 1,
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
    .onChange((v: number) => gi.setBaseSampleCount(v));
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
  });

  let previous = performance.now();
  let firstFrame = true;

  renderer.setAnimationLoop(() => {
    if (fatal) return;

    const now = performance.now();
    const dt = (now - previous) / 1000;
    previous = now;

    world.beginFrame(dt);
    controls.update();
    updateAnimation();
    camera.updateMatrixWorld();
    dynamic.update(now * 0.001);

    gi.update(renderer, scene, camera, sun);
    frameGraph.setGiTextures(gi.outputTexture, gi.albedoTexture);

    scene.background = gi.envTexture;
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
