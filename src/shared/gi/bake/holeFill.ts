// @ts-nocheck -- pool and grid manipulation in TSL, mirroring surfelFindMissingPass /
// surfelAllocatePass. Kept structurally parallel to those two on purpose: see below.
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  abs,
  atomicAdd,
  atomicMax,
  cross,
  dot,
  float,
  instanceIndex,
  instancedArray,
  int,
  length,
  max,
  min,
  normalize,
  select,
  smoothstep,
  storage,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

import {
  MAX_SURFELS_PER_CELL,
  MAX_SURFELS_PER_CELL_FOR_KEEP_ALIVE,
  OFFSETS_AND_LIST_START,
  SLG_TOTAL_FLOATS,
  SURFEL_BASE_RADIUS,
  SURFEL_DEPTH_TEXELS,
  SURFEL_NORMAL_DIRECTION_SQUISH,
  SURFEL_RADIUS_OVERSCALE,
} from '../surfel/constants.ts';
import { hash1, hash1_mut, hashCombine2, uintToU01Float } from '../surfel/hashUtils.ts';
import {
  SurfelMoments,
  SurfelStruct,
  type SurfelPool,
} from '../surfel/surfelPool.ts';
import {
  snap_to_surfel_grid_origin,
  surfel_grid_c4_to_hash,
  surfel_grid_coord_to_c4,
  surfel_pos_to_grid_coord,
  surfel_radius_for_pos,
  type SurfelHashGrid,
} from '../surfel/surfelHashGrid.ts';
import type { GeometrySurfelSeeds } from './geometrySurfels.ts';

const DEPTH_TILE = SURFEL_DEPTH_TEXELS * SURFEL_DEPTH_TEXELS;

/**
 * Spawns surfels on static geometry that the bake's cameras never managed to see.
 *
 * The defect this exists for is a property of where surfels come from, not of how long
 * they are integrated. `surfelFindMissingPass` spawns from the screen G-Buffer, so
 * coverage of the cache is a visibility query, and a camera cannot see into a concave
 * corner. The bake sweeps an orbit camera to compensate and does not reach: measured on
 * the Cornell box with the probe tier off, the trihedral corner where the back wall
 * meets the ceiling and the green wall reads `[2.5,4.1,2.9]` and `[0,0,0]` across two
 * identical 6 s bakes. Screen probes paint over it, so the default frame looks fine —
 * but everything that reads the cache directly (the far field of the probe trace, the
 * lightmap bake, the multi-bounce `lookupSurfelGI` inside the integrator) still reads a
 * hole, and a hole that only closes by spending more views is not a bake.
 *
 * The previous attempt at this — `geometrySurfels.ts`, `?geoseed=1` — placed surfels by
 * walking the geometry, which is the right idea, and then *replaced* the orbit sweep
 * with them entirely (`surfelGI.bake` still branches that way). That is the part that
 * failed. With no find-missing in the loop the cache is whatever a uniform 0.3 m
 * area-sampling happens to produce, with no view-driven refinement anywhere, and
 * measured against the same crop it turns the wedge into a black rectangle four times
 * the size: the acceptance patch reads `[75.5,91.4,77.1]` on the orbit sweep and
 * `[0,0,0]` with geoseed on, while the red wall, green wall and floor controls all move
 * under 4 units. Whatever is wrong with placing every surfel from geometry, it is not
 * something more bake time fixes — all 5,085 seeds reached the pin threshold.
 *
 * So this pass is deliberately not that. It supplements find-missing instead of standing
 * in for it, and the mechanism by which it cannot compete is that it asks find-missing's
 * own question with find-missing's own arithmetic: same hash cell, same Mahalanobis
 * squish, same `SURFEL_RADIUS_OVERSCALE` split between the loose `weight` and the tight
 * `scoringWeight`, same three gates. A candidate point where find-missing would decline
 * to spawn is a candidate this declines to spawn. The only difference is where the
 * question is asked from — a triangle rather than a pixel — so the only points it can
 * ever act on are the ones no pixel reached. Everything the sweep already covered is
 * left exactly as the sweep left it.
 *
 * That also bounds the cost, which the geoseed attempt did not. Seeding every surface
 * spends 5,085 slots on the Cornell box; filling only what the sweep missed spends the
 * corners.
 */
