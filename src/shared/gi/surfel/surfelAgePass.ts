// @ts-nocheck -- based on jure/webgiya, with pinned/static ownership in the lifecycle.
// src/surfelAgePass.ts

import * as THREE from 'three/webgpu';
import {
  Fn,
  int,
  atomicAdd,
  storage,
  instanceIndex,
  If,
  float,
  atomicMin,
  uniform,
  uint,
  max,
  min,
  abs,
  Loop,
} from 'three/tsl';
import { SurfelStruct, type SurfelPool } from './surfelPool';
import {
  SURFEL_LIFE_RECYCLE,
  SURFEL_LIFE_RECYCLED,
  TOTAL_CELLS,
  MAX_SURFELS_PER_CELL_FOR_KEEP_ALIVE,
  SURFEL_MAX_HEALTH,
  SURFEL_KILL_SIGNAL,
  SURFEL_TTL,
  MAX_SURFELS_PER_CELL,
  RESOLVE_CELL_SCAN_CAP,
  OFFSETS_AND_LIST_START,
} from './constants';
import type { SurfelHashGrid } from './surfelHashGrid';
import {
  surfel_pos_to_grid_coord,
  surfel_grid_coord_to_c4,
  surfel_grid_c4_to_hash,
  snap_to_surfel_grid_origin,
} from './surfelHashGrid';
import type { SurfelFindMissingPass } from './surfelFindMissingPass';
import { previousReceiverPosition } from './surfelMotion';
import { bindSurfelAnchors } from './surfelAnchors';

export type SurfelAgePass = {
  run: (
    renderer: THREE.WebGPURenderer,
    pool: SurfelPool,
    find: SurfelFindMissingPass,
    grid: SurfelHashGrid,
    prevCameraPos: THREE.Vector3,
    indirectAttr: THREE.IndirectStorageBufferAttribute,
    options?: { hybridLive?: boolean; motion?: any },
  ) => void;
};

