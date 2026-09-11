import * as THREE from 'three/webgpu';
import type { CaptureMode, ReflectionVolume } from './reflectionTypes.ts';

export interface ReflectionVolumeSpec {
  anchor?: THREE.Vector3;
  regionId?: number;
  bounds?: THREE.Box3;
  priority?: number;
  faceSize?: number;
  captureMode?: CaptureMode;
}

const MAX_DERIVED_EXTENT = 400;

export function sceneReflectionBounds(scene: THREE.Object3D): THREE.Box3 {
  const bounds = new THREE.Box3();
  const object = new THREE.Box3();
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.giExclude === true) return;
    object.setFromObject(mesh);
    if (object.isEmpty()) return;
    const size = object.getSize(new THREE.Vector3());
    if (Math.max(size.x, size.y, size.z) > MAX_DERIVED_EXTENT) return;
    bounds.union(object);
  });
  if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-10, -1, -10), new THREE.Vector3(10, 10, 10));
  return bounds;
}

export function deriveReflectionVolume(scene: THREE.Object3D, spec: ReflectionVolumeSpec = {}): ReflectionVolume {
  const bounds = spec.bounds ?? sceneReflectionBounds(scene);
  const centre = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const anchor = spec.anchor ?? new THREE.Vector3(centre.x, THREE.MathUtils.lerp(bounds.min.y, bounds.max.y, 0.35), centre.z);
  const influence = bounds.clone().expandByVector(size.clone().multiplyScalar(0.5));
  return {
    id: 1,
    anchor,
    regionId: spec.regionId ?? 0,
    influenceVolume: influence,
    ownershipVolume: influence.clone(),
    proxy: { kind: 'box', center: centre, halfSize: size.clone().multiplyScalar(0.5) },
    priority: spec.priority ?? 0,
    faceSize: spec.faceSize ?? 128,
    captureMode: spec.captureMode ?? 'stable',
  };
}
