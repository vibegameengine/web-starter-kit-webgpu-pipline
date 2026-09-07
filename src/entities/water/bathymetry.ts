import * as THREE from 'three/webgpu';
import { positionWorld, vec4 } from 'three/tsl';

/**
 * The bed the water runs over, taken from the geometry itself: the sand and every
 * boulder rendered from straight above into a height texture. A boulder's footprint
 * in the solver is then the boulder, not a stamp approximating it — the difference
 * between the two was a collar of dry cells around every rock that the sheet had to
 * fade over, and a hole wherever the collar reached past the stone.
 *
 * Layout matches `IslandField.toTexture`: u runs +x, v runs +z, one texel per cell
 * centre. Rendered once; the objects are static.
 */
export function bakeBathymetry(options: {
  renderer: THREE.WebGPURenderer;
  /** Objects whose meshes make the bed (the island, the rocks). Re-parented for the render, put back after. */
  objects: THREE.Object3D[];
  half: number;
  size?: number;
  /** Height written where nothing is seen (outside the slab, or a gap). */
  floor?: number;
}): THREE.Texture {
  const { renderer, objects, half, size = 512, floor = -10 } = options;
  const target = new THREE.RenderTarget(size, size, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    generateMipmaps: false,
  });
  target.texture.name = 'bathymetry';
  // The inspector reads the bed back through this: the same bed the solver sees.
  target.texture.userData.renderTarget = target;
  target.texture.minFilter = THREE.LinearFilter;
  target.texture.magFilter = THREE.LinearFilter;
  target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;

  // Straight down with −z as the camera's up: a render target's v = 0 is the top of
  // the image here, so the top row is z = −half, as in the height texture, and the
  // camera's right is +x, so u runs +x. (Measured: with +z up the bed came out
  // mirrored in z — the boulders' footprints sat in the empty front corner.)
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 60);
  camera.position.set(0, 30, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const material = new THREE.MeshBasicNodeMaterial();
  material.name = 'bathymetryHeight';
  material.side = THREE.DoubleSide;
  material.blending = THREE.NoBlending;
  // The raw fragment output: heights are signed metres and must not pass through
  // tone mapping or a colour-space conversion on the way into the target.
  material.fragmentNode = vec4(positionWorld.y, 0.0, 0.0, 1.0);
  material.toneMapped = false;

  const stage = new THREE.Scene();
  stage.overrideMaterial = material;
  const parents = objects.map((object) => ({ object, parent: object.parent }));
  for (const { object } of parents) stage.add(object);
  // A floor under everything: a texel nothing covers reads `floor`, never the clear colour.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4 * half, 4 * half));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = floor;
  stage.add(ground);
  // Everything in the stage renders, whatever layer it lives on; the objects' own
  // layers are not touched — the pipeline reads them.
  camera.layers.enableAll();

  const previousTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(stage, camera);
  renderer.setRenderTarget(previousTarget);

  for (const { object, parent } of parents) {
    if (parent) parent.add(object); else stage.remove(object);
  }
  return target.texture;
}
