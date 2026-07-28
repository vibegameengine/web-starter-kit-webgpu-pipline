// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// surfelFindMissingPass.ts
import * as THREE from 'three/webgpu';
import {
  Fn,
  storage,
  texture,
  float,
  int,
  vec2,
  getViewPosition,
  uniform,
  length,
  max,
  min,
  Loop,
  smoothstep,
  vec3,
  vec4,
  If,
  uint,
  dot,
  abs,
  workgroupBarrier,
  workgroupId,
  localId,
  atomicMin,
  bitAnd,
  bitOr,
  floatBitsToUint,
  atomicStore,
  atomicLoad,
  mix,
  atomicMax,
  workgroupArray,
} from 'three/tsl';
import { SurfelMoments, SurfelStruct, type SurfelPool } from './surfelPool';
import type { SurfelHashGrid } from './surfelHashGrid';

import {
  surfel_pos_to_grid_coord,
  surfel_grid_coord_to_c4,
  surfel_grid_c4_to_hash,
  surfel_radius_for_pos,
  surfel_grid_coord_to_hash,
  snap_to_surfel_grid_origin,
} from './surfelHashGrid';

import { hash1, hash1_mut, hashCombine2, uintToU01Float } from './hashUtils';

import {
  MAX_SURFELS_PER_CELL,
  MAX_SURFELS_PER_CELL_FOR_KEEP_ALIVE,
  OFFSETS_AND_LIST_START,
  SURFEL_KILL_SIGNAL,
  SURFEL_LIFE_RECYCLE,
  SURFEL_RADIUS_OVERSCALE,
} from './constants';
import { SURFEL_NORMAL_DIRECTION_SQUISH } from './constants';
import { pack_vertex, Vertex, VertexPacked } from './vertexPacked';

export type SurfelFindMissingPass = {
  run: (
    renderer: THREE.WebGPURenderer,
    camera: THREE.PerspectiveCamera,
    gbuffer: { target: THREE.RenderTarget },
    pool: SurfelPool,
    grid: SurfelHashGrid,
    prevCameraPos: THREE.Vector3,
  ) => { tileCount: number };
  getTileAllocAttr: () => THREE.StorageBufferAttribute | null;
  getCandidatePackedAttr: () => THREE.StorageBufferAttribute | null;
  getTileIrradianceAttr: () => THREE.StorageBufferAttribute | null;
};

