import GUI from 'lil-gui';

import { initRenderer } from '../shared/render/index.ts';
import { createLightingPipeline, type SceneHost } from '../features/lighting-pipeline/index.ts';
import { createRenderPipeline } from '../features/render-pipeline/index.ts';
import { staticInteriorVolume } from '../shared/gi/probes/index.ts';
import { createBeachScene, createCorridorScene, createCornellScene, createForestScene, populateCornell } from '../widgets/world/index.ts';
import { applyGuiSettings, loadGuiSettings, settingsProfile, settingsSceneName } from './guiSettings.ts';
import { addGuiSettingsControls } from './guiSettingsPanel.ts';

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

  setLoading('Initializing WebGPU');
  const { renderer } = await initRenderer();

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
    : await createRenderPipeline(renderer, ui);

  setLoading('Building scene');
  let host: SceneHost;
  if (params.get('scene') === 'forest') {
    const forest = await createForestScene(renderer);
    host = { ...forest, skyIsBackground: false, moverByDefault: false, sunIntensity: 'environment' };
  } else if (params.get('scene') === 'corridor') {
    const corridor = await createCorridorScene(renderer);
    host = { ...corridor, skyIsBackground: true, moverByDefault: false, sunIntensity: 'environment', interiorVolumes: [staticInteriorVolume(corridor.scene)] };
  } else if (params.get('scene') === 'beach') {
    const beach = await createBeachScene(renderer, pipeline.envTexture);
    host = { ...beach, skyIsBackground: false, moverByDefault: false, sunIntensity: 'environment', reflections: { denoisePasses: 1 } };
  } else {
    const cornell = createCornellScene(renderer);
    setLoading('Building Cornell box');
    populateCornell(cornell.scene, cornell.sun);
    host = { ...cornell, skyIsBackground: true, moverByDefault: true, interiorVolumes: [staticInteriorVolume(cornell.scene)] };
  }

  await pipeline.run(host, gui, ui);
  applyGuiSettings(gui, saved);
  addGuiSettingsControls(gui, settingsScene, profile, ui);
}

boot().catch(showError);
