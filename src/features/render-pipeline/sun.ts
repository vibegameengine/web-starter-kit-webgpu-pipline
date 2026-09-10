import * as THREE from 'three/webgpu';
import type GUI from 'lil-gui';
import { Layer } from '../../shared/world/index.ts';
import { installReceiverPlaneShadows } from '../../shared/render/receiverPlaneShadow.ts';
import { installSoftSunShadows, U_SUN_ANGULAR_DIAMETER_DEG } from '../../shared/render/softSunShadow.ts';
import {
  createLightControls,
  findSunPositionWeighted,
  setLightAngles,
  setLightAnglesFromEnvMapSunUVLocation,
} from '../../shared/gi/surfel/lighting.ts';
import { applyOcclusionSettings } from '../../shared/gi/surfel/surfelRadialDepth.ts';
import { sunIntensityFromEnvironment } from '../lighting-pipeline/sunFromEnvironment.ts';
import type { SceneHost, UrlParams } from './host.ts';

const SHADOW_MAP_SIZE = 4096;
const MIN_SHADOW_EXTENT = 15;

export type SunControls = ReturnType<typeof createLightControls>;

export function configureSunShadow(sun: THREE.DirectionalLight, scene: THREE.Scene): void {
  const bounds = new THREE.Box3();
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.layers.isEnabled(Layer.GiStatic)) bounds.expandByObject(mesh);
  });
  const radius = bounds.isEmpty() ? 0 : bounds.getSize(new THREE.Vector3()).length() * 0.5;
  const extent = Math.max(MIN_SHADOW_EXTENT, Math.ceil(radius * 1.1));
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 100;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.bias = -0.0003;
  sun.shadow.camera.updateProjectionMatrix();
}

function requestedIntensity(host: SceneHost, envTexture: THREE.Texture, url: UrlParams): number | undefined {
  const fromUrl = url.num('sun');
  if (fromUrl !== null) return fromUrl;
  if (host.sunIntensity === 'environment') return sunIntensityFromEnvironment(envTexture as THREE.DataTexture) * (url.num('env') ?? 1);
  return host.sunIntensity;
}

function installShadowFilter(sun: THREE.DirectionalLight, blueNoise: THREE.Texture, url: UrlParams): string {
  const filter = url.get('shadowFilter') ?? 'soft';
  if (filter === 'receiverPlane') installReceiverPlaneShadows(sun);
  else if (filter !== 'legacy') installSoftSunShadows(sun, blueNoise);
  const disc = url.num('sunDisc');
  if (disc !== null) U_SUN_ANGULAR_DIAMETER_DEG.value = disc;
  return filter;
}

export function setupSun(gui: GUI, host: SceneHost, assets: { envTexture: THREE.Texture; blueNoise: THREE.Texture }, url: UrlParams): SunControls & { shadowFilter: string } {
  const [u, v] = findSunPositionWeighted(assets.envTexture as THREE.DataTexture);
  setLightAnglesFromEnvMapSunUVLocation(u, v);
  const controls = createLightControls(gui, host.sun);
  const intensity = requestedIntensity(host, assets.envTexture, url);
  if (typeof intensity === 'number' && Number.isFinite(intensity)) controls.lightCfg.intensity = intensity;
  const azimuth = url.num('sunAz');
  const elevation = url.num('sunEl');
  if (azimuth !== null && elevation !== null) setLightAngles(azimuth, elevation);
  applyOcclusionSettings({ shadowStrength: 0.5 });
  controls.updateLightFromAngles();
  configureSunShadow(host.sun, host.scene);
  controls.lightCfg.animate = url.get('animate') === '1';
  return { ...controls, shadowFilter: installShadowFilter(host.sun, assets.blueNoise, url) };
}