export function createSurfelFindMissingPass(): SurfelFindMissingPass {
  // --- 1. STATIC UNIFORMS (Defined once) ---
  const U_FRAME = uniform(0);
  const U_PROJ_INV = uniform(new THREE.Matrix4());
  const U_CAM_WORLD = uniform(new THREE.Matrix4());
  const U_CAM_POS = uniform(new THREE.Vector3());
  const U_PREV_CAM_POS = uniform(new THREE.Vector3());
  const U_OFFSET = uniform(0);
  const U_PREV_GRID_ORIGIN = uniform(new THREE.Vector3());

  const U_GRID_STRIDE = uniform(1); // Width of grid in tiles
  const U_SCREEN_SIZE = uniform(new THREE.Vector2()); // Resolution

  const GROUP_SIZE_X = 8;
  const GROUP_SIZE_Y = 8;

  // --- 2. STABLE OUTPUT ATTRIBUTES ---
  // We instantiate these once. If we need more space, we replace the .array, not the object.
  const tileAllocAttr = new THREE.StorageBufferAttribute(new Int32Array(2), 1);
  const candPackedAttr = new THREE.StorageBufferAttribute(
    new Float32Array(4),
    4,
  );
  const tileIrradianceAttr = new THREE.StorageBufferAttribute(
    new Float32Array(4),
    4,
  );

  // --- 3. CACHING STATE ---
  let computeNode: any = null;
  let lastPoolAttr: THREE.StorageBufferAttribute | null = null;
  let lastGridAttr: THREE.StorageBufferAttribute | null = null;
  let lastTileCount = 0;

  /**
   * Resizes buffer arrays without breaking the Attribute object reference.
   */
  function ensureTileBuffers(count: number) {
    const needed = Math.max(1, count);

    // 2 ints per tile: [spawnFlag, parentSid]
    if (tileAllocAttr.count < needed * 2) {
      tileAllocAttr.array = new Int32Array(needed * 2);
      // @ts-ignore
      tileAllocAttr.count = needed * 2;
      tileAllocAttr.needsUpdate = true;
    }

    if (candPackedAttr.count < needed) {
      candPackedAttr.array = new Float32Array(needed * 4);
      // @ts-ignore
      candPackedAttr.count = needed;
      candPackedAttr.needsUpdate = true;
    }

    if (tileIrradianceAttr.count < needed) {
      tileIrradianceAttr.array = new Float32Array(needed * 4);
      // @ts-ignore
      tileIrradianceAttr.count = needed;
      tileIrradianceAttr.needsUpdate = true;
    }
  }

  function run(
    renderer: THREE.WebGPURenderer,
    camera: THREE.PerspectiveCamera,
    gbuffer: { target: THREE.RenderTarget },
    pool: SurfelPool,
    grid: SurfelHashGrid,
    prevCameraPos: THREE.Vector3,
  ) {
    const width = gbuffer.target.width;
    const height = gbuffer.target.height;

    const tileW = Math.max(1, Math.ceil(width / GROUP_SIZE_X));
    const tileH = Math.max(1, Math.ceil(height / GROUP_SIZE_Y));
    const tileCount = tileW * tileH;

    // 1. Resize buffers if necessary (preserves attribute object identity)
    ensureTileBuffers(tileCount);

    U_GRID_STRIDE.value = tileW;
    U_SCREEN_SIZE.value.set(width, height);

    // 2. Update Uniforms
    U_FRAME.value = renderer.info.frame;
    U_PROJ_INV.value.copy(camera.projectionMatrixInverse);
    U_CAM_WORLD.value.copy(camera.matrixWorld);
    U_CAM_POS.value.copy(camera.position);
    U_PREV_CAM_POS.value.copy(prevCameraPos);
    const { readOffset } = pool.getOffsets();
    U_OFFSET.value = readOffset;
    snap_to_surfel_grid_origin(U_PREV_GRID_ORIGIN.value, prevCameraPos);

    // Update Texture Uniforms
    const texDepth = gbuffer.target.depthTexture;
    const texNormal = gbuffer.target.textures[0];

    if (!texDepth || !texNormal) return { tileCount: 0 };

    // 3. Dependency Checks for Rebuild
    const poolAttr = pool.getSurfelAttr();
    const momentsAttr = pool.getMomentsAttr();
    const touchedAtomic = pool.getTouched();
    const offsetsAndListAttr = grid.getOffsetsAndListAttr();

    if (!poolAttr || !offsetsAndListAttr || !momentsAttr || !touchedAtomic)
      return { tileCount: 0 };

    // If the Pool or Grid buffers have been swapped (new objects), we must rebuild the graph.
    // This happens rarely (usually only on total resets).
    if (
      poolAttr !== lastPoolAttr ||
      offsetsAndListAttr !== lastGridAttr ||
      tileCount !== lastTileCount
    ) {
      computeNode = null;
      lastPoolAttr = poolAttr;
      lastGridAttr = offsetsAndListAttr;
      lastTileCount = tileCount;
    }

    // 4. Build Shader Graph (Only once, unless invalidated)
    if (!computeNode) {
      const capacity = poolAttr.count;

      // TSL Variable Bindings
      const surfels = storage(poolAttr, SurfelStruct, capacity);
      const offsetsAndList = storage(
        offsetsAndListAttr,
        'int',
        offsetsAndListAttr.count,
      );
      const moments = storage(momentsAttr, SurfelMoments, capacity * 2);

      // Output Bindings
      const tileAlloc = storage(tileAllocAttr, 'int', tileAllocAttr.count);
      const candPacked = storage(
        candPackedAttr,
        VertexPacked,
        candPackedAttr.count,
      );
      const tileIrradiance = storage(
        tileIrradianceAttr,
        'vec4',
        tileIrradianceAttr.count,
      );

      const maxKeepAlive = int(MAX_SURFELS_PER_CELL_FOR_KEEP_ALIVE);

      const computeLogic = Fn(() => {
        const gx = workgroupId.x.toInt();
        const gy = workgroupId.y.toInt();
        const lx = localId.x.toInt();
        const ly = localId.y.toInt();
        const groupSizeX = int(GROUP_SIZE_X);
        const gridWNode = int(U_GRID_STRIDE);

        // groupshared uint gs_px_min_score_loc_packed;
        // groupshared uint gs_px_max_score_loc_packed;
        const gs_px_max_score_loc_packed = workgroupArray('atomic<u32>', 1);
        const gs_px_min_score_loc_packed = workgroupArray('atomic<u32>', 1);

        const laneIndex = ly.mul(groupSizeX).add(lx);
        const tileIndex = gy.mul(gridWNode).add(gx); // Use Uniform for width

        const worldPos = vec3(0).toVar();
        const normal = vec3(0, 0, 1).toVar();
        const flat = int(0).toVar();

        // Accumulated irradiance of nearby surfels for this pixel,
        // later used by the winning spawn lane to seed tileIrradiance.
        const accumIrr = vec3(0).toVar();
        const accumIrrWeight = float(0).toVar();

        // --- Initialization ---
        If(laneIndex.equal(int(0)), () => {
          const base = tileIndex.mul(int(2));
          tileAlloc.element(base).assign(int(0));
          tileAlloc.element(base.add(int(1))).assign(int(0));
          tileIrradiance.element(tileIndex).assign(vec4(0, 0, 0, 0));
          // Reset local voting
          atomicStore(gs_px_max_score_loc_packed.element(int(0)), uint(0));
          atomicStore(
            gs_px_min_score_loc_packed.element(int(0)),
            uint(0xffffffff),
          );
        });

        workgroupBarrier();

        // Dimensions

        const widthF = U_SCREEN_SIZE.x;
        const heightF = U_SCREEN_SIZE.y;
        const widthI = int(widthF);
        const heightI = int(heightF);

        const px = gx.mul(groupSizeX).add(lx);
        const py = gy.mul(int(GROUP_SIZE_Y)).add(ly);
        const pixelInBounds = px.lessThan(widthI).and(py.lessThan(heightI));

        const bestParentSid = int(-1).toVar();
        const maxParentWeight = float(-1.0).toVar();

        If(pixelInBounds, () => {
          const pxF = px.toFloat();
          const pyF = py.toFloat();
          const uv = vec2(
            pxF.add(float(0.5)).div(widthF),
            pyF.add(float(0.5)).div(heightF),
          );

          // --- Random ---
          const seed = hashCombine2(
            hashCombine2(uint(px), hash1(uint(py))),
            uint(U_FRAME),
          ).toVar();

          // --- Texture Read ---
          const depth = texture(texDepth, uv).r;
          const valid = depth.greaterThan(1e-6).and(depth.lessThan(0.999));

          If(valid, () => {
            const viewPosRaw = getViewPosition(uv, depth, U_PROJ_INV);
            const worldPos4 = U_CAM_WORLD.mul(vec4(viewPosRaw, float(1.0)));
            worldPos.assign(worldPos4.xyz);

            const encN = texture(texNormal, uv).xyz;
            normal.assign(encN.mul(2.0).sub(1.0).normalize());

            const pt_depth = viewPosRaw.z.negate();

            // --- Grid Logic ---
            // const pRel = worldPos.sub(U_CAM_POS);
            const pRelPrev = worldPos.sub(U_PREV_GRID_ORIGIN);
            // 1. Calculate the integer grid coordinate relative to camera
            const gridCoord = surfel_pos_to_grid_coord(pRelPrev);

            // 2. Convert to Cascade Coordinate (C4)
            const c4 = surfel_grid_coord_to_c4(gridCoord).toVar();

            // 3. Hash it to get the memory index
            const hash = surfel_grid_c4_to_hash(c4);

            flat.assign(hash.toInt());

            // So after slotting, the layout is:
            // cell_index_offset[i]   = start_i               (i in [0..N-1])
            // cell_index_offset[i+1] = start_{i+1} = start_i + count_i
            const startIdx = offsetsAndList.element(flat);
            const endIdx = offsetsAndList.element(flat.add(int(1)));
            const cnt = endIdx.sub(startIdx).max(int(0));
            const baseIdx = startIdx;
            const loopCount = min(cnt, int(MAX_SURFELS_PER_CELL).mul(2));

            const totalWeight = float(0).toVar();
            const scoringWeight = float(0).toVar();
            const highest = float(0).toVar();
            const second = float(0).toVar();

            Loop(loopCount, ({ i }) => {
              const sid = offsetsAndList.element(
                int(OFFSETS_AND_LIST_START).add(baseIdx).add(i),
              );
              const packed = surfels.element(sid);
              const posb = packed.get('posb');
              const surfelNormal = packed.get('normal');

              const surfel_pRel = posb.xyz.sub(U_PREV_GRID_ORIGIN);
              const surfel_c4_hash = surfel_grid_coord_to_hash(
                surfel_pos_to_grid_coord(surfel_pRel),
              );
              const isSameHash = surfel_c4_hash.equal(hash); // Strict hash check

              const surfelRadius = surfel_radius_for_pos(posb.xyz, U_CAM_POS);
              const posOffset = worldPos.sub(posb.xyz);
              const d = length(posOffset);
              const alignPenalty = abs(dot(posOffset, surfelNormal)).mul(
                SURFEL_NORMAL_DIRECTION_SQUISH,
              );
              const mahal = d.mul(float(1.0).add(alignPenalty));
              const dotN = surfelNormal.dot(normal).max(float(0.0));

              const weight = smoothstep(
                surfelRadius.mul(SURFEL_RADIUS_OVERSCALE),
                float(0.0),
                mahal,
              ).mul(dotN);
              const scoreW = smoothstep(surfelRadius, float(0.0), mahal).mul(
                dotN,
              );

              totalWeight.addAssign(weight);
              scoringWeight.addAssign(scoreW);

              // At least 8 frames
              const isMature = float(U_FRAME)
                .sub(posb.w)
                .greaterThanEqual(float(8.0))
                .and(dotN.greaterThan(0.9));

              If(isMature.and(weight.greaterThan(maxParentWeight)), () => {
                bestParentSid.assign(sid);
                maxParentWeight.assign(weight);
              });

              If(weight.greaterThan(highest), () => {
                // TODO: Examine difference between assigning in here,
                // and up there.
                // If(isMature, () => {
                //   bestParentSid.assign(sid);
                //   maxParentWeight.assign(weight)
                // })

                second.assign(highest);
                highest.assign(weight);
              }).ElseIf(weight.greaterThan(second), () => {
                second.assign(weight);
              });

              // Accumulate irradiance from neighbor surfels so we can
              // seed newly spawned surfels with something better than black.
              let momentsIndex = sid.add(U_OFFSET);
              const surfelIrr = moments.element(momentsIndex).get('irradiance'); // vec4(irrRgb, sampleCount)
              const irrColor = surfelIrr.xyz;
              // Use the same geometric weight as coverage so bright neighbors
              // contribute proportionally.
              accumIrr.addAssign(irrColor.mul(weight));
              accumIrrWeight.addAssign(weight);

              // Keep-alive
              const sameCellKeep = cnt
                .lessThanEqual(maxKeepAlive)
                .and(dotN.greaterThan(float(0.8)))
                .and(isSameHash);
              const lifeVal = surfels.element(sid).get('age');
              const isRecycle = lifeVal.equal(int(SURFEL_LIFE_RECYCLE));
              // Only reset if not flagged for recycle
              If(sameCellKeep.and(isRecycle.not()), () => {
                atomicMax(touchedAtomic.element(sid), int(5));
              });
              // If(sameCellKeep.and(isRecycle.not()), () => {
              // lifeVal.assign(int(1));
              // });
            });

            // Despawn Logic
            const fullness = smoothstep(
              float(maxKeepAlive).mul(0.75),
              float(maxKeepAlive).mul(1.0),
              float(cnt),
            );
            const despawnThreshold = mix(float(3.5), float(3.0), fullness);
            const secondThresh = mix(float(0.9), float(0.8), fullness);
            const shouldConsiderDespawn = scoringWeight
              .greaterThan(despawnThreshold)
              .and(second.greaterThan(secondThresh));

            If(shouldConsiderDespawn, () => {
              // Pack score + lane index
              const scoreBits = floatBitsToUint(scoringWeight);
              const packedVote = bitOr(
                bitAnd(scoreBits, uint(0xffffffc0)), // keep score in high bits
                uint(laneIndex), // store laneIndex in low 6 bits
              );
              atomicMax(gs_px_max_score_loc_packed.element(int(0)), packedVote);
            });

            // Spawn Logic
            const depthWeight = pt_depth.div(float(64)); //.clamp(float(0), float(1));
            const probMult = float(5000);
            const prob = probMult
              .mul(depthWeight)
              .mul(widthF.reciprocal())
              .mul(heightF.reciprocal());
            const randomOk = uintToU01Float(hash1_mut(seed)).lessThan(prob);
            const gateCoverage = second
              .lessThan(float(0.4))
              .and(scoringWeight.lessThan(float(0.1)))
              .and(cnt.lessThan(maxKeepAlive));
            // const gateCoverage = cnt.lessThan(maxKeepAlive);
            const wantSpawn = valid.and(gateCoverage).and(randomOk);

            If(wantSpawn, () => {
              const scoreAsUint = floatBitsToUint(totalWeight);
              const packedVal = bitOr(
                bitAnd(scoreAsUint, uint(0xffffffc0)),
                uint(laneIndex),
              );
              atomicMin(gs_px_min_score_loc_packed.element(int(0)), packedVal);
            });
          });
        });

        workgroupBarrier();

        // --- Execute Despawn (Winner takes action) ---
        const maxScorePacked = atomicLoad(
          gs_px_max_score_loc_packed.element(int(0)),
        );
        If(maxScorePacked.notEqual(uint(0)), () => {
          // Check if I am the winner
          const winningLane = bitAnd(maxScorePacked, uint(63)).toInt();

          // The winner must re-iterate to find the victim
          If(laneIndex.equal(winningLane), () => {
            const victimIdx = int(-1).toVar();
            const maxVictimWeight = float(-1).toVar();

            // Re-run the loop for this specific pixel to find the heaviest surfel
            const startIdx = offsetsAndList.element(flat);
            const endIdx = offsetsAndList.element(flat.add(int(1)));
            const cnt = endIdx.sub(startIdx).max(int(0));
            const loopCount = min(cnt, int(MAX_SURFELS_PER_CELL).mul(2));

            Loop(loopCount, ({ i }) => {
              const sid = offsetsAndList.element(
                int(OFFSETS_AND_LIST_START).add(startIdx).add(i),
              );
              const packed = surfels.element(sid);
              const posb = packed.get('posb');
              const surfelNormal = packed.get('normal');

              // Re-calculate weight logic (copy-paste of weight logic above)
              const surfelRadius = surfel_radius_for_pos(posb.xyz, U_CAM_POS);
              const posOffset = worldPos.sub(posb.xyz);

              const d = length(posOffset);
              const alignPenalty = abs(dot(posOffset, surfelNormal)).mul(
                SURFEL_NORMAL_DIRECTION_SQUISH,
              );
              const mahal = d.mul(float(1.0).add(alignPenalty));

              // Directional weight for despawn uses pixel normal vs surfel normal
              const dirW = max(float(0.0), dot(surfelNormal, normal));

              const w = smoothstep(
                surfelRadius.mul(SURFEL_RADIUS_OVERSCALE),
                float(0.0),
                mahal,
              ).mul(dirW);

              If(w.greaterThanEqual(maxVictimWeight), () => {
                maxVictimWeight.assign(w);
                victimIdx.assign(sid);
              });
            });

            // Kill the victim
            If(victimIdx.notEqual(int(-1)), () => {
              atomicMax(
                touchedAtomic.element(victimIdx),
                int(SURFEL_KILL_SIGNAL),
              );
            });
          });
        });

        // Spawn execute
        const bestPacked = atomicLoad(
          gs_px_min_score_loc_packed.element(int(0)),
        );
        If(bestPacked.notEqual(uint(0xffffffff)), () => {
          const winningLaneIndex = bitAnd(bestPacked, uint(63)).toInt();
          If(laneIndex.equal(winningLaneIndex), () => {
            const base = tileIndex.mul(int(2));
            tileAlloc.element(base).assign(int(1));
            // Write best parent surfel ID, used to copy its guides
            tileAlloc.element(base.add(int(1))).assign(bestParentSid);

            const vertex = Vertex({ position: worldPos.xyz, normal: normal });
            //  const vertex = Vertex({ position: surfel_grid_coord_center(c4, U_CAM_POS).xyz, normal: vec3(normal.x, normal.y, normal.z)})
            const vertexPacked = pack_vertex(vertex);
            candPacked.element(tileIndex).assign(vertexPacked);

            // Winning lane also writes a per-tile irradiance estimate
            // so that the allocator can seed the new surfel with something
            // close to its neighbors instead of black.
            If(accumIrrWeight.greaterThan(float(1e-5)), () => {
              const avgIrr = accumIrr.div(accumIrrWeight);
              const initSamples = accumIrrWeight; // treat this as one "virtual" sample
              tileIrradiance
                .element(tileIndex)
                .assign(vec4(avgIrr, initSamples));
            });
          });
        });
      });

      computeNode = computeLogic()
        .computeKernel([GROUP_SIZE_X, GROUP_SIZE_Y, 1])
        .setName('Surfel Find Missing');

      // // Store width to detect resizing logic if we want to force rebuild on resize
      // (computeNode as any).userData = { w: width, h: height };
    }

    // Handling Window Resize:
    // If dimensions change, we might want to rebuild IF the baked floats (widthF) were crucial.
    // For best performance, update the Uniform U_GRID_WIDTH used above.
    // However, TSL `float(width)` bakes the value. If width changes, we need to update.
    // if ((computeNode as any).userData.w !== width || (computeNode as any).userData.h !== height) {
    //     // Dimensions changed, rebuild graph (this is acceptable as resize is rare)
    //     computeNode = null;
    //     // Recursive call to rebuild
    //     return run(renderer, camera, gbuffer, pool, grid);
    // }

    renderer.compute(computeNode, [tileW, tileH, 1]);

    return { tileCount };
  }

  return {
    run,
    getTileAllocAttr: () => tileAllocAttr,
    getCandidatePackedAttr: () => candPackedAttr,
    getTileIrradianceAttr: () => tileIrradianceAttr,
  };
}
