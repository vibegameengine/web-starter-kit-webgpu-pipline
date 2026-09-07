import * as THREE from 'three/webgpu';
import { clamp, dot, normalWorld, positionWorld, cameraPosition, pow, uniform, vec3, vertexColor } from 'three/tsl';

/**
 * One sun for every leaf. The scene writes it each frame; leaf materials read it.
 * Kept out of the light loop on purpose: this is a cheap wrap-around/translucency
 * term the standard BRDF has no slot for, not a second light.
 */
export const foliageSun = {
  direction: uniform(new THREE.Vector3(0, 1, 0)),
  color: uniform(new THREE.Color(1, 0.9, 0.75)),
};

export function updateFoliageSun(sun: THREE.DirectionalLight): void {
  (foliageSun.direction.value as THREE.Vector3)
    .copy(sun.position)
    .sub(sun.target.position)
    .normalize();
  (foliageSun.color.value as THREE.Color).copy(sun.color).multiplyScalar(sun.intensity);
}

/**
 * Thin-leaf translucency: light that comes through a leaf from behind, strongest
 * when the viewer looks toward the sun through it. Added as emission, scaled by the
 * leaf's own colour so a yellow-green tip glows yellow-green.
 *
 * `strength` ≈ 0.25 for palm fronds, ≈ 0.18 for waxy broad leaves.
 */
export function leafTranslucency(strength: number) {
  const viewDir = positionWorld.sub(cameraPosition).normalize();
  const sunDir = vec3(foliageSun.direction);
  // Light through the leaf: sun on the far side of the surface from the viewer.
  const through = clamp(dot(viewDir, sunDir), 0.0, 1.0);
  const backlit = pow(through, 3.0).mul(0.8).add(0.2);
  // Leaves are two-sided; use the unsigned normal so both faces transmit alike.
  const facing = clamp(dot(normalWorld, sunDir).abs(), 0.0, 1.0);
  const transmit = backlit.mul(facing.mul(0.6).add(0.4));
  return vertexColor().rgb.mul(vec3(foliageSun.color)).mul(transmit).mul(strength);
}
