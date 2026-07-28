// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// surfelDispatchArgs.ts
import * as THREE from 'three/webgpu';
import { Fn, int, atomicAdd, storage } from 'three/tsl';
import type { SurfelPool } from './surfelPool';

// Used for indirect dispatch, to dispatch up to poolMax threads
export type SurfelDispatchArgs = {
  getIndirectAttr: () => THREE.IndirectStorageBufferAttribute;
  run: (renderer: THREE.WebGPURenderer, pool: SurfelPool) => void;
};

export function createSurfelDispatchArgs(): SurfelDispatchArgs {
  let dispatchArgs: THREE.ComputeNode;

  const indirectAttr = new THREE.IndirectStorageBufferAttribute(
    new Uint32Array([1, 1, 1]),
    1,
  );

  const run = (renderer: THREE.WebGPURenderer, pool: SurfelPool) => {
    const poolMax = pool.getPoolMaxAtomic();
    if (!poolMax) return;
    const buf = storage(indirectAttr, 'uint', 3);
    if (!dispatchArgs) {
      dispatchArgs = Fn(() => {
        const highMark = atomicAdd(poolMax.element(0), int(0));
        // groups of 64 threads
        const groups = highMark.add(int(63)).div(int(64));

        buf.element(int(0)).assign(groups);
        buf.element(int(1)).assign(int(1));
        buf.element(int(2)).assign(int(1));
      })()
        .compute(1)
        .setName('Surfel Dispatch Args');
    }
    renderer.compute(dispatchArgs);
  };

  return {
    getIndirectAttr: () => indirectAttr,
    run,
  };
}
