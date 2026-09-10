// @ts-nocheck -- based on jure/webgiya, with receiver-aware live coverage repair.
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
  wgslFn,
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
import { resolveIrradiance } from './surfelGIResolvePass';
import { U_OCCLUSION_PARAMS } from './surfelRadialDepth';
import { FADE_FRAMES, RESOLVE_CELL_SCAN_CAP } from './constants';
import { previousReceiverPosition } from './surfelMotion';
import { bindSurfelAnchors } from './surfelAnchors';

export type SurfelFindMissingPass = {
  run: (
    renderer: THREE.WebGPURenderer,
    camera: THREE.PerspectiveCamera,
    gbuffer: { target: THREE.RenderTarget },
    pool: SurfelPool,
    grid: SurfelHashGrid,
    prevCameraPos: THREE.Vector3,
    options?: { hybridLive?: boolean; motion?: any; skipRigid?: boolean; skipUnbound?: boolean },
  ) => { tileCount: number };
  getTileAllocAttr: () => THREE.StorageBufferAttribute | null;
  getCandidatePackedAttr: () => THREE.StorageBufferAttribute | null;
  getTileIrradianceAttr: () => THREE.StorageBufferAttribute | null;
  setDebugPixel: (x: number, y: number) => void;
  getDebugAttr: () => THREE.StorageBufferAttribute | null;
  getShader: (renderer: THREE.WebGPURenderer) => string;
  invalidate: () => void;
  replay: (renderer: THREE.WebGPURenderer) => void;
  inputs: () => { frame: number; offset: number };
};

