// @ts-nocheck -- Three r182 exposes setupObserver; RenderObject is an internal type.
import * as THREE from 'three/webgpu';

const prepared = new WeakSet<THREE.Material>();

export function receiverOwnership(object: THREE.Object3D | null | undefined): number {
  return object?.userData.bakedLightReceiver ? 1 : -(object?.userData.giRigidReceiver ?? 0);
}

/** Add the MRT owner to Three's material observer, once per material at scene sync. */
export function prepareReceiverMaterials(scene: THREE.Scene): void {
  scene.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!material.isNodeMaterial || prepared.has(material)) continue;
      prepared.add(material);
      const setupObserver = material.setupObserver;
      const cacheKey = material.customProgramCacheKey;
      material.setupObserver = function(builder) {
        const observer = setupObserver.call(this, builder);
        const needsRefresh = observer.needsRefresh;
        const owners = new WeakMap();
        observer.needsRefresh = function(renderObject, nodeFrame) {
          const owner = receiverOwnership(renderObject.object);
          const changed = owners.get(renderObject) !== owner;
          owners.set(renderObject, owner);
          // Preserve the stock observer's bookkeeping and all existing refreshes.
          // MRT uniforms are external to material nodes, so its default comparison
          // misses owner changes on stationary objects (including shared materials).
          return needsRefresh.call(this, renderObject, nodeFrame) || changed;
        };
        return observer;
      };
      // Also replace observers for materials that were rendered before GI setup.
      material.customProgramCacheKey = function() { return `${cacheKey.call(this)}|gi-receiver-owner-v1`; };
      material.needsUpdate = true;
    }
  });
}