export type SurfelHoleFill = {
  /**
   * One fill sweep. Must be called *after* `grid.build` for this frame, because the
   * coverage query reads the offsets the grid's slot pass has just finished writing.
   */
  fill: (
    renderer: THREE.WebGPURenderer,
    pool: SurfelPool,
    grid: SurfelHashGrid,
    camera: THREE.Camera,
  ) => void;
  /**
   * Holds everything this pass has spawned at age zero for one more frame.
   *
   * Not optional, and not something the age pass can be asked for by other means. A
   * surfel in a concave corner is by construction one that no pixel sees, so
   * find-missing's keep-alive never touches it, so it accrues the +1/frame base
   * metabolism and is recycled at `SURFEL_TTL`. At 6 s and ~645 frames a surfel spawned
   * a third of the way in would end the bake at age ~430 and survive by luck; at
   * `?bake=20000` it would be recycled before the bake finished, and the fix would look
   * like it depended on a small budget. Paying one income unit per frame cancels the
   * metabolism exactly, and leaves crowding rent untouched — an over-full cell still
   * evicts, which is the pressure that stops the population running away.
   */
  keepAlive: (renderer: THREE.WebGPURenderer) => void;
  /** Surfels spawned so far, read back off the GPU. For the bake's log line. */
  readSpawned: (renderer: THREE.WebGPURenderer) => Promise<number>;
  candidates: number;
};

