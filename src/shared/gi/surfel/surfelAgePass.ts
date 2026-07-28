// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
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
} from './constants';
import type { SurfelHashGrid } from './surfelHashGrid';
import {
  surfel_pos_to_grid_coord,
  surfel_grid_coord_to_c4,
  surfel_grid_c4_to_hash,
  snap_to_surfel_grid_origin,
} from './surfelHashGrid';
import type { SurfelFindMissingPass } from './surfelFindMissingPass';

export type SurfelAgePass = {
  run: (
    renderer: THREE.WebGPURenderer,
    pool: SurfelPool,
    find: SurfelFindMissingPass,
    grid: SurfelHashGrid,
    prevCameraPos: THREE.Vector3,
    indirectAttr: THREE.IndirectStorageBufferAttribute,
  ) => void;
};

export function createSurfelAgePass(): SurfelAgePass {
  let computeNode: THREE.ComputeNode | null = null;
  const U_PREV_CAM_POS = uniform(new THREE.Vector3());
  const U_PREV_GRID_ORIGIN = uniform(new THREE.Vector3());

  function run(
    renderer: THREE.WebGPURenderer,
    pool: SurfelPool,
    find: SurfelFindMissingPass,
    grid: SurfelHashGrid,
    prevCameraPos: THREE.Vector3,
    indirectAttr: THREE.IndirectStorageBufferAttribute,
  ) {
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

    if (!computeNode) {
      const poolStore = storage(poolAttr, 'int', capacity);
      const surfelStore = storage(surfelAttr, SurfelStruct, capacity);
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

          const isAlive = currentAge.lessThan(int(SURFEL_TTL));

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
              const pRel = posb.xyz.sub(U_PREV_GRID_ORIGIN);
              const gridCoord = surfel_pos_to_grid_coord(pRel);
              const c4 = surfel_grid_coord_to_c4(gridCoord);
              const hashVal = surfel_grid_c4_to_hash(c4);
              const cellIdx = hashVal.toInt();

              const start = offsetsAndListStore.element(cellIdx);
              const end = offsetsAndListStore.element(cellIdx.add(1));
              const count = end.sub(start);

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