export function createSurfelAgePass(): SurfelAgePass {
  let computeNode: THREE.ComputeNode | null = null;
  let lastAnchorAttr = null;
  let lastMotionObjects = null;
  const U_PREV_CAM_POS = uniform(new THREE.Vector3());
  const U_PREV_GRID_ORIGIN = uniform(new THREE.Vector3());
  const U_HYBRID_LIVE = uniform(0);
  const U_MOTION = uniform(0);

  function run(
    renderer: THREE.WebGPURenderer,
    pool: SurfelPool,
    find: SurfelFindMissingPass,
    grid: SurfelHashGrid,
    prevCameraPos: THREE.Vector3,
    indirectAttr: THREE.IndirectStorageBufferAttribute,
    options: { hybridLive?: boolean; motion?: any } = {},
  ) {
    U_HYBRID_LIVE.value = options.hybridLive ? 1 : 0;
    U_MOTION.value = options.motion?.active ? 1 : 0;
    const surfelAttr = pool.getSurfelAttr();
    const poolAlloc = pool.getPoolAllocAtomic();
    const poolMax = pool.getPoolMaxAtomic();
    const poolAttr = pool.getPoolAttr();
    const execAttr = pool.getDebugExecAttr();
    const touchedAtomic = pool.getTouched();
    const offsetsAndListAttr = grid.getOffsetsAndListAttr();

    U_PREV_CAM_POS.value.copy(prevCameraPos);
    snap_to_surfel_grid_origin(U_PREV_GRID_ORIGIN.value, prevCameraPos);

    if (
      !surfelAttr ||
      !poolAlloc ||
      !poolMax ||
      !touchedAtomic ||
      !offsetsAndListAttr ||
      !poolAttr ||
      !execAttr
    )
      return;

    const capacity = surfelAttr.count;

    if (lastAnchorAttr !== pool.getAnchorAttr() || lastMotionObjects !== options.motion?.objects) {
      lastMotionObjects = options.motion?.objects;
      computeNode?.dispose(); computeNode = null; lastAnchorAttr = pool.getAnchorAttr();
    }

    if (!computeNode) {
      const poolStore = storage(poolAttr, 'int', capacity);
      const surfelStore = storage(surfelAttr, SurfelStruct, capacity);
      const anchors = bindSurfelAnchors(pool);
      const objects = options.motion?.objects;
      const offsetsAndListStore = storage(
        offsetsAndListAttr,
        'int',
        offsetsAndListAttr.count,
      ).toReadOnly();

      computeNode = Fn(() => {
        const idx = int(instanceIndex);
        const total = atomicAdd(poolMax.element(0), int(0));
        const inRange = idx.lessThan(total);

        If(inRange, () => {
          const surfel = surfelStore.element(idx);

          const ageNode = surfel.get('age');
          let currentAge = int(ageNode).toVar();

          // Status: 0=None, 1..50=Indirect, 51..100=Direct, 255=Kill
          // atomicMin(val, 0) reads val and sets memory to 0.
          // This works because values are positive.
          const income = atomicMin(touchedAtomic.element(idx), int(0)).toVar();

          // LOCAL CHANGE vs upstream: a negative age marks a surfel pinned by the
          // bake (gi/immortalise.ts). Upstream has no such state, so its economy
          // clamps every age into [0, TTL] at the end of the tick -- which silently
          // erased the pin on the very next frame and made the whole bake a no-op.
          // Pinned surfels are excluded here: no metabolism, no rent, no death.
          const isPinned = currentAge.lessThan(int(0));
          const isAlive = currentAge.lessThan(int(SURFEL_TTL)).and(isPinned.not());

          If(isAlive, () => {
            // 1. POLICE EXECUTION
            If(income.equal(int(SURFEL_KILL_SIGNAL)), () => {
              currentAge.assign(SURFEL_LIFE_RECYCLE); // Kill immediately
              ageNode.assign(SURFEL_LIFE_RECYCLE);
            }).Else(() => {
              // 2. ECONOMY SIMULATION (Stress/age)

              // Base Metabolism: +1 Age per frame
              let delta = int(1).toVar();

              // --- Calculate Rent (Crowding) ---
              const posb = surfel.get('posb');
              const anchor = anchors.position(idx);
              const anchorNormal = anchors.normal(idx);
              const owner = anchorNormal.w.equal(posb.w).and(U_MOTION.greaterThan(0.5)).select(anchor.w, float(0));
              const previousPos = objects ? previousReceiverPosition(posb.xyz, owner, objects) : posb.xyz;
              const pRel = previousPos.sub(U_PREV_GRID_ORIGIN);
              const gridCoord = surfel_pos_to_grid_coord(pRel);
              const c4 = surfel_grid_coord_to_c4(gridCoord);
              const hashVal = surfel_grid_c4_to_hash(c4);
              const cellIdx = hashVal.toInt();

              const start = offsetsAndListStore.element(cellIdx);
              const end = offsetsAndListStore.element(cellIdx.add(1));
              const count = end.sub(start).toVar();
              If(U_HYBRID_LIVE.greaterThan(0.5), () => {
                // Only interchangeable samples compete for density. Another rigid
                // receiver (or its opposite-facing surface) cannot cover this one.
                // Charging its population as rent can retire an entire visible
                // patch after FindMissing has already declared it covered.
                const scanned = min(count, int(RESOLVE_CELL_SCAN_CAP)).toVar();
                count.assign(0);
                Loop(scanned, ({ i }) => {
                  const sid = offsetsAndListStore.element(int(OFFSETS_AND_LIST_START).add(start).add(i));
                  const neighbour = surfelStore.element(sid);
                  const neighbourAnchor = anchors.position(sid);
                  const neighbourOwner = anchors.normal(sid).w.equal(neighbour.get('posb').w)
                    .and(U_MOTION.greaterThan(0.5)).select(neighbourAnchor.w, float(0));
                  // The grid is the pre-economy membership snapshot. Do not test
                  // age < TTL here: neighbouring threads retire in this same pass.
                  If(neighbour.get('age').greaterThanEqual(int(0)).and(neighbourOwner.equal(owner))
                    .and(neighbour.get('normal').dot(surfel.get('normal')).greaterThan(0.8)), () => { count.addAssign(1); });
                });
              });

              const SAFE_CAP = int(MAX_SURFELS_PER_CELL_FOR_KEEP_ALIVE); // e.g. 32

              const excess = max(int(0), count.sub(SAFE_CAP));

              If(count.greaterThan(SAFE_CAP), () => {
                // Rent: Add to Age
                // 30 extra surfels = +3 Age per frame
                const rent = excess.div(10); //TODO
                delta.addAssign(rent);
              });

              If(count.greaterThan(SAFE_CAP.mul(2)), () => {
                const rent = excess.mul(excess).div(int(32));
                delta.addAssign(rent);
              });

              // --- Apply Balance ---
              // But you can't reverse age, only stop it
              let nextAge = currentAge.add(max(delta.sub(income), 0));

              // CLAMPING IS CRITICAL
              // Min: 0.
              // Max: TTL. (Death)
              nextAge.assign(max(int(0), nextAge));

              // Check for death logic later
              currentAge.assign(nextAge);
              ageNode.assign(nextAge);
            });

            If(currentAge.greaterThanEqual(int(SURFEL_TTL)), () => {
              ageNode.assign(int(SURFEL_LIFE_RECYCLED));

              const surfelAllocCount = atomicAdd(poolAlloc.element(0), int(-1));
              const freedSlot = surfelAllocCount.sub(int(1));
              poolStore.element(freedSlot).assign(idx);
              atomicAdd(execAttr.element(idx), int(1));
            });
          });
        });
      })()
        .computeKernel([64, 1, 1])
        .setName('Surfel Economy');
    }

    renderer.compute(computeNode, indirectAttr);
  }

  return { run };
}
