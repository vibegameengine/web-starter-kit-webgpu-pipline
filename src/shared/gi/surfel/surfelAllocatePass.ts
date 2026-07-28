// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// surfelAllocatePass.ts
import * as THREE from 'three/webgpu';
import {
  Fn,
  storage,
  int,
  instanceIndex,
  atomicAdd,
  atomicMax,
  atomicStore,
  float,
  vec4,
  If,
  uniform,
  min,
  normalize,
  Loop,
  vec3,
} from 'three/tsl';
import type { SurfelPool } from './surfelPool';
import { SurfelMoments, SurfelStruct } from './surfelPool';
import type { SurfelFindMissingPass } from './surfelFindMissingPass';
import { unpack_vertex, VertexPacked } from './vertexPacked';
import { SLG_TOTAL_FLOATS, SURFEL_DEPTH_TEXELS } from './constants';

export type SurfelAllocatePass = {
  run: (
    renderer: THREE.WebGPURenderer,
    pool: SurfelPool,
    find: SurfelFindMissingPass,
    tileCount: number,
  ) => void;
};

/**
 * Consumes per-tile spawn requests produced by SurfelFindMissingPass
 * and allocates surfels from the pool stack (matches allocate_surfels.hlsl shape).
 */
export function createSurfelAllocatePass(): SurfelAllocatePass {
  let computeNode: THREE.ComputeNode | null = null;
  let lastCandVersion = -1;
  let syncComputeNode: THREE.ComputeNode;
  let lastTileAllocAttr = -1;
  let lastTileCount = -1;

  const U_READ_OFFSET = uniform(0);
  const U_WRITE_OFFSET = uniform(0);
  const U_FRAME = uniform(0);

  function run(
    renderer: THREE.WebGPURenderer,
    pool: SurfelPool,
    find: SurfelFindMissingPass,
    tileCount: number,
  ) {
    if (tileCount <= 0) return;
    const poolAlloc = pool.getPoolAllocAtomic();
    const poolMax = pool.getPoolMaxAtomic();
    const poolAttr = pool.getPoolAttr(); // surfel_pool_buf equivalent
    const surfelAttr = pool.getSurfelAttr();
    const momentsAttr = pool.getMomentsAttr();
    const guidingAttr = pool.getGuidingAttr();
    const surfelDepthAttr = pool.getSurfelDepthAttr();
    const tileAllocAttr = find.getTileAllocAttr();
    const candPackedAttr = find.getCandidatePackedAttr();
    const tileIrradianceAttr = find.getTileIrradianceAttr();

    if (
      !poolAlloc ||
      !poolMax ||
      !poolAttr ||
      !surfelAttr ||
      !tileAllocAttr ||
      !candPackedAttr ||
      !momentsAttr ||
      !tileIrradianceAttr ||
      !guidingAttr ||
      !surfelDepthAttr
    )
      return;

    const capacity = surfelAttr.count;
    const poolBuf = storage(poolAttr, 'int', capacity);
    const surfels = storage(surfelAttr, SurfelStruct, capacity);
    const tileAlloc = storage(tileAllocAttr, 'int', tileAllocAttr.count);
    const moments = storage(momentsAttr, SurfelMoments, capacity * 2);
    const guiding = storage(guidingAttr, 'float', guidingAttr.count);
    const surfelDepth = storage(surfelDepthAttr, 'vec4', surfelDepthAttr.count);
    const tileIrradiance = storage(
      tileIrradianceAttr,
      'vec4',
      tileIrradianceAttr.count,
    );
    const candPacked = storage(candPackedAttr, VertexPacked, tileCount);

    const { readOffset, writeOffset } = pool.getOffsets();
    U_READ_OFFSET.value = readOffset;
    U_WRITE_OFFSET.value = writeOffset;
    U_FRAME.value = renderer.info.frame;

    if (
      tileAllocAttr.version !== lastTileAllocAttr ||
      candPackedAttr.version !== lastCandVersion ||
      lastTileCount !== tileCount
    ) {
      computeNode = null; // Force rebuild
      lastTileAllocAttr = tileAllocAttr.version;
      lastCandVersion = candPackedAttr.version;
      lastTileCount = tileCount;
      console.log('AllocatePass: Rebuilding due to buffer update');
    }

    if (!computeNode) {
      computeNode = Fn(() => {
        const idx = int(instanceIndex);
        const base = idx.mul(int(2));

        // 1. Check if we need to spawn assuming spawnFlag > 0 means we need to allocate
        const spawnFlag = tileAlloc.element(base);
        const needsAlloc = spawnFlag.equal(int(1));

        If(needsAlloc, () => {
          // 3. Increment Alloc Counter (Matches InterlockedAdd)
          const prevAlloc = atomicAdd(poolAlloc.element(0), int(1));

          // Safety: Prevent overflow
          const withinCap = prevAlloc.lessThan(int(capacity));

          If(withinCap, () => {
            // 4. Read the Surfel ID from the stack
            const stackIdx = prevAlloc;
            const surfelIdx = poolBuf.element(stackIdx);

            // 5. Update High Water Mark
            atomicMax(poolMax.element(0), surfelIdx.add(int(1)));

            // 6. Write Data (Matches surfel_spatial_buf assignment)
            //    Since we are inside the If, no other thread is touching this surfelIdx
            const candidate = unpack_vertex(candPacked.element(idx));

            const surfel = surfels.element(surfelIdx);
            surfel
              .get('posb')
              .assign(vec4(candidate.get('position'), float(U_FRAME)));
            surfel.get('normal').assign(normalize(candidate.get('normal')));
            surfel.get('age').assign(int(0)); // Reset age

            // ----------------------------------------------------------
            // [RADIAL DEPTH] Clear this surfel's 4x4 tile in the buffer
            // ----------------------------------------------------------
            const tileTexels = int(SURFEL_DEPTH_TEXELS * SURFEL_DEPTH_TEXELS);
            const depthBase = surfelIdx.mul(tileTexels);

            Loop(tileTexels, ({ i }) => {
              surfelDepth.element(depthBase.add(i)).assign(vec4(0.0, 0.0, 0.0, 0.0));
            });

            // Read the Parent ID (passed from FindMissing)
            const parentSid = tileAlloc.element(base.add(int(1)));
            const validSid = parentSid
              .greaterThanEqual(int(0))
              .and(parentSid.lessThan(int(capacity)));

            If(validSid, () => {
              const parentSurfel = surfels.element(parentSid);
              const dotNCheck = parentSurfel
                .get('normal')
                .dot(surfel.get('normal'))
                .greaterThan(0.95);

              If(dotNCheck, () => {
                // B. Brain Transplant (Copy SLG Weights)
                // Copy 72 floats to give the new surfel the parent's knowledge of light direction.
                const parentBase = parentSid.mul(int(SLG_TOTAL_FLOATS));
                const childBase = surfelIdx.mul(int(SLG_TOTAL_FLOATS));

                Loop(int(SLG_TOTAL_FLOATS), ({ i }) => {
                  guiding
                    .element(childBase.add(i))
                    .assign(guiding.element(parentBase.add(i)));
                });

                // C. Memory Transplant (Irradiance)
                // Use the weighted average computed in FindMissing (tileIrradiance)
                const tileGI = tileIrradiance.element(idx);

                const targetIdx = surfelIdx.add(U_READ_OFFSET); // Write to 'Read' so Integrator sees it immediately
                const parentIdx = parentSid.add(U_READ_OFFSET);

                // Initialize Irradiance
                // MSME Mean = tileGI.xyz
                const parentCount = moments
                  .element(parentIdx)
                  .get('irradiance').w;
                const priorCount = min(parentCount, float(4.0)); // 4–16 is a good range

                moments
                  .element(targetIdx)
                  .get('irradiance')
                  .assign(vec4(tileGI.xyz, priorCount));

                // Initialize MSME Short Mean (same as mean initially)
                // VBBR = 0.0 (will learn) or 1.0 (accept all).
                moments
                  .element(targetIdx)
                  .get('msmeData0')
                  .assign(vec4(tileGI.xyz, float(1.0)));

                // Initialize Variance & Inconsistency
                // Variance = High (1.0) to allow initial rapid change
                // Inconsistency = 1.0 (Very inconsistent) to force rapid catch-up in first frames
                moments
                  .element(targetIdx)
                  .get('msmeData1')
                  .assign(vec4(1.0, 1.0, 1.0, 1.0));
              }).Else(() => {
                // --- FALLBACK (Cold Start) ---
                // surfel.get('age').assign(int(0));

                // Zero out SLG weights
                const childBase = surfelIdx.mul(int(SLG_TOTAL_FLOATS));
                Loop(int(SLG_TOTAL_FLOATS), ({ i }) => {
                  guiding.element(childBase.add(i)).assign(0.0);
                });

                // Initialize with Tile Average (Low Confidence)
                const tileGI = tileIrradiance.element(idx);
                const targetIdx = surfelIdx.add(U_READ_OFFSET); // Write to 'Read' so Integrator sees it immediately

                // MSME Mean = tileGI.xyz
                moments
                  .element(targetIdx)
                  .get('irradiance')
                  .assign(vec4(tileGI.xyz, float(1.0)));

                // Initialize MSME Short Mean (same as mean initially)
                // VBBR = 0.0 (will learn) or 1.0 (accept all).
                moments
                  .element(targetIdx)
                  .get('msmeData0')
                  .assign(vec4(tileGI.xyz, float(1.0)));

                // Initialize Variance & Inconsistency
                // Variance = High (1.0) to allow initial rapid change
                // Inconsistency = 1.0 (Very inconsistent) to force rapid catch-up in first frames
                moments
                  .element(targetIdx)
                  .get('msmeData1')
                  .assign(vec4(1.0, 1.0, 1.0, 1.0));
              });
            }).Else(() => {
              // Cold Start if parent is not there, same as above
              // surfel.get('age').assign(int(0));
              const childBase = surfelIdx.mul(int(SLG_TOTAL_FLOATS));
              Loop(int(SLG_TOTAL_FLOATS), ({ i }) => {
                guiding.element(childBase.add(i)).assign(0.0);
              });
              const tileGI = tileIrradiance.element(idx);
              const targetIdx = surfelIdx.add(U_READ_OFFSET); // Write to 'Read' so Integrator sees it immediately
              moments
                .element(targetIdx)
                .get('irradiance')
                .assign(vec4(tileGI.xyz, float(1.0)));
              moments
                .element(targetIdx)
                .get('msmeData0')
                .assign(vec4(tileGI.xyz, float(1.0)));
              moments
                .element(targetIdx)
                .get('msmeData1')
                .assign(vec4(1.0, 1.0, 1.0, 1.0));
            });

          }).Else(() => {
            // Revert counter if we overflowed (Cleanup)
            atomicAdd(poolAlloc.element(0), int(-1));
          })
        });
      })()
        .compute(Math.max(1, tileCount))
        .setName('Surfel Allocate');
    }
    renderer.compute(computeNode);

    if (!syncComputeNode) {
      syncComputeNode = Fn(() => {
        const allocNow = atomicAdd(poolAlloc.element(0), int(0));
        atomicStore(pool.getAliveAtomic().element(0), allocNow);
      })()
        .compute(1)
        .setName('Surfel Allocate Alive Sync');
    }
    // Sync alive counter
    renderer.compute(syncComputeNode);
  }

  return { run };
}
