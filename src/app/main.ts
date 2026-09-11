import GUI from 'lil-gui';

import { initRenderer } from '../shared/render/index.ts';
import { createLightingPipeline, type SceneHost } from '../features/lighting-pipeline/index.ts';
import { createRenderPipeline } from '../features/render-pipeline/index.ts';
import { staticInteriorVolume } from '../shared/gi/probes/index.ts';
import { createBeachScene, createMidseeVillageScene, createVillageLightScene, createCorridorScene, createCornellScene, createForestScene, createLeakRoomScene, populateCornell } from '../widgets/world/index.ts';
import { applyGuiSettings, loadGuiSettings, settingsProfile, settingsProfileSource, settingsSceneName } from './guiSettings.ts';
import { addGuiSettingsControls } from './guiSettingsPanel.ts';
import { bootStage, onBootProgress } from '../shared/ui/bootProgress.ts';

const loadingOverlay = document.querySelector<HTMLElement>('#loading-overlay');
const loadingMessage = document.querySelector<HTMLElement>('#loading-message');
const loadingDetail = document.querySelector<HTMLElement>('#loading-detail');
const errorOverlay = document.querySelector<HTMLElement>('#error-overlay');
const errorMessage = document.querySelector<HTMLElement>('#error-message');

let fatal = false;
const bootStarted = performance.now();

function setLoading(message: string): void {
  const seconds = ((performance.now() - bootStarted) / 1000).toFixed(1);
  if (loadingMessage) loadingMessage.textContent = message;
  if (loadingDetail) loadingDetail.textContent = `${seconds}s since the page opened`;
  console.log(`[boot] ${seconds}s: ${message}`);
  loadingOverlay?.classList.remove('hidden');
  if (loadingOverlay) loadingOverlay.hidden = false;
}

onBootProgress(setLoading);

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

/**
 * Composition root: one lighting pipeline, one scene plugged into it.
 *
 * The pipeline (`features/lighting-pipeline`) owns everything about light — sun,
 * shadow, surfel GI, bake, page streaming, frame graph, debug hooks, the render loop.
 * A scene owns geometry and its own animation and nothing else. `?scene=beach` picks
 * the diorama lab; the Cornell box stays the reference frame.
 */
async function boot(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  // `?hud=0` strips the overlays so a capture can be diffed against webgiya's
  // output pixel for pixel without chrome getting in the way.
  const showChrome = params.get('hud') !== '0';

  const { renderer } = await bootStage('Initializing WebGPU', () => initRenderer());

  const gui = new GUI({ title: 'Elderwood' });
  if (!showChrome) {
    gui.hide();
    // The Inspector's fps widget is chrome too; a judged frame must not carry it.
    (renderer.inspector as unknown as { domElement?: HTMLElement }).domElement?.style.setProperty('display', 'none');
  }

  const settingsScene = settingsSceneName(params);
  const profile = settingsProfile(params);
  const saved = await loadGuiSettings(settingsScene, profile);
  const ui = { setLoading, clearLoading, showError, showChrome, applySavedSettings: (target: GUI) => applyGuiSettings(target, saved) };
  const pipeline = params.get('pipeline') === 'legacy'
    ? await createLightingPipeline(renderer, ui)
    : await createRenderPipeline(renderer);

  let host: SceneHost;
  if (params.get('scene') === 'forest') {
    const forest = await createForestScene(renderer);
    host = { ...forest, skyIsBackground: false, moverByDefault: false, sunIntensity: 'environment' };
  } else if (params.get('scene') === 'corridor') {
    const corridor = await createCorridorScene(renderer);
    host = { ...corridor, skyIsBackground: true, moverByDefault: false, sunIntensity: 'environment', interiorVolumes: [staticInteriorVolume(corridor.scene)] };
  } else if (params.get('scene') === 'leak-room') {
    const room = createLeakRoomScene(renderer);
    host = { ...room, skyIsBackground: true, moverByDefault: false };
  } else if (params.get('scene') === 'midsee-village') {
    const village = await createMidseeVillageScene(renderer, pipeline.envTexture);
    host = { ...village, skyIsBackground: false, moverByDefault: false, sunIntensity: 'environment', reflections: { denoisePasses: 1 } };
  } else if (params.get('scene') === 'village-light') {
    const village = await createVillageLightScene(renderer, pipeline.envTexture);
    host = { ...village, skyIsBackground: false, moverByDefault: false, sunIntensity: 'environment' };
  } else if (params.get('scene') === 'beach') {
    const beach = await createBeachScene(renderer, pipeline.envTexture);
    host = { ...beach, skyIsBackground: false, moverByDefault: false, sunIntensity: 'environment', reflections: { denoisePasses: 1 } };
  } else {
    const cornell = createCornellScene(renderer);
    await bootStage('Building the Cornell box', () => populateCornell(cornell.scene, cornell.sun));
    host = { ...cornell, skyIsBackground: true, moverByDefault: true, interiorVolumes: [staticInteriorVolume(cornell.scene)] };
  }

  await pipeline.run(host, gui, ui);
  applyGuiSettings(gui, saved);
  addGuiSettingsControls(gui, settingsScene, { profile, source: settingsProfileSource(params) }, ui);
}

boot().catch(showError);
