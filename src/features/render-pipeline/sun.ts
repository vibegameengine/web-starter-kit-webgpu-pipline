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
/* @important A constant depth bias is what put a hard white line along every wall-floor contact in
   the corridor - reproduced at ?scene=corridor&cam=bench, and still there with the lightmap forced
   to zero, so it was never the bake. -0.0003 pushes the comparison toward the light and the floor
   texels at the wall foot escape the wall's shadow. The offset is along the surface normal instead,
   1.5 shadow texels wide, which cures the acne it was hiding without moving anything toward the
   light: measured clean at 1 and 1.5 texels, acne returns at 0. Design section 06. */
const SHADOW_NORMAL_BIAS_TEXELS = 1.5;
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
  sun.shadow.bias = 0;
  sun.shadow.normalBias = (2 * extent / SHADOW_MAP_SIZE) * SHADOW_NORMAL_BIAS_TEXELS;
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
  const bias = url.num('shadowBias');
  if (bias !== null) sun.shadow.bias = bias;
  const normalBias = url.num('shadowNormalBias');
  if (normalBias !== null) sun.shadow.normalBias = normalBias;
  return filter;
}

const SHADOW_SIDES: Record<string, THREE.Side> = { back: THREE.BackSide, front: THREE.FrontSide, double: THREE.DoubleSide };

function applyShadowSide(scene: THREE.Scene, url: UrlParams): void {
  const wanted = SHADOW_SIDES[url.get('shadowSide') ?? ''];
  const seen = new Map<THREE.Side | null | undefined, number>();
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.castShadow) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      seen.set(material.shadowSide ?? material.side, (seen.get(material.shadowSide ?? material.side) ?? 0) + 1);
      if (wanted !== undefined) material.shadowSide = wanted;
    }
  });
  console.log(`[shadow] caster sides ${JSON.stringify([...seen])}${wanted === undefined ? '' : ` forced to ${url.get('shadowSide')}`}`);
}

export function setupSun(gui: GUI, host: SceneHost, assets: { envTexture: THREE.Texture; blueNoise: THREE.Texture }, url: UrlParams): SunControls & { shadowFilter: string } {
  applyShadowSide(host.scene, url);
  const sunUv = findSunPositionWeighted(assets.envTexture as THREE.DataTexture);
  if (sunUv) setLightAnglesFromEnvMapSunUVLocation(sunUv[0], sunUv[1]);
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
