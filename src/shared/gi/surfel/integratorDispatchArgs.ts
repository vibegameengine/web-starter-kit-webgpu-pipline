// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// integratorDispatchArgs.ts
import * as THREE from 'three/webgpu';
import { Fn, int, atomicAdd, storage } from 'three/tsl';
import type { SurfelPool } from './surfelPool';

export function createIntegratorDispatchArgs(WG_SIZE = 64) {
  const indirectAttr = new THREE.IndirectStorageBufferAttribute(
    new Uint32Array([1, 1, 1]),
    1,
  );
  let node: THREE.ComputeNode | null = null;

  function run(renderer: THREE.WebGPURenderer, pool: SurfelPool) {
    const poolMax = pool.getPoolMaxAtomic();
    if (!poolMax) return;

    const buf = storage(indirectAttr, 'uint', 3);

    if (!node) {
      node = Fn(() => {
        // poolMax[0] = high water mark (max index + 1)
        const total = atomicAdd(poolMax.element(0), int(0)); // i32
        const wg = int(WG_SIZE);
        const groups = total.add(wg.sub(1)).div(wg); // ceil(total / WG)
        buf.element(0).assign(groups.max(int(1)));
        buf.element(1).assign(int(1));
        buf.element(2).assign(int(1));
      })()
        .compute(1)
        .setName('Integrator Dispatch Args');
    }

    renderer.compute(node);
  }

  return { run, getIndirectAttr: () => indirectAttr };
}
