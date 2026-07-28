import * as THREE from 'three/webgpu';
import { Fn, If, instanceIndex, int, storage } from 'three/tsl';
import { SURFEL_TTL } from './surfel/constants.ts';
import { SurfelStruct } from './surfel/surfelPool.ts';

/**
 * Age offset applied to baked surfels.
 *
 * The age pass recycles a surfel once `age >= SURFEL_TTL` and increments age by at
 * least one per frame, so pushing age far negative makes a surfel effectively
 * immortal without touching a line of webgiya's WGSL. At 120 fps this lasts about
 * two and a half hours, which is longer than any session, and it keeps the aging
 * semantics intact — crowding rent and kill signals still apply, they just start
 * from an enormous credit.
 */
const IMMORTAL_AGE = -1_000_000_000;

/**
 * Marks every currently-alive surfel as static, so the baked cache survives while the
 * lifecycle keeps running for everything else.
 *
 * This is the missing half of a baked GI: freezing every pass outright does keep the
 * static cache pristine, but then a movable object standing in shadow receives no
 * indirect light at all and reads as a black hole. Keeping spawn/age/allocate alive
 * lets movers get their own short-lived surfels — and since the bake already covered
 * the static world, the find-missing pass barely requests anything else.
 *
 * UE splits the same way: baked lighting for static surfaces, a runtime path for
 * anything that moves.
 */
export function createSurfelImmortaliser(): {
  run: (renderer: THREE.WebGPURenderer, surfelAttr: THREE.StorageBufferAttribute) => void;
} {
  let computeNode: THREE.ComputeNode | null = null;
  let boundAttr: THREE.StorageBufferAttribute | null = null;

  function run(
    renderer: THREE.WebGPURenderer,
    surfelAttr: THREE.StorageBufferAttribute,
  ): void {
    if (computeNode === null || boundAttr !== surfelAttr) {
      boundAttr = surfelAttr;
      const capacity = surfelAttr.count;
      const surfels = storage(surfelAttr, SurfelStruct, capacity);

      computeNode = Fn(() => {
        const surfel = surfels.element(instanceIndex);
        const age = surfel.get('age');
        // Only touch live surfels; recycled slots carry sentinel ages that the
        // allocator relies on.
        If(int(age).lessThan(int(SURFEL_TTL)), () => {
          age.assign(int(IMMORTAL_AGE));
        });
      })().compute(capacity) as unknown as THREE.ComputeNode;
      computeNode.setName?.('GI / Immortalise baked surfels');
    }

    renderer.compute(computeNode);
  }

  return { run };
}
