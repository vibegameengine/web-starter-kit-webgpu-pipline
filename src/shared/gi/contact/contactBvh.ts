// @ts-nocheck -- storage-node naming and MeshBVH internals follow sceneBvh.ts.
import * as THREE from 'three/webgpu';
import { storage } from 'three/tsl';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH, SAH } from '../bvh/index.js';
import { gatherBvhGeometries } from '../surfel/sceneBvh.ts';
import { Mobility } from '../../world/index.ts';

export type ContactBVHBundle = {
  bvhNode: THREE.StorageBufferNode;
  positionNode: THREE.StorageBufferNode;
  indexNode: THREE.StorageBufferNode;
  /** Per-vertex (u, v, materialId), the same layout as the GI tree's `bvh_attribute`. */
  attributeNode: THREE.StorageBufferNode;
  triangles: number;
  buildMs: number;
  dispose: () => void;
};

/**
 * A second static BVH, full detail, for the contact rays.
 *
 * The GI's static BVH keeps a 500k-triangle budget and replaces what does not fit with
 * cluster proxy *boxes* — good enough for a bounce's worth of radiance, but a contact
 * ray starting on the sand starts *inside* the box that stands in for the sand, and hits
 * it within centimetres in most directions (bisected 2026-09-08: open sand read 0.45 ± 0.28
 * with the GI tree, 1.0 ± 0.004 without demotion). So the contact pass traces its own
 * tree with no demotion; the rays are bounded to half a metre, so the tree's size costs
 * memory, not time. Same binding names as the GI tree (`bvh`, `bvh_position`,
 * `bvh_index`): the kernel binds one or the other, never both.
 */
export function createContactBVH(scene: THREE.Scene, materialIdByUUID: Map<string, number>): ContactBVHBundle {
  scene.updateMatrixWorld(true);
  const gathered = gatherBvhGeometries(scene, {
    materialIdByUUID,
    label: 'contact',
    include: (mesh) => mesh.userData.mobility !== Mobility.Movable && mesh.userData.giExclude !== true,
    triangleBudget: 8_000_000,
    farRadius: 0,
  });
  if (gathered.entries.length === 0) throw new Error('createContactBVH: no geometries found');
  const geometries = gathered.entries.map((entry) => entry.template.clone().applyMatrix4(entry.matrix));
  const merged = BufferGeometryUtils.mergeGeometries(geometries);
  const start = performance.now();
  // Leaves of 8: a contact ray that skims a finely tessellated surface walks every
  // thin leaf box along its path, and a shallower tree with fatter leaves halves
  // those visits at the cost of a few extra triangle tests per leaf.
  const bvh = new MeshBVH(merged, { maxLeafTris: 8, strategy: SAH });
  const buildMs = performance.now() - start;
  const rootBuffer = bvh._roots[0];
  const bvhAttr = new THREE.StorageBufferAttribute(new Float32Array(rootBuffer), 8);
  const posAttr = new THREE.StorageBufferAttribute(merged.attributes.position.array, 3);
  const idxAttr = new THREE.StorageBufferAttribute(merged.index.array, 3);
  const colAttr = new THREE.StorageBufferAttribute(merged.attributes.color.array, 3);
  const bundle: ContactBVHBundle = {
    bvhNode: storage(bvhAttr, 'BVHNode', 0).toReadOnly().setName('bvh'),
    positionNode: storage(posAttr, 'vec3', 0).toReadOnly().setName('bvh_position'),
    indexNode: storage(idxAttr, 'uvec3', 0).toReadOnly().setName('bvh_index'),
    attributeNode: storage(colAttr, 'vec3', 0).toReadOnly().setName('bvh_attribute'),
    triangles: gathered.triangles,
    buildMs,
    dispose: () => { merged.dispose(); for (const g of geometries) g.dispose(); },
  };
  console.info(`[BVH:contact] ${gathered.triangles} triangles, full detail, built in ${buildMs.toFixed(0)} ms`);
  return bundle;
}
