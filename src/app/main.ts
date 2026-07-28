import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';

import { FrameGraph, initRenderer } from '../shared/render/index.ts';
import { CacheStats, WorldState } from '../shared/world/index.ts';
import { IrradianceVolume, attachIrradiance, createSceneBvh } from '../shared/gi/index.ts';
import { Hud } from '../shared/ui/hud.ts';
import { TimeOfDay } from '../features/time-of-day/index.ts';
import { createCornerScene } from '../widgets/world/index.ts';

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
  const text =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(text);
  if (errorMessage) errorMessage.textContent = text;
  errorOverlay?.classList.remove('hidden');
  if (errorOverlay) errorOverlay.hidden = false;
  clearLoading();
}

window.addEventListener('error', (event) => showError(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => showError(event.reason));

async function boot(): Promise<void> {
  setLoading('Initializing WebGPU');
  const { renderer } = await initRenderer();

  setLoading('Building scene');
  const world = new WorldState();
  const stats = new CacheStats();
  const { scene, camera, sun, update: updateScene } = createCornerScene();

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 2.4, -0.5);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.update();

  // Query overrides, so a headless capture can drive the scene without a human
  // touching the GUI. e.g. `?sky=0` isolates bounce, `?az=200&animate=1` scrubs time.
  const params = new URLSearchParams(window.location.search);
  const num = (key: string): number | null => {
    const raw = params.get(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  const timeOfDay = new TimeOfDay(world, sun);
  timeOfDay.params.azimuthDeg = num('az') ?? timeOfDay.params.azimuthDeg;
  timeOfDay.params.elevationDeg = num('el') ?? timeOfDay.params.elevationDeg;
  timeOfDay.params.speedDegPerSec = num('speed') ?? timeOfDay.params.speedDegPerSec;
  timeOfDay.params.animate = params.get('animate') === '1';

  // ---- static world representation + GI cache ------------------------------
  setLoading('Building static BVH');
  const bvh = createSceneBvh(scene);

  setLoading('Tracing irradiance cache');
  const volume = new IrradianceVolume(bvh, world);

  volume.skyIntensity = num('sky') ?? volume.skyIntensity;
  volume.intensity = num('gi') ?? volume.intensity;

  attachIrradiance(scene, volume);
  volume.primeAll(renderer);

  setLoading('Compiling frame graph');
  const frameGraph = new FrameGraph(renderer, scene, camera);
  const hud = new Hud(world, stats);

  // ---- GUI ----------------------------------------------------------------
  const gui = new GUI({ title: 'Elderwood' });

  const sunFolder = gui.addFolder('Sun');
  sunFolder.add(timeOfDay.params, 'azimuthDeg', 0, 360, 0.1).name('azimuth');
  sunFolder.add(timeOfDay.params, 'elevationDeg', -10, 90, 0.1).name('elevation');
  sunFolder.add(timeOfDay.params, 'intensity', 0, 20, 0.05);
  sunFolder.add(timeOfDay.params, 'animate');
  sunFolder.add(timeOfDay.params, 'speedDegPerSec', 0.1, 30, 0.1).name('speed °/s');

  const giFolder = gui.addFolder('GI cache (traced)');
  giFolder.add(volume, 'intensity', 0, 4, 0.05).name('intensity');
  giFolder.add(volume, 'skyIntensity', 0, 3, 0.01).name('sky term');
  giFolder.add(volume, 'probesPerFrame', 16, 1024, 16).name('probes/frame');
  giFolder.add(volume, 'blend', 0.05, 1, 0.05).name('converge');
  giFolder
    .add({ probes: volume.probeCount }, 'probes')
    .name('probe count')
    .disable();
  giFolder
    .add({ tris: bvh.triangleCount }, 'tris')
    .name('BVH triangles')
    .disable();

  const ssgiFolder = gui.addFolder('SSGI (near-field, off)');
  ssgiFolder.close();
  const sync = () => frameGraph.syncSsgiParams();
  ssgiFolder.add(frameGraph.ssgiParams, 'sliceCount', 1, 4, 1).onChange(sync);
  ssgiFolder.add(frameGraph.ssgiParams, 'stepCount', 1, 24, 1).onChange(sync);
  ssgiFolder.add(frameGraph.ssgiParams, 'giIntensity', 0, 20, 0.1).onChange(sync);
  ssgiFolder.add(frameGraph.ssgiParams, 'aoIntensity', 0, 3, 0.05).onChange(sync);
  ssgiFolder.add(frameGraph.ssgiParams, 'thickness', 0.05, 4, 0.05).onChange(sync);
  ssgiFolder.add(frameGraph.ssgiParams, 'backfaceLighting', 0, 1, 0.05).onChange(sync);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    frameGraph.setSize(window.innerWidth, window.innerHeight);
  });

  let previous = performance.now();
  let firstFrame = true;

  renderer.setAnimationLoop(() => {
    if (fatal) return;

    const now = performance.now();
    const dt = (now - previous) / 1000;
    previous = now;

    world.beginFrame(dt);
    timeOfDay.update(world.dt);
    controls.update();
    updateScene(world);

    // Sampled every frame by the materials; refreshed here under a hard budget.
    volume.update(renderer, stats);

    frameGraph.render();

    stats.endFrame(world.dt);
    hud.update(world.dt);

    if (firstFrame) {
      firstFrame = false;
      clearLoading();
    }
  });
}

boot().catch(showError);