export function createSurfelFindMissingPass(): SurfelFindMissingPass {
  // --- 1. STATIC UNIFORMS (Defined once) ---
  const U_FRAME = uniform(0);
  const U_HYBRID_LIVE = uniform(0);
  /* @important Gating the screen resolve alone changed the picture and not the frame: spawning,
     ageing and integration all kept running for receivers nobody was reading. The same two masks
     are applied here, where the demand is generated, so switching a receiver class off actually
     stops the work. GI normal alpha: 1 baked, 0 unbound, a negative id for rigid. */
  const U_SKIP_RIGID = uniform(0);
  const U_SKIP_UNBOUND = uniform(0);
  const U_MOTION = uniform(0);
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
  let lastAnchorAttr = null;
  let lastMotionObjects = null;
  let lastGridAttr: THREE.StorageBufferAttribute | null = null;
  let lastTileCount = 0;
  let debugAttr = null;
  const debugPixel = uniform(new THREE.Vector2(-1, -1));

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
    options: { hybridLive?: boolean; motion?: any; skipRigid?: boolean; skipUnbound?: boolean } = {},
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
    U_HYBRID_LIVE.value = options.hybridLive ? 1 : 0;
    U_SKIP_RIGID.value = options.skipRigid ? 1 : 0;
    U_SKIP_UNBOUND.value = options.skipUnbound ? 1 : 0;
    U_MOTION.value = options.motion?.active ? 1 : 0;
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
      pool.getAnchorAttr() !== lastAnchorAttr ||
      lastMotionObjects !== options.motion?.objects ||
      offsetsAndListAttr !== lastGridAttr ||
      tileCount !== lastTileCount
    ) {
      computeNode?.dispose(); computeNode = null;
      lastPoolAttr = poolAttr;
      lastAnchorAttr = pool.getAnchorAttr();
      lastMotionObjects = options.motion?.objects;
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
      const anchors = bindSurfelAnchors(pool);
      const objects = options.motion?.objects;
      const surfelDepth = storage(pool.getSurfelDepthAttr(), 'vec4', pool.getSurfelDepthAttr().count)
        .setAccess('readOnly').setName('surfelDepth');
      // The shared radial-depth WGSL function refers to this named storage binding.
      const includeDepth = wgslFn('fn include_missing_depth() -> i32 { return 0; }', [surfelDepth]);

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
      const debug = debugAttr ? storage(debugAttr, 'vec4', 5) : null;

      const computeLogic = Fn(() => {
        const gx = workgroupId.x.toInt().add(includeDepth());
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
          const valid = depth.greaterThan(1e-6).and(depth.lessThan(0.999))
            .and(U_HYBRID_LIVE.lessThan(0.5).or(texture(texNormal, uv).w.lessThan(0.5)))
            .and(U_SKIP_RIGID.lessThan(0.5).or(texture(texNormal, uv).w.greaterThanEqual(0.0)))
            .and(U_SKIP_UNBOUND.lessThan(0.5).or(texture(texNormal, uv).w.lessThan(0.0).or(texture(texNormal, uv).w.greaterThanEqual(0.5))));

          if (debug) If(px.equal(int(debugPixel.x)).and(py.equal(int(debugPixel.y))), () => {
            debug.element(4).assign(vec4(depth, texture(texNormal, uv).w, U_HYBRID_LIVE, U_MOTION));
          });

          If(valid, () => {
            const viewPosRaw = getViewPosition(uv, depth, U_PROJ_INV);
            const worldPos4 = U_CAM_WORLD.mul(vec4(viewPosRaw, float(1.0)));
            worldPos.assign(worldPos4.xyz);

            const encN = texture(texNormal, uv).xyz;
            normal.assign(encN.mul(2.0).sub(1.0).normalize());

            const pt_depth = viewPosRaw.z.negate();

            // --- Grid Logic ---
            // const pRel = worldPos.sub(U_CAM_POS);
            const owner = texture(texNormal, uv).w.negate().max(0).round().toInt();
            const lookupPosition = objects ? previousReceiverPosition(worldPos, owner, objects) : worldPos;
            const pRelPrev = lookupPosition.sub(U_PREV_GRID_ORIGIN);
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
            const loopCount = min(cnt, U_HYBRID_LIVE.greaterThan(0.5)
              .select(int(RESOLVE_CELL_SCAN_CAP), int(MAX_SURFELS_PER_CELL).mul(2)));

            const totalWeight = float(0).toVar();
            const resolvedWeight = float(0).toVar();
            const pendingWeight = float(0).toVar();
            const liveCount = int(0).toVar();
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

              const anchor = anchors.position(sid);
              const anchorNormal = anchors.normal(sid);
              const anchorValid = anchorNormal.w.equal(posb.w).and(U_MOTION.greaterThan(0.5));
              const previousPos = objects ? previousReceiverPosition(posb.xyz, anchorValid.select(anchor.w, float(0)), objects) : posb.xyz;
              const surfel_pRel = previousPos.sub(U_PREV_GRID_ORIGIN);
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

              const sameOwner = owner.equal(0).or(anchor.w.equal(float(owner)).and(anchorValid));
              const live = U_HYBRID_LIVE.lessThan(0.5).or(packed.get('age').greaterThanEqual(int(0)).and(sameOwner));
              If(live, () => {
                liveCount.addAssign(1);
                totalWeight.addAssign(weight);
                scoringWeight.addAssign(scoreW);
                If(U_HYBRID_LIVE.greaterThan(0.5), () => {
                  const resolved = resolveIrradiance({ sid, worldPos, pixNormal: normal, surfels, moments,
                    U_FRAME, U_MOMENTS_OFFSET: U_OFFSET, U_CAM_POS, U_OCCLUSION_PARAMS, surfelDepth,
                    freshWeight: U_HYBRID_LIVE.div(float(FADE_FRAMES)) });
                  resolvedWeight.addAssign(resolved.w);
                  // Let newly allocated samples finish their fade before deciding
                  // they failed to cover their own patch. Avoid duplicate bursts.
                  If(float(U_FRAME).sub(posb.w).lessThan(float(FADE_FRAMES)), () => {
                    pendingWeight.addAssign(scoreW);
                  });
                });
              });

              // At least 8 frames
              const isMature = float(U_FRAME)
                .sub(posb.w)
                .greaterThanEqual(float(8.0))
                .and(dotN.greaterThan(0.9));

              If(isMature.and(weight.greaterThan(maxParentWeight)), () => {
                bestParentSid.assign(sid);
                maxParentWeight.assign(weight);
              });

              If(live.and(weight.greaterThan(highest)), () => {
                // TODO: Examine difference between assigning in here,
                // and up there.
                // If(isMature, () => {
                //   bestParentSid.assign(sid);
                //   maxParentWeight.assign(weight)
                // })

                second.assign(highest);
                highest.assign(weight);
              }).ElseIf(live.and(weight.greaterThan(second)), () => {
                second.assign(weight);
              });

              // Accumulate irradiance from neighbor surfels so we can
              // seed newly spawned surfels with something better than black.
              let momentsIndex = sid.add(U_OFFSET);
              const surfelIrr = moments.element(momentsIndex).get('irradiance'); // vec4(irrRgb, sampleCount)
              const irrColor = surfelIrr.xyz;
              // This is a low-confidence lighting prior, separate from coverage:
              // pinned parents may seed a child but cannot cover a live receiver.
              accumIrr.addAssign(irrColor.mul(weight));
              accumIrrWeight.addAssign(weight);

              // Keep-alive
              const sameCellKeep = live
                .and(U_HYBRID_LIVE.greaterThan(0.5).or(cnt.lessThanEqual(maxKeepAlive)))
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
              U_HYBRID_LIVE.greaterThan(0.5).select(float(liveCount), float(cnt)),
            );
            const despawnThreshold = mix(float(3.5), float(3.0), fullness);
            const secondThresh = mix(float(0.9), float(0.8), fullness);
            const shouldConsiderDespawn = scoringWeight
              .greaterThan(despawnThreshold)
              .and(second.greaterThan(secondThresh))
              .and(U_HYBRID_LIVE.lessThan(0.5));
            // Geometric overlap alone cannot prove redundancy with radial
            // occlusion. Hybrid removal is left to age/crowding and visibility.

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
            // In hybrid mode repair an actual final-gather hole. Voting bounds work
            // to one new sample per 8x8 tile; static atlas entries cannot block it.
            const hybridHole = resolvedWeight.lessThan(1e-4).and(pendingWeight.lessThan(0.01))
              .and(liveCount.lessThan(int(RESOLVE_CELL_SCAN_CAP)));
            const wantSpawn = valid.and(U_HYBRID_LIVE.greaterThan(0.5)
              .select(hybridHole, gateCoverage.and(randomOk)));

            if (debug) If(px.equal(int(debugPixel.x)).and(py.equal(int(debugPixel.y))), () => {
              debug.element(0).assign(vec4(worldPos, float(owner)));
              debug.element(1).assign(vec4(normal, totalWeight));
              debug.element(2).assign(vec4(resolvedWeight, pendingWeight, float(liveCount), scoringWeight));
              debug.element(3).assign(vec4(wantSpawn.select(1, 0), float(cnt), float(flat), U_FRAME));
            });

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
    setDebugPixel(x, y) {
      if (!debugAttr) { debugAttr = new THREE.StorageBufferAttribute(new Float32Array(20), 4); computeNode?.dispose(); computeNode = null; }
      debugPixel.value.set(x, y);
    },
    getDebugAttr: () => debugAttr,
    getShader: renderer => computeNode ? renderer._nodes.getForCompute(computeNode).computeShader : '',
    invalidate: () => { computeNode?.dispose(); computeNode = null; },
    inputs: () => ({ frame: U_FRAME.value, offset: U_OFFSET.value }),
    replay: renderer => {
      if (computeNode) renderer.compute(computeNode, [Math.ceil(U_SCREEN_SIZE.value.x / GROUP_SIZE_X), Math.ceil(U_SCREEN_SIZE.value.y / GROUP_SIZE_Y), 1]);
    },
  };
}
