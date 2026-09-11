import * as THREE from 'three/webgpu';
import { Fn, diffuseColor, normalWorld, positionWorld, uniform, vec3 } from 'three/tsl';
import { Layer } from '../../world/index.ts';
import { artisticIndirect } from '../../render/look.ts';
import { bakedIndirect, emissionBeforeLightmap } from '../bake/applyLightmap.ts';
import type { ProbeVolume } from './probeVolume.ts';
import { PROBE_LAYER_ALL, layerOfObject, layerOfPoint } from './probeLayers.ts';

const originalEmission = new WeakMap<THREE.Material, THREE.Node | null>();

export function isProbeReceiver(mesh: THREE.Mesh): boolean {
  if (!mesh.isMesh || mesh.userData.giExclude === true) return false;
  if (mesh.userData.bakedLightReceiver === true) return false;
  return mesh.layers.isEnabled(Layer.Default);
}

/* @important `diffuseColor` rather than `materialColor × map`: three assigns it before the emissive is
   read, so it is the albedo the raster shades with, vertex colour and metalness included, the same
   value the G-buffer publishes and the surfel resolve multiplied. */
export interface ProbeReceivers {
  materials: number;
  meshes: THREE.Mesh[];
}

export function setProbeReceiversBaked(receivers: ProbeReceivers, baked: boolean): void {
  for (const mesh of receivers.meshes) mesh.userData.bakedLightReceiver = baked;
}

export function applyProbeVolume(scene: THREE.Scene, volume: ProbeVolume): ProbeReceivers {
  const prepared = new Map<THREE.Material, THREE.Material>();
  const meshes: THREE.Mesh[] = [];
  let applied = 0;
  let split = 0;
  const prepare = (material: THREE.Material): THREE.Material => {
    const done = prepared.get(material);
    if (done) return done;
    let target = material as THREE.MeshStandardNodeMaterial;
    if (material.userData.lightmapApplied === true) {
      target = material.clone() as THREE.MeshStandardNodeMaterial;
      target.emissiveNode = emissionBeforeLightmap(material) ?? null;
      target.userData = { ...material.userData, lightmapApplied: false };
      split++;
    }
    applied += installProbeEmission(target, volume);
    prepared.set(material, target);
    return target;
  };
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!isProbeReceiver(mesh)) return;
    mesh.userData.bakedLightReceiver = true;
    mesh.userData.probeReceiver = true;
    if (mesh.layers.isEnabled(Layer.GiStatic)) { mesh.updateWorldMatrix(true, false); mesh.userData.giLayerMask = layerOfPoint(volume.interiorVolumes, new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3())); }
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(prepare) : prepare(mesh.material);
    meshes.push(mesh);
  });
  console.log(`[probes] applied to ${applied} materials, ${split} split off a lightmapped material`);
  return { materials: applied, meshes };
}

function installProbeEmission(material: THREE.MeshStandardNodeMaterial, volume: ProbeVolume): number {
  if (!originalEmission.has(material)) originalEmission.set(material, material.emissiveNode ?? null);
  const existing = originalEmission.get(material);
  const layerMask = uniform(PROBE_LAYER_ALL, 'int').onObjectUpdate(({ object }) => volume.forcedLayerMask ?? (object ? layerOfObject(volume.interiorVolumes, object) : PROBE_LAYER_ALL));
  const indirect = Fn(() => {
    const lit = artisticIndirect(volume.irradianceAt(positionWorld, normalWorld, layerMask)).mul(diffuseColor.rgb);
    bakedIndirect.assign(lit);
    return lit;
  })();
  material.emissiveNode = existing ? vec3(existing).add(indirect) : indirect;
  material.needsUpdate = true;
  return 1;
}
