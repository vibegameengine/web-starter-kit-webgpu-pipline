import * as THREE from 'three/webgpu';
import {
  attribute,
  materialColor,
  texture,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import { Layer } from '../../world/index.ts';

/** Not a literal: a literal `* 0` is folded away and the tapped node never compiles. */
const inspectorZero = uniform(0);

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
      // `materialColor`, not a constant built from `material.color`. A literal is
      // inlined into the shader source, and three keys its program cache in a way
      // that let all three Cornell materials share the *first* compiled emissive
      // node -- so the red and green walls silently received the white material's
      // albedo of 1, and came out washed to pink and grey while white surfaces
      // matched the runtime to within 3%. `materialColor` resolves per material.
      // Colour *and* map. The runtime multiplies indirect light by the G-Buffer
      // albedo, which is the shaded diffuse -- so a lightmap that used only
      // `material.color` would render every textured surface's bounce flat, and the
      // Cornell texture variant sets all three colours to white and differs only in
      // the map.
      const map = (standard as { map?: THREE.Texture | null }).map;
      const albedo = map ? materialColor.mul(texture(map, uv()).rgb) : materialColor;

      // Two nodes read the same texture, on purpose.
      //
      // The lighting one samples through `attribute('uv1')`. The inspector one does
      // not: registering the uv1 node shows the atlas in the Viewer but previews it
      // black, because outside a mesh that attribute is zero and the inspector ends
      // up sampling a single corner. The second node samples with the default UV so
      // the preview is the atlas itself.
      //
      // It has to be registered from inside a material: the frame graph's own `tap()`
      // mechanism surfaces nothing in the Viewer -- verified by moving this
      // registration there and watching the entry disappear.
      //
      // Kept alive by adding it multiplied by a *uniform* zero; a literal zero is
      // constant-folded away and the node is never built, so the inspector never
      // sees it.
      const preview = texture(lightmap).toInspector('Lightmap / Atlas');

      // Added to whatever was already in the slot, not assigned over it. A material
      // that is genuinely emissive — a lamp panel, which the tracer treats as a GI
      // light source — has its emission in `emissiveNode` too, and overwriting it here
      // put the lamp out the moment the scene switched to lightmap mode. The result
      // was a glow on the wall with nothing visible casting it.
      const existing = standard.emissiveNode ?? null;
      const baked = vec3(texture(lightmap, attribute('uv1', 'vec2')).rgb)
        .mul(albedo)
        .mul(intensityUniform)
        .add(preview.rgb.mul(inspectorZero));

      standard.emissiveNode = existing ? vec3(existing).add(baked) : baked;
      standard.needsUpdate = true;
      applied++;
    }
  });

  console.log(`[lightmap] applied to ${applied} materials`);
  return applied;
}
