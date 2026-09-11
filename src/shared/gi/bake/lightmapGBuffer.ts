import * as THREE from 'three/webgpu';
import {
  attribute,
  float,
  modelNormalMatrix,
  modelWorldMatrix,
  mrt,
  normalGeometry,
  positionGeometry,
  varying,
  vec4,
} from 'three/tsl';
import { Layer } from '../../world/index.ts';

/**
 * Counts how many atlas texels a chart actually covers. Returns -1 if the readback
 * is unavailable. A coverage of zero means the UV-space rasterisation drew nothing,
 * which is the single most likely way this whole path fails silently.
 */
export async function measureCoverage(
  renderer: THREE.WebGPURenderer,
  gbuffer: LightmapGBuffer,
  size: number,
  height = size,
): Promise<{ covered: number; total: number; fraction: number }> {
  const pixels = await renderer.readRenderTargetPixelsAsync(
    gbuffer.target,
    0,
    0,
    size,
    height,
    0,
  );
  let covered = 0;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] > 0.5) covered++;
  }
  const total = size * height;
  return { covered, total, fraction: covered / total };
}

export interface LightmapGBuffer {
  target: THREE.RenderTarget;
  /** xyz = world position, w = 1 where a chart covers the texel. */
  position: THREE.Texture;
  /** xyz = world normal. */
  normal: THREE.Texture;
  dispose: () => void;
}

/**
 * Rasterises the static scene *into UV space*: every mesh is drawn with its lightmap
 * UV substituted for its clip position, so each atlas texel ends up holding the world
 * position and normal of the surface point it represents.
 *
 * This is the step that makes a lightmap a lightmap. Once this atlas exists, baking is
 * just "for every texel, trace from that point" — no cameras, no screen, no dependence
 * on where anything is being viewed from. It is also why the result can be saved and
 * reloaded, unlike a screen-driven cache.
 */
export function rasteriseLightmapGBuffer(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  size: number,
  pages = 1,
): LightmapGBuffer {
  const target = new THREE.RenderTarget(size, size * pages, {
    count: 2,
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    generateMipmaps: false,
  });
  // MRT keys are matched to the render target by texture name, so these must agree
  // with the mrt() below.
  target.textures[0].name = 'position';
  target.textures[1].name = 'normal';
  for (const tex of target.textures) {
    tex.generateMipmaps = false;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
  }

  // World position and normal are computed and carried explicitly rather than via
  // `positionWorld` / `normalWorld`. Overriding `vertexNode` bypasses three's standard
  // vertex pipeline, so those built-ins arrive as zero — which silently starts every
  // bake ray at the world origin, inside solid geometry, and returns a black lightmap.
  const worldPosition = varying(modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz);
  const worldNormal = varying(modelNormalMatrix.mul(normalGeometry).normalize());

  const bakeMRT = mrt({
    position: vec4(worldPosition, 1),
    normal: vec4(worldNormal, 0),
  });

  // uv1 spans 0..1 across the atlas; clip space is -1..1, and Y is negated because
  // clip y = +1 is row 0 of the render target while a fetch at v = 0 lands on row 0
  // too. Without the negation the atlas comes out mirrored against the very UVs used
  // to sample it, so every fetch lands in a *different chart* — which does not look
  // like a mirrored image at all. It looks like wrong colours (a green wall lit red)
  // and hard black regions where a chart maps onto empty atlas space. That is what
  // this build shipped until it was measured: the sun-shadowed half of the left wall
  // was pure black at any lightmap intensity, because it was sampling a gutter.
  const atlasUv = attribute('uv1', 'vec2');
  /* @important uv1 addresses the whole stack of pages and the target is that whole stack,
     `size x size*pages`, drawn in one render. It used to draw one page per call, scaling v
     back into a single square and pushing the other pages out of clip space, and the bake
     then ran a full 200-pass integration per page: six pages of the village were six bakes,
     six minutes against the forty seconds the scene took before pages existed. Nothing
     required that - the seeder, the denoiser and the blit have always taken a height. What
     the surfel pool limits is the number of COVERED texels, not the number of pages. */
  const bakeMaterial = new THREE.MeshBasicNodeMaterial();
  bakeMaterial.vertexNode = vec4(
    atlasUv.x.mul(2).sub(1),
    atlasUv.y.mul(2).sub(1).negate(),
    float(0),
    1,
  );
  bakeMaterial.side = THREE.DoubleSide;
  bakeMaterial.depthTest = false;
  bakeMaterial.depthWrite = false;

  const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  const culling = new Map<THREE.Mesh, boolean>();
  const hidden: THREE.Object3D[] = [];

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.layers.isEnabled(Layer.GiStatic) && mesh.geometry.getAttribute('uv1')) {
      originals.set(mesh, mesh.material);
      mesh.material = bakeMaterial;
      // Frustum culling still tests world bounds against the camera, but the vertex
      // shader has thrown the camera away — every mesh would be culled and the atlas
      // would come out empty.
      culling.set(mesh, mesh.frustumCulled);
      mesh.frustumCulled = false;
    } else if (mesh.visible) {
      // Movable geometry has no place in a baked map.
      mesh.visible = false;
      hidden.push(mesh);
    }
  });

  const previousTarget = renderer.getRenderTarget();
  const previousBackground = scene.background;
  const previousMRT = renderer.getMRT();

  scene.background = null;
  renderer.setMRT(bakeMRT);
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();

  // Any camera will do: the vertex shader ignores it entirely.
  renderer.render(scene, new THREE.PerspectiveCamera());

  renderer.setRenderTarget(previousTarget);
  renderer.setMRT(previousMRT);
  scene.background = previousBackground;

  for (const [mesh, material] of originals) mesh.material = material;
  for (const [mesh, wasCulled] of culling) mesh.frustumCulled = wasCulled;
  for (const object of hidden) object.visible = true;
  bakeMaterial.dispose();

  return {
    target,
    position: target.textures[0],
    normal: target.textures[1],
    dispose: () => target.dispose(),
  };
}
