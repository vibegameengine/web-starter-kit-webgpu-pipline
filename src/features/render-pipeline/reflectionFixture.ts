import * as THREE from 'three/webgpu';
import { Layer } from '../../shared/world/index.ts';
import type { SceneHost } from './host.ts';

export const FIXTURE_ROUGHNESS = [0, 0.05, 0.2, 0.5, 1];

export function addReflectionFixture(host: SceneHost, radius = 0.35, spacing = 1.05): THREE.Group {
  const group = new THREE.Group();
  group.name = 'reflectionFixture';
  const geometry = new THREE.SphereGeometry(radius, 48, 32);
  const centre = host.controls.target.clone();
  const forward = host.camera.position.clone().sub(centre);
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, 1);
  forward.normalize();
  const right = new THREE.Vector3(-forward.z, 0, forward.x);
  const origin = centre.clone().add(forward.clone().multiplyScalar(radius * 4));
  FIXTURE_ROUGHNESS.forEach((roughness, index) => {
    const material = new THREE.MeshStandardNodeMaterial({ color: 0xd8d8d8, metalness: 1, roughness });
    const sphere = new THREE.Mesh(geometry, material);
    sphere.name = `reflectionFixture-${roughness}`;
    sphere.position.copy(origin).add(right.clone().multiplyScalar((index - (FIXTURE_ROUGHNESS.length - 1) / 2) * spacing));
    sphere.position.y += radius;
    sphere.castShadow = true;
    sphere.receiveShadow = true;
    sphere.layers.enable(Layer.GiStatic);
    group.add(sphere);
  });
  host.scene.add(group);
  return group;
}
