import * as THREE from 'three/webgpu';
import { normalWorld, positionWorld, uniform, vec3 } from 'three/tsl';
import type { IrradianceVolume } from './irradianceVolume.ts';

/**
 * Routes the irradiance cache into every lit material in the scene.
 *
 * The indirect term is added through `emissiveNode` as `albedo × irradiance`. That is
 * the correct diffuse-indirect math (the sampler already divides by π), and it is the
 * one slot in three's standard material that takes an arbitrary additive HDR term
 * without fighting the built-in light loop.
 *
 * Known gap, deliberate: `emissiveNode` is added after AO, so occlusion does not yet
 * multiply the indirect term the way UE does. That correction belongs with the AO pass.
 */
export function attachIrradiance(scene: THREE.Scene, volume: IrradianceVolume): void {
  const sampler = volume.createSampler();
  const shared = volume.samplerUniforms;
  const seen = new Set<THREE.Material>();

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (seen.has(material)) continue;
      seen.add(material);

      const standard = material as THREE.MeshStandardNodeMaterial;
      if (!standard.isMeshStandardNodeMaterial) continue;

      const albedo = uniform(standard.color.clone());
      const irradiance = sampler({
        ...shared,
        worldPos: positionWorld,
        worldNormal: normalWorld,
        intensity: volume.intensityUniform,
      });

      standard.emissiveNode = vec3(irradiance).mul(albedo);
      standard.needsUpdate = true;
    }
  });
}
