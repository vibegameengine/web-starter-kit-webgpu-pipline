// @ts-nocheck -- packed BVH nodes share the donor's u32/f32 storage layout.
import * as THREE from 'three/webgpu';
import { storage, uniform } from 'three/tsl';
import { CENTER, MeshBVH } from '../bvh/index.js';
import type { GatheredGeometry } from './sceneBvh';
import type { DynamicBVHBundle } from './dynamicBvh';

/** Immutable local BLASes + a refitted world-space tree over receiver instances.
 * The five-vec3 instance record lives after material attributes in the same buffer.
 * Updating a pose writes only that record and the TLAS prefix, never triangles. */
export function createDynamicHierarchy(scene: THREE.Object3D, entries: GatheredGeometry[]): DynamicBVHBundle {
  const localTrees = new Map<THREE.BufferGeometry, any>();
  const tlasCount = Math.max(1, entries.length * 2 - 1);
  let nodeCount = tlasCount, vertexCount = 0, indexCount = 0;
  for (const entry of entries) {
    if (localTrees.has(entry.template)) continue;
    const geometry = entry.template;
    const tree = new MeshBVH(geometry, { maxLeafTris: 1, strategy: CENTER });
    if (tree._roots.length !== 1) throw new Error('Dynamic geometry must have a single BLAS root');
    const root = new Float32Array(tree._roots[0]);
    localTrees.set(geometry, { root, nodeOffset: nodeCount, vertexOffset: vertexCount, triangleOffset: indexCount / 3 });
    nodeCount += root.length / 8;
    vertexCount += geometry.getAttribute('position').count;
    indexCount += geometry.index.count;
  }
  const nodeData = new Float32Array(nodeCount * 8), nodeBits = new Uint32Array(nodeData.buffer);
  const positions = new Float32Array(Math.max(3, vertexCount * 3));
  const indices = new Uint32Array(Math.max(3, indexCount));
  // Explicit vec3 array stride. Three r182 rewrites itemSize=3 storage arrays
  // during upload; using padded records avoids repacking immutable UVs on motion.
  const attributes = new Float32Array(Math.max(4, (vertexCount + entries.length * 5) * 4));
  for (const [geometry, tree] of localTrees) {
    nodeData.set(tree.root, tree.nodeOffset * 8);
    for (let i = tree.nodeOffset; i < tree.nodeOffset + tree.root.length / 8; i++) {
      if (nodeBits[i * 8 + 7] & 0xffff0000) nodeBits[i * 8 + 6] += tree.triangleOffset;
    }
    positions.set(geometry.getAttribute('position').array, tree.vertexOffset * 3);
    const colors = geometry.getAttribute('color');
    for (let i = 0; i < colors.count; i++) attributes.set(colors.array.subarray(i * 3, i * 3 + 3), (tree.vertexOffset + i) * 4);
    geometry.index.array.forEach((id, i) => { indices[tree.triangleOffset * 3 + i] = id + tree.vertexOffset; });
  }

  const bvhAttr = new THREE.StorageBufferAttribute(nodeData, 8);
  const posAttr = new THREE.StorageBufferAttribute(positions, 3);
  const idxAttr = new THREE.StorageBufferAttribute(indices, 3);
  const colAttr = new THREE.StorageBufferAttribute(attributes, 4);
  const worldBounds = entries.map(entry => entry.template.boundingBox.clone().applyMatrix4(entry.matrix));
  const instanceLeaf = new Int32Array(entries.length);
  const inverse = new THREE.Matrix4(), scratch = new THREE.Matrix4();
  const sphere = new THREE.Sphere(), union = new THREE.Box3();
  const lastMatrices = entries.map(entry => entry.matrix.clone());
  const enabled = uniform(entries.length ? 1 : 0), influence = uniform(new THREE.Vector4());
  let cursor = 0, updates = 0, changedInstances = 0, lastUploadBytes = 0;

  function putBounds(index, box) {
    const base = index * 8;
    for (let axis = 0; axis < 3; axis++) {
      const lo = box.min.getComponent(axis), hi = box.max.getComponent(axis);
      const pad = Math.max(1, Math.abs(lo), Math.abs(hi)) * 1e-6;
      nodeData[base + axis] = lo - pad; nodeData[base + axis + 3] = hi + pad;
    }
  }
  function build(ids: number[]): number {
    const ni = cursor++, box = new THREE.Box3();
    ids.forEach(i => box.union(worldBounds[i])); putBounds(ni, box);
    if (ids.length === 1) {
      const i = ids[0]; instanceLeaf[i] = ni;
      nodeBits[ni * 8 + 6] = vertexCount + i * 5;
      nodeBits[ni * 8 + 7] = 0xffff0001;
    } else {
      const size = box.getSize(new THREE.Vector3());
      const axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
      ids.sort((a, b) => worldBounds[a].min.getComponent(axis) + worldBounds[a].max.getComponent(axis)
        - worldBounds[b].min.getComponent(axis) - worldBounds[b].max.getComponent(axis));
      const middle = Math.floor(ids.length / 2);
      build(ids.slice(0, middle)); const right = build(ids.slice(middle));
      nodeBits[ni * 8 + 6] = right - ni; nodeBits[ni * 8 + 7] = axis;
    }
    return ni;
  }
  if (entries.length) build(entries.map((_, i) => i));
  else nodeBits[7] = 0xffff0001; // legal disabled leaf and zero/invalid metadata

  function writeInstance(i: number, upload: boolean) {
    const entry = entries[i], base = (vertexCount + i * 5) * 4;
    const determinant = entry.matrix.determinant();
    const valid = Number.isFinite(determinant) && determinant !== 0;
    attributes[base] = localTrees.get(entry.template).nodeOffset;
    attributes[base + 1] = valid ? 1 : 0;
    inverse.copy(entry.matrix).invert();
    for (let column = 0; column < 4; column++) {
      for (let row = 0; row < 3; row++) attributes[base + 4 + column * 4 + row] = inverse.elements[column * 4 + row];
    }
    worldBounds[i].copy(entry.template.boundingBox).applyMatrix4(entry.matrix);
    putBounds(instanceLeaf[i], worldBounds[i]);
    if (upload) colAttr.addUpdateRange(base, 20);
  }
  function refit() {
    for (let ni = tlasCount - 1; ni >= 0; ni--) {
      const base = ni * 8;
      if (nodeBits[base + 7] & 0xffff0000) continue;
      const left = (ni + 1) * 8, right = (ni + nodeBits[base + 6]) * 8;
      for (let axis = 0; axis < 3; axis++) {
        nodeData[base + axis] = Math.min(nodeData[left + axis], nodeData[right + axis]);
        nodeData[base + axis + 3] = Math.max(nodeData[left + axis + 3], nodeData[right + axis + 3]);
      }
    }
    if (entries.length) {
      union.min.fromArray(nodeData); union.max.fromArray(nodeData, 3); union.getBoundingSphere(sphere);
      influence.value.set(sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius);
    } else influence.value.set(0, 0, 0, 0);
  }
  entries.forEach((_, i) => writeInstance(i, false)); refit();
  const bundle: DynamicBVHBundle = {
    bvhNode: storage(bvhAttr, 'BVHNode', bvhAttr.count).toReadOnly().setName('dyn_bvh'),
    positionNode: storage(posAttr, 'vec3', posAttr.count).toReadOnly().setName('dyn_bvh_position'),
    indexNode: storage(idxAttr, 'uvec3', idxAttr.count).toReadOnly().setName('dyn_bvh_index'),
    colorNode: storage(colAttr, 'vec3', colAttr.count).toReadOnly().setName('dyn_bvh_attribute'),
    enabled, influence,
    triangleCount: entries.reduce((sum, entry) => sum + entry.template.index.count / 3, 0),
    moverCount: entries.length, lastRebuildMs: 0,
    hierarchyStats: () => ({ instances: entries.length, localTrees: localTrees.size, storedTriangles: indexCount / 3,
      tlasNodes: tlasCount, blasNodes: nodeCount - tlasCount, updates, changedInstances, lastUploadBytes,
      positionVersion: posAttr.version, indexVersion: idxAttr.version,
      geometryBytes: vertexCount * 16 * 2 + indexCount / 3 * 16,
      instanceBytes: entries.length * 5 * 16 }), // GPU vec3 storage is padded to 16 bytes
    refresh(options = {}) {
      changedInstances = 0; lastUploadBytes = 0;
      scene.updateMatrixWorld(false);
      const start = performance.now();
      entries.forEach((entry, i) => {
        if (entry.instance >= 0) {
          (entry.source as THREE.InstancedMesh).getMatrixAt(entry.instance, scratch);
          scratch.premultiply(entry.source.matrixWorld);
        } else scratch.copy(entry.source.matrixWorld);
        if (!options.force && scratch.equals(lastMatrices[i])) return;
        entry.matrix.copy(scratch); lastMatrices[i].copy(scratch);
        writeInstance(i, true); changedInstances++;
      });
      if (!changedInstances) { bundle.lastRebuildMs = 0; return false; }
      refit(); updates++;
      bvhAttr.addUpdateRange(0, tlasCount * 8); bvhAttr.needsUpdate = true; colAttr.needsUpdate = true;
      lastUploadBytes = tlasCount * 32 + changedInstances * 5 * 16;
      bundle.lastRebuildMs = performance.now() - start;
      return true;
    },
    dispose(renderer) {
      for (const attribute of [bvhAttr, posAttr, idxAttr, colAttr]) {
        if (renderer.backend.has(attribute) && renderer.backend.get(attribute).buffer) renderer.backend.destroyAttribute(attribute);
      }
      for (const geometry of localTrees.keys()) geometry.dispose();
    },
  };
  return bundle;
}
