// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
import { GUI } from 'lil-gui';
import * as THREE from 'three/webgpu';

const lightCfg = {
  azimuthDeg: 35,
  elevationDeg: 50,
  intensity: 2.0,
  animate: false, // <--- New Toggle
  speed: 0.5, // <--- Speed Control
};

export type LightSettings = typeof lightCfg;

export function createLightControls(
  gui: GUI,
  initialLight: THREE.DirectionalLight,
  onChanged?: () => void,
) {
  let dirLight = initialLight;

  function setLight(nextLight: THREE.DirectionalLight) {
    dirLight = nextLight;
    updateLightFromAngles();
  }

  function updateLightFromAngles() {
    // Only apply manual angles if NOT animating
    if (lightCfg.animate) return;

    const az = THREE.MathUtils.degToRad(lightCfg.azimuthDeg);
    const el = THREE.MathUtils.degToRad(lightCfg.elevationDeg);
    const r = 40; // Fixed radius
    const x = r * Math.cos(el) * Math.cos(az);
    const y = r * Math.sin(el);
    const z = r * Math.cos(el) * Math.sin(az);

    dirLight.position.set(x, y, z);
    dirLight.intensity = lightCfg.intensity;
    onChanged?.();
  }

  // --- New Animation Helper ---
  function updateAnimation() {
    if (!lightCfg.animate) return;

    const time = performance.now() / 1000;
    const r = 10;
    const lowY = 20.5; // Height of the "low circle"

    // lightCfg.azimuthDeg = Math.sin(time/6) * 23;

    dirLight.position.x = Math.sin(time * lightCfg.speed) * r;
    dirLight.position.z = Math.cos(time * lightCfg.speed) * r;
    dirLight.position.y = lowY;

    dirLight.intensity = lightCfg.intensity;
    dirLight.updateMatrixWorld();
  }

  const folder = gui.addFolder('Light');
  folder
    .add(lightCfg, 'azimuthDeg', -180, 180, 0.1)
    .name('Azimuth')
    .onChange(updateLightFromAngles)
    .listen?.(); // .listen() lets us update UI if needed
  folder
    .add(lightCfg, 'elevationDeg', -5, 89, 0.1)
    .name('Elevation')
    .onChange(updateLightFromAngles)
    .listen?.();
  folder
    .add(lightCfg, 'intensity', 0, 20, 0.01)
    .name('Intensity')
    .onChange(updateLightFromAngles)
    .listen?.();

  folder.add(lightCfg, 'animate').name('Auto Animate').listen?.();
  folder.add(lightCfg, 'speed', 0.1, 5.0).name('Anim Speed').listen?.();

  updateLightFromAngles();

  // Return the update function so main.ts can call it every frame
  return { updateLightFromAngles, lightCfg, updateAnimation, setLight };
}

export function setLightAngles(azimuthDeg: number, elevationDeg: number) {
  lightCfg.azimuthDeg = azimuthDeg;
  lightCfg.elevationDeg = elevationDeg;
}

export function setLightAnglesFromEnvMapSunUVLocation(u: number, v: number) {
  const azimuth = (u - 0.5) * 360; // -180° to +180°
  const elevation = (0.5 - v) * 180; // +90° to -90°
  setLightAngles(azimuth, elevation);
}

export { findSunPositionWeighted, type SunUv } from './envSunSearch.ts';
