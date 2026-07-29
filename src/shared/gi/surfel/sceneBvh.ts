// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// sceneBvh.ts
import * as THREE from 'three/webgpu';
import { MeshBVH, SAH } from '../bvh/index.js';
// import { MeshBVH, SAH } from 'three-mesh-bvh';

import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { storage } from 'three/tsl';
import { buildDiffuseArrayTexture } from './diffuseArray';

export type SceneBVHBundle = {
  // TSL Storage Nodes
  bvhNode: THREE.StorageBufferNode;
  positionNode: THREE.StorageBufferNode;
  normalNode: THREE.StorageBufferNode;
  indexNode: THREE.StorageBufferNode;
  colorNode: THREE.StorageBufferNode;
  diffuseArrayTex: THREE.Texture;
  //   update: (scene: THREE.Scene) => void;
};

export function createSceneBVH(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
): SceneBVHBundle {
  const geometries: THREE.BufferGeometry[] = [];
  scene.updateMatrixWorld(true);

  const { diffuseArrayTex, materialIdByUUID } = buildDiffuseArrayTexture(
    renderer,
    scene,
    1024,
  );

  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.visible) {
      // Clone and bake world matrix
      let geom = obj.geometry.clone();
      geom.applyMatrix4(obj.matrixWorld);

      // IMPORTANT: make triangles independent so matId can be constant per-triangle
      geom = geom.index ? geom.toNonIndexed() : geom;

      const posAttr = geom.getAttribute('position') as
        | THREE.BufferAttribute
        | undefined;
      if (!posAttr) return;

      const vertexCount = posAttr.count;

      // Ensure sequential index
      if (!geom.index) {
        const idx = [];
        for (let i = 0; i < vertexCount; i++) {
          idx.push(i);
        }
        geom.setIndex(idx);
      }

      // Ensure uv exists (fallback 0,0)
      if (!geom.getAttribute('uv')) {
        geom.setAttribute(
          'uv',
          new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2),
        );
      }
      const uvAttr = geom.getAttribute('uv') as THREE.BufferAttribute;

      // --- NEW: compute matId per vertex (constant within each triangle) ---
      const matIdArray = new Float32Array(vertexCount);
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];

      if (geom.groups && geom.groups.length > 0 && mats.length > 1) {
        // multi-material geometry
        for (const g of geom.groups) {
          const m = mats[g.materialIndex] ?? mats[0];
          const id = materialIdByUUID.get(m.uuid) ?? 0;
          // after our non-indexed + sequential index, start/count map 1:1 to vertices
          matIdArray.fill(id, g.start, g.start + g.count);
        }
      } else {
        // single material
        const m = mats[0];
        const id = materialIdByUUID.get(m.uuid) ?? 0;
        matIdArray.fill(id);
      }

      const packed = new Float32Array(vertexCount * 3);
      for (let i = 0; i < vertexCount; i++) {
        packed[i * 3 + 0] = uvAttr.getX(i);
        packed[i * 3 + 1] = uvAttr.getY(i);
        packed[i * 3 + 2] = matIdArray[i]; // integer stored as float (safe for < 16M)
      }
      geom.setAttribute('color', new THREE.BufferAttribute(packed, 3));
      // -----------------------------------------------------

      // LOCAL ADDITION vs upstream: mergeGeometries requires an identical attribute
      // set on every input. Once uv/matId are packed into `color`, nothing else is
      // read by the tracer — and dropping the rest is what keeps the merge from
      // failing the moment the lightmap unwrapper has given uv1 to some meshes and
      // not others.
      for (const name of Object.keys(geom.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'color') {
          geom.deleteAttribute(name);
        }
      }

      geometries.push(geom);
    }
  });

  if (geometries.length === 0) {
    throw new Error('createSceneBVH: no geometries found');
  }

  const merged = BufferGeometryUtils.mergeGeometries(geometries);

  // Build BVH
  console.time('BVH Build');
  const bvh = new MeshBVH(merged, { maxLeafTris: 1, strategy: SAH });
  console.timeEnd('BVH Build');

  // Upload to GPU Buffers
  const roots = bvh._roots; // Access internal array buffer of nodes
  const rootBuffer = roots[0]; // Assuming 1 root for now

  // Stable attribute references (we resize array content, keep object ref)
  const bvhAttr = new THREE.StorageBufferAttribute(
    new Float32Array(bvh._roots[0]),
    8,
  ); // BVHNode is 8 floats
  const posAttr = new THREE.StorageBufferAttribute(
    merged.attributes.position.array,
    3,
  );
  const norAttr = new THREE.StorageBufferAttribute(
    merged.attributes.normal.array,
    3,
  );
  const idxAttr = new THREE.StorageBufferAttribute(merged.index?.array, 3); // uvec3
  const colAttr = new THREE.StorageBufferAttribute(
    merged.attributes.color.array,
    3,
  );

  // TSL Nodes
  const bvhNode = storage(bvhAttr, 'BVHNode', 0).toReadOnly().setName('bvh');
  const positionNode = storage(posAttr, 'vec3', 0)
    .toReadOnly()
    .setName('bvh_position');
  const normalNode = storage(norAttr, 'vec3', 0).toReadOnly();
  const indexNode = storage(idxAttr, 'uvec3', 0)
    .toReadOnly()
    .setName('bvh_index');
  const colorNode = storage(colAttr, 'vec3', 0)
    .toReadOnly()
    .setName('bvh_attribute');

  // 1. BVH Nodes
  if (bvhAttr.count * 8 < rootBuffer.length) {
    // Resize if needed (naive)
    bvhAttr.array = new Float32Array(rootBuffer);
    // @ts-ignore
    bvhAttr.count = rootBuffer.length / 8;
  } else {
    (bvhAttr.array as Float32Array).set(rootBuffer);
  }
  bvhAttr.needsUpdate = true;

  const resizeAndUpload = (
    attr: THREE.StorageBufferAttribute,
    data: ArrayLike<number>,
    itemSize: number,
  ) => {
    if (attr.array.length < data.length) {
      attr.array =
        data instanceof Float32Array
          ? new Float32Array(data)
          : new Uint32Array(data);
      // @ts-ignore
      attr.count = data.length / itemSize;
    } else {
      (attr.array as any).set(data);
    }
    attr.needsUpdate = true;
  };

  // 2. Geometry Attributes
  const positions = merged.getAttribute('position').array as Float32Array;
  const normals = merged.getAttribute('normal').array as Float32Array;
  const indices = merged.index!.array as Uint32Array;
  const colors = merged.getAttribute('color').array as Float32Array;

  console.log('[BVH] triCount:', merged.index!.count / 3);
  console.log('[BVH] positionCount:', merged.getAttribute('position').count);
  console.log('[BVH] bounds:', bvh.geometry.boundingBox);

  resizeAndUpload(posAttr, positions, 3);
  resizeAndUpload(norAttr, normals, 3);
  resizeAndUpload(colAttr, colors, 3); // <--- NEW
  resizeAndUpload(idxAttr, indices, 3);

  // Update TSL node counts
  // @ts-ignore
  bvhNode.count = bvhAttr.count;
  // @ts-ignore
  positionNode.count = posAttr.count;
  // @ts-ignore
  normalNode.count = norAttr.count;
  // @ts-ignore
  colorNode.count = colAttr.count;
  // @ts-ignore
  indexNode.count = idxAttr.count;

  // Initial empty
  return {
    bvhNode,
    positionNode,
    normalNode,
    indexNode,
    colorNode,
    diffuseArrayTex,
  };
}
