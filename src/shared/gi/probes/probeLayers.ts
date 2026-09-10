import * as THREE from 'three/webgpu';
import { Layer } from '../../world/index.ts';

export const PROBE_LAYER_EXTERIOR = 1;
export const PROBE_LAYER_INTERIOR = 2;
export const PROBE_LAYER_ALL = 3;
export const PROBE_STATE_SLOTS = 4;

export function packProbeRecord(state: number, layers: number): number {
  return state + layers * PROBE_STATE_SLOTS;
}

export function probeState(record: number): number {
  return record % PROBE_STATE_SLOTS;
}

export function probeLayers(record: number): number {
  return Math.floor(record / PROBE_STATE_SLOTS);
}

export function layerOfPoint(interiorVolumes: THREE.Box3[], point: THREE.Vector3): number {
  if (interiorVolumes.length === 0) return PROBE_LAYER_ALL;
  return interiorVolumes.some((box) => box.containsPoint(point)) ? PROBE_LAYER_INTERIOR : PROBE_LAYER_EXTERIOR;
}

const worldPosition = new THREE.Vector3();

export function layerOfObject(interiorVolumes: THREE.Box3[], object: THREE.Object3D): number {
  const declared = object.userData.giLayerMask;
  if (typeof declared === 'number') return declared;
  return layerOfPoint(interiorVolumes, worldPosition.setFromMatrixPosition(object.matrixWorld));
}

export function staticInteriorVolume(scene: THREE.Scene): THREE.Box3 {
  const bounds = new THREE.Box3();
  scene.updateMatrixWorld(true);
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.layers.isEnabled(Layer.GiStatic) && mesh.userData.giExclude !== true) bounds.expandByObject(mesh);
  });
  return bounds;
}
