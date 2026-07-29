import * as THREE from 'three/webgpu';
import { attribute, texture, uniform, vec3 } from 'three/tsl';
import { Layer } from '../../world/index.ts';

/**
 * Routes the baked lightmap into every static material.
 *
 * Indirect light becomes `albedo × lightmap(uv1)` — a single texture fetch, with no
 * rays, no surfels and no per-frame work of any kind. That is the entire payoff of
 * baking, and the reason a static scene can be lit for free once the bake is done.
 *
 * It is added through `emissiveNode` because that is the one slot in three's standard
 * material that accepts an arbitrary additive HDR term without fighting the built-in
 * light loop.
 */
export function applyLightmap(
  scene: THREE.Scene,
  lightmap: THREE.Texture,
  intensityUniform: ReturnType<typeof uniform>,
): number {
  const seen = new Set<THREE.Material>();
  let applied = 0;

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!mesh.layers.isEnabled(Layer.GiStatic)) return;
    if (!mesh.geometry.getAttribute('uv1')) return;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (seen.has(material)) continue;
      seen.add(material);

      const standard = material as THREE.MeshStandardNodeMaterial;
      const albedo = uniform(
        (standard.color ?? new THREE.Color(1, 1, 1)).clone(),
      );

      standard.emissiveNode = vec3(
        texture(lightmap, attribute('uv1', 'vec2')).rgb,
      )
        .mul(albedo)
        .mul(intensityUniform);
      standard.needsUpdate = true;
      applied++;
    }
  });

  console.log(`[lightmap] applied to ${applied} materials`);
  return applied;
}