export function createSurfelHoleFill(
  seeds: GeometrySurfelSeeds,
  options: { coverage?: number; rate?: number; edge?: number } = {},
): SurfelHoleFill {
  // `coverage` is find-missing's own spawn threshold. Exposed so it can be moved from a
  // URL while being measured, but the default is not a tuning parameter — it is the
  // number the pass this supplements uses to decide the same thing.
  //
  // `rate` is the fraction of candidates tested per dispatch and `edge` is how covered
  // a neighbouring point must be before this one counts as the boundary of a hole
  // rather than as open country. Both are here to be ablated, not tuned: see the notes
  // in the shader for what each of them is preventing.
  const { coverage = 0.1, rate = 0.1, edge = 0.5 } = options;

  const capacityHint = Math.max(1, seeds.count);

  const seedPos = new THREE.StorageBufferAttribute(
    new Float32Array(capacityHint * 4),
    4,
  );
  const seedNor = new THREE.StorageBufferAttribute(
    new Float32Array(capacityHint * 4),
    4,
  );
  for (let i = 0; i < seeds.count; i++) {
    (seedPos.array as Float32Array)[i * 4 + 0] = seeds.positions[i * 3 + 0];
    (seedPos.array as Float32Array)[i * 4 + 1] = seeds.positions[i * 3 + 1];
    (seedPos.array as Float32Array)[i * 4 + 2] = seeds.positions[i * 3 + 2];
    (seedNor.array as Float32Array)[i * 4 + 0] = seeds.normals[i * 3 + 0];
    (seedNor.array as Float32Array)[i * 4 + 1] = seeds.normals[i * 3 + 1];
    (seedNor.array as Float32Array)[i * 4 + 2] = seeds.normals[i * 3 + 2];
  }
  seedPos.needsUpdate = true;
  seedNor.needsUpdate = true;

  // The sids this pass has handed out, so `keepAlive` can pay rent on exactly those and
  // on nothing else. Keeping every static surfel alive instead would work on the Cornell
  // box and quietly turn the bake into geoseed on a landscape.
  const spawnListAttr = new THREE.StorageBufferAttribute(
    new Int32Array(capacityHint),
    1,
  );
  const spawnCount = instancedArray(new Int32Array(1), 'int').toAtomic();

  const U_FRAME = uniform(0);
  const U_CAM_POS = uniform(new THREE.Vector3());
  const U_GRID_ORIGIN = uniform(new THREE.Vector3());
  const U_SEED_COUNT = uniform(seeds.count);
  const U_RATE = uniform(rate);
  const U_EDGE = uniform(edge);

  let fillNode: THREE.ComputeNode | null = null;
  let keepAliveNode: THREE.ComputeNode | null = null;
  let boundSurfelAttr: THREE.StorageBufferAttribute | null = null;
  let boundGridAttr: THREE.StorageBufferAttribute | null = null;

  function fill(
    renderer: THREE.WebGPURenderer,
    pool: SurfelPool,
    grid: SurfelHashGrid,
    camera: THREE.Camera,
  ): void {
    const surfelAttr = pool.getSurfelAttr();
    const poolAttr = pool.getPoolAttr();
    const momentsAttr = pool.getMomentsAttr();
    const guidingAttr = pool.getGuidingAttr();
    const surfelDepthAttr = pool.getSurfelDepthAttr();
    const poolAlloc = pool.getPoolAllocAtomic();
    const poolMax = pool.getPoolMaxAtomic();
    const offsetsAndListAttr = grid.getOffsetsAndListAttr();
    if (
      !surfelAttr ||
      !poolAttr ||
      !momentsAttr ||
      !guidingAttr ||
      !surfelDepthAttr ||
      !poolAlloc ||
      !poolMax ||
      !offsetsAndListAttr
    ) {
      return;
    }

    // Pool growth replaces every attribute and rebakes `capacity` into the WGSL as a
    // literal; a node built against the old ones is pointing at dead memory.
    if (surfelAttr !== boundSurfelAttr || offsetsAndListAttr !== boundGridAttr) {
      fillNode = null;
      keepAliveNode = null;
      boundSurfelAttr = surfelAttr;
      boundGridAttr = offsetsAndListAttr;
    }

    U_FRAME.value = renderer.info.frame;
    U_CAM_POS.value.copy(camera.position);
    // The grid was built around this camera one step ago in the frame, so this is the
    // origin its cell indices are expressed in. find-missing uses the *previous* camera
    // for the same reason inverted: it runs before the rebuild and the grid it reads is
    // a frame old.
    snap_to_surfel_grid_origin(U_GRID_ORIGIN.value, camera.position);

    if (!fillNode) {
      const capacity = surfelAttr.count;
      const surfels = storage(surfelAttr, SurfelStruct, capacity);
      const poolBuf = storage(poolAttr, 'int', capacity);
      const moments = storage(momentsAttr, SurfelMoments, capacity * 2);
      const guiding = storage(guidingAttr, 'float', guidingAttr.count);
      const surfelDepth = storage(surfelDepthAttr, 'vec4', surfelDepthAttr.count);
      const offsetsAndList = storage(
        offsetsAndListAttr,
        'int',
        offsetsAndListAttr.count,
      ).toReadOnly();
      const posBuf = storage(seedPos, 'vec4', capacityHint);
      const norBuf = storage(seedNor, 'vec4', capacityHint);
      const spawnList = storage(spawnListAttr, 'int', capacityHint);

      /**
       * find-missing's coverage question, asked at an arbitrary world point.
       *
       * Returns `vec3(scoringWeight, second, cellCount)` — the tight-radius sum, the
       * second-heaviest loose-radius weight, and how full the cell is. All three are
       * the quantities `surfelFindMissingPass` gates its own spawn on, computed the
       * same way, because a candidate this pass acts on must be one that pass would
       * have acted on had a pixel ever landed there. Reproduced rather than shared:
       * find-missing is vendored byte-compatible with upstream and factoring the loop
       * out of it would be a merge conflict on every upstream fix.
       */
      const coverageAt = Fn(([point, pointNormal]) => {
        const pRel = point.sub(U_GRID_ORIGIN);
        const c4 = surfel_grid_coord_to_c4(surfel_pos_to_grid_coord(pRel));
        const flat = surfel_grid_c4_to_hash(c4).toInt();

        const startIdx = offsetsAndList.element(flat);
        const endIdx = offsetsAndList.element(flat.add(int(1)));
        const cnt = endIdx.sub(startIdx).max(int(0));
        const loopCount = min(cnt, int(MAX_SURFELS_PER_CELL).mul(2));

        const scoringWeight = float(0).toVar();
        const highest = float(0).toVar();
        const second = float(0).toVar();

        Loop(loopCount, ({ i }) => {
          const sid = offsetsAndList.element(
            int(OFFSETS_AND_LIST_START).add(startIdx).add(i),
          );
          const packed = surfels.element(sid);
          const posb = packed.get('posb');
          const surfelNormal = packed.get('normal');

          const surfelRadius = surfel_radius_for_pos(posb.xyz, U_CAM_POS);
          const posOffset = point.sub(posb.xyz);
          const d = length(posOffset);
          const alignPenalty = abs(dot(posOffset, surfelNormal)).mul(
            SURFEL_NORMAL_DIRECTION_SQUISH,
          );
          const mahal = d.mul(float(1.0).add(alignPenalty));
          const dotN = surfelNormal.dot(pointNormal).max(float(0.0));

          const weight = smoothstep(
            surfelRadius.mul(SURFEL_RADIUS_OVERSCALE),
            float(0.0),
            mahal,
          ).mul(dotN);
          const scoreW = smoothstep(surfelRadius, float(0.0), mahal).mul(dotN);

          scoringWeight.addAssign(scoreW);

          If(weight.greaterThan(highest), () => {
            second.assign(highest);
            highest.assign(weight);
          }).ElseIf(weight.greaterThan(second), () => {
            second.assign(weight);
          });
        });

        return vec3(scoringWeight, second, float(cnt));
      });

      fillNode = Fn(() => {
        const tid = int(instanceIndex);

        If(tid.lessThan(int(U_SEED_COUNT)), () => {
          const worldPos = posBuf.element(tid).xyz.toVar();
          const normal = norBuf.element(tid).xyz.normalize().toVar();

          // Only a slice of the candidate list per dispatch, chosen the way
          // find-missing chooses its spawning pixels — by hashing the index against the
          // frame counter. This is not a performance measure, it is the correctness of
          // the `cnt` gate: the hash grid is rebuilt once per frame, so every candidate
          // in one dispatch reads the *same* occupancy and none of them can see the
          // surfels the others are placing beside it. Testing the whole list at once
          // put 2,885 surfels into the Cornell box in three dispatches and buried the
          // converged ones past the resolve's 64-surfel fetch window, which reads on
          // screen as cell-shaped black blocks — a worse artefact than the wedge this
          // pass exists to remove. Trickling lets the grid answer for what was placed
          // last frame before anything is placed next to it.
          const seed = hashCombine2(
            hash1(uint(tid)),
            uint(U_FRAME),
          ).toVar();
          const picked = uintToU01Float(hash1_mut(seed)).lessThan(float(U_RATE));

          If(picked, () => {
          const here = coverageAt(worldPos, normal).toVar();
          const cnt = int(here.z);

          const uncovered = here.y
            .lessThan(float(0.4))
            .and(here.x.lessThan(float(coverage)))
            .and(cnt.lessThan(int(MAX_SURFELS_PER_CELL_FOR_KEEP_ALIVE)));

          // A hole is a gap *in* the cache, and that is a different set from "every
          // surface no camera looked at". The outward faces of the Cornell box are
          // uncovered too, and permanently: nothing in the room can see them and
          // nothing needs their radiance. Spawning there cost 2,885 slots to fix a
          // wedge worth a few hundred, and every one of them was integrated for the
          // whole bake.
          //
          // So the test is adjacency, not emptiness: spawn where this point is empty
          // and the surface a step away is not. That makes the pass a dilation of the
          // covered set — it grows into the corner from the lit wall beside it and
          // stops when the corner is full, and it can never reach the outside of the
          // box because no covered point is a step away from it. The step is two base
          // radii, far enough to clear the reconstruction kernel that made this point
          // read as empty in the first place.
          const up = select(
            abs(normal.y).lessThan(float(0.9)),
            vec3(0, 1, 0),
            vec3(1, 0, 0),
          );
          const tangent = normalize(cross(normal, up));
          const bitangent = cross(normal, tangent);
          const step = float(SURFEL_BASE_RADIUS * 2.0);

          const neighbour = float(0).toVar();
          neighbour.assign(
            max(
              max(
                coverageAt(worldPos.add(tangent.mul(step)), normal).x,
                coverageAt(worldPos.sub(tangent.mul(step)), normal).x,
              ),
              max(
                coverageAt(worldPos.add(bitangent.mul(step)), normal).x,
                coverageAt(worldPos.sub(bitangent.mul(step)), normal).x,
              ),
            ),
          );

          If(uncovered.and(neighbour.greaterThan(float(U_EDGE))), () => {
            const slot = atomicAdd(poolAlloc.element(0), int(1));
            If(slot.lessThan(int(capacity)), () => {
              const sid = poolBuf.element(slot);
              atomicMax(poolMax.element(0), sid.add(int(1)));

              const surfel = surfels.element(sid);
              surfel.get('posb').assign(vec4(worldPos, float(U_FRAME)));
              surfel.get('normal').assign(normal);
              surfel.get('age').assign(int(0));

              const depthBase = sid.mul(int(DEPTH_TILE));
              Loop(int(DEPTH_TILE), ({ i }) => {
                surfelDepth.element(depthBase.add(i)).assign(vec4(0, 0, 0, 0));
              });

              const slgBase = sid.mul(int(SLG_TOTAL_FLOATS));
              Loop(int(SLG_TOTAL_FLOATS), ({ i }) => {
                guiding.element(slgBase.add(i)).assign(float(0));
              });

              // Both halves of the double buffer. The allocator seeds only the read
              // half because it has a parent surfel's converged estimate to copy; here
              // there is by definition no neighbour to copy from — that is what
              // "uncovered" means — so the honest initial state is zero, and leaving the
              // write half holding a recycled surfel's moments would have the first
              // integration blend into a stranger's radiance.
              Loop(int(2), ({ i }) => {
                const m = moments.element(sid.add(i.mul(int(capacity))));
                m.get('irradiance').assign(vec4(0, 0, 0, 0));
                m.get('msmeData0').assign(vec4(0, 0, 0, 0));
                m.get('msmeData1').assign(vec4(0, 0, 0, 0));
                m.get('guiding').assign(vec4(0, 0, 0, 0));
                m.get('hit').assign(vec4(0, 0, 0, 0));
              });

              const li = atomicAdd(spawnCount.element(0), int(1));
              If(li.lessThan(int(capacityHint)), () => {
                spawnList.element(li).assign(sid);
              });
            }).Else(() => {
              atomicAdd(poolAlloc.element(0), int(-1));
            });
          });
          });
        });
      })()
        .compute(capacityHint)
        .setName('GI / Bake hole fill');

      keepAliveNode = Fn(() => {
        const i = int(instanceIndex);
        // Read the counter rather than a uniform: it is written on the GPU by the fill
        // above and a host readback per frame would cost more than the whole dispatch.
        const spawned = atomicAdd(spawnCount.element(0), int(0));
        If(i.lessThan(min(spawned, int(capacityHint))), () => {
          const sid = spawnList.element(i);
          atomicMax(pool.getTouched().element(sid), int(1));
        });
      })()
        .compute(capacityHint)
        .setName('GI / Bake hole fill keep-alive');
    }

    renderer.compute(fillNode);
  }

  function keepAlive(renderer: THREE.WebGPURenderer): void {
    if (keepAliveNode) renderer.compute(keepAliveNode);
  }

  async function readSpawned(renderer: THREE.WebGPURenderer): Promise<number> {
    try {
      const buffer = await renderer.getArrayBufferAsync(
        spawnCount.value as unknown as THREE.BufferAttribute,
      );
      return new Int32Array(buffer)[0] ?? 0;
    } catch {
      return -1;
    }
  }

  return { fill, keepAlive, readSpawned, candidates: seeds.count };
}
