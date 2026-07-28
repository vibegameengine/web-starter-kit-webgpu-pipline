import * as THREE from 'three/webgpu';
import { storage } from 'three/tsl';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH, SAH } from './bvh/index.js';
import { Layer } from '../world/index.ts';

export interface SceneBvh {
  bvhNode: THREE.StorageBufferNode;
  positionNode: THREE.StorageBufferNode;
  normalNode: THREE.StorageBufferNode;
  indexNode: THREE.StorageBufferNode;
  /** Per-vertex linear albedo, read back through `getVertexAttribute` in WGSL. */
  albedoNode: THREE.StorageBufferNode;
  bounds: THREE.Box3;
  triangleCount: number;
}

/**
 * Builds a single world-space BVH over everything tagged `Layer.GiStatic`.
 *
 * This is the "static world representation" half of the UE model — the thing the
 * GI cache integrates against. It is built once, and rebuilt only when
 * `WorldState.staticGeoVersion` changes. Movable geometry is deliberately absent:
 * putting it in would mean rebuilding the BVH whenever anything moved, which is
 * exactly the cost the static/dynamic split exists to avoid.
 *
 * Albedo travels as a per-vertex colour rather than a texture atlas. One bounce off
 * an untextured surface is already the difference between a flat hemisphere and real
 * colour bleed; texture-accurate bounce can come later without changing this API.
 */
export function createSceneBvh(scene: THREE.Scene): SceneBvh {
  scene.updateMatrixWorld(true);

  const geometries: THREE.BufferGeometry[] = [];

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    if (!mesh.layers.isEnabled(Layer.GiStatic)) return;

    let geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    geometry = geometry.index ? geometry.toNonIndexed() : geometry;

    const position = geometry.getAttribute('position');
    if (!position) return;
    const vertexCount = position.count;

    if (!geometry.index) {
      const indices = new Uint32Array(vertexCount);
      for (let i = 0; i < vertexCount; i++) indices[i] = i;
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    }
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();

    // Flatten the material colour to a per-vertex attribute. Linear, because every
    // number past this point is linear until the tonemapper.
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const source = (material as THREE.MeshStandardMaterial).color ?? new THREE.Color(0.8, 0.8, 0.8);
    const albedo = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      albedo[i * 3 + 0] = source.r;
      albedo[i * 3 + 1] = source.g;
      albedo[i * 3 + 2] = source.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(albedo, 3));

    // Drop everything the tracer does not read — merging requires matching sets.
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'color') {
        geometry.deleteAttribute(name);
      }
    }

    geometries.push(geometry);
  });

  if (geometries.length === 0) {
    throw new Error('createSceneBvh: nothing tagged Layer.GiStatic');
  }

  const merged = BufferGeometryUtils.mergeGeometries(geometries);
  if (!merged || !merged.index) {
    throw new Error('createSceneBvh: geometry merge failed');
  }

  console.time('[gi] BVH build');
  const bvh = new MeshBVH(merged, { maxLeafTris: 1, strategy: SAH });
  console.timeEnd('[gi] BVH build');

  merged.computeBoundingBox();
  const bounds = merged.boundingBox ?? new THREE.Box3();
  const triangleCount = merged.index.count / 3;

  const nodeAttr = new THREE.StorageBufferAttribute(
    new Float32Array((bvh as unknown as { _roots: ArrayBuffer[] })._roots[0]),
    8, // BVHNode is 8 floats
  );
  const positionAttr = new THREE.StorageBufferAttribute(
    merged.getAttribute('position').array as Float32Array,
    3,
  );
  const normalAttr = new THREE.StorageBufferAttribute(
    merged.getAttribute('normal').array as Float32Array,
    3,
  );
  const indexAttr = new THREE.StorageBufferAttribute(
    merged.index.array as Uint32Array,
    3,
  );
  const albedoAttr = new THREE.StorageBufferAttribute(
    merged.getAttribute('color').array as Float32Array,
    3,
  );

  // Names are load-bearing: the harvested WGSL addresses these globals by name.
  const bvhNode = storage(nodeAttr, 'BVHNode', nodeAttr.count).toReadOnly().setName('bvh');
  const positionNode = storage(positionAttr, 'vec3', positionAttr.count)
    .toReadOnly()
    .setName('bvh_position');
  const normalNode = storage(normalAttr, 'vec3', normalAttr.count)
    .toReadOnly()
    .setName('bvh_normal');
  const indexNode = storage(indexAttr, 'uvec3', indexAttr.count)
    .toReadOnly()
    .setName('bvh_index');
  const albedoNode = storage(albedoAttr, 'vec3', albedoAttr.count)
    .toReadOnly()
    .setName('bvh_attribute');

  console.log(
    `[gi] BVH: ${triangleCount} tris, bounds ${bounds.min.toArray().map((v) => v.toFixed(1))} → ${bounds.max.toArray().map((v) => v.toFixed(1))}`,
  );

  return { bvhNode, positionNode, normalNode, indexNode, albedoNode, bounds, triangleCount };
}
