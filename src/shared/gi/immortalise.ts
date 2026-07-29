import * as THREE from 'three/webgpu';
import { Fn, If, float, instanceIndex, int, storage, uint, uniform } from 'three/tsl';
import { SURFEL_TTL, TARGET_SAMPLE_COUNT } from './surfel/constants.ts';
import { SurfelMoments, SurfelStruct, type SurfelPool } from './surfel/surfelPool.ts';

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
/**
 * Sample count a surfel must have reached before it may be pinned.
 *
 * Pinning is not free: a pinned surfel occupies its hash-grid cell forever, and
 * `surfelFindMissingPass` treats an occupied cell as covered. Pin one that never
 * converged and the cell is permanently held by a surfel whose resolve weight is
 * zero (`conf = samples / TARGET_SAMPLE_COUNT` in surfelGIResolvePass) — so the
 * pixel gathers nothing, no replacement is ever requested, and the spot renders as
 * a black square for the rest of the session. That failure was visible on the back
 * wall the moment pinning started working at all.
 *
 * Matching the resolve's own confidence target means every pinned surfel resolves
 * at full weight, and everything short of it stays on the normal lifecycle: it
 * either converges and gets pinned by the next bake, or ages out and is respawned.
 */
const MIN_PIN_SAMPLES = TARGET_SAMPLE_COUNT;

export function createSurfelImmortaliser(): {
  run: (renderer: THREE.WebGPURenderer, pool: SurfelPool) => void;
} {
  let computeNode: THREE.ComputeNode | null = null;
  let boundAttr: THREE.StorageBufferAttribute | null = null;
  const U_READ_OFFSET = uniform(0);

  function run(renderer: THREE.WebGPURenderer, pool: SurfelPool): void {
    const surfelAttr = pool.getSurfelAttr();
    const momentsAttr = pool.getMomentsAttr();
    if (!surfelAttr || !momentsAttr) return;

    if (computeNode === null || boundAttr !== surfelAttr) {
      boundAttr = surfelAttr;
      const capacity = surfelAttr.count;
      const surfels = storage(surfelAttr, SurfelStruct, capacity);
      const moments = storage(momentsAttr, SurfelMoments, capacity * 2).setAccess(
        'readOnly',
      );

      computeNode = Fn(() => {
        const surfel = surfels.element(instanceIndex);
        const age = surfel.get('age');
        // irradiance.w is the MSME sample count — the same number the resolve
        // divides by TARGET_SAMPLE_COUNT to get its confidence weight.
        const samples = moments
          .element(uint(instanceIndex).add(uint(U_READ_OFFSET)))
          .get('irradiance').w;

        // Only touch live *and converged* surfels; recycled slots carry sentinel
        // ages that the allocator relies on.
        If(
          int(age)
            .lessThan(int(SURFEL_TTL))
            .and(int(age).greaterThanEqual(int(0)))
            .and(samples.greaterThanEqual(float(MIN_PIN_SAMPLES))),
          () => {
            age.assign(int(IMMORTAL_AGE));
          },
        );
      })().compute(capacity) as unknown as THREE.ComputeNode;
      computeNode.setName?.('GI / Immortalise baked surfels');
    }

    // The bake loop swaps moments at the end of every iteration, so the converged
    // half is the one the *next* integration would read. Same reasoning as
    // bake/lightmapSurfels.ts:writeAtlas.
    U_READ_OFFSET.value = pool.getOffsets().readOffset;
    renderer.compute(computeNode);
  }

  return { run };
}
