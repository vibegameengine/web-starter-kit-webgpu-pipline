// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// surfelPreparePass.ts
import * as THREE from 'three/webgpu';
import {
  Fn,
  int,
  atomicStore,
  storage,
  instancedArray,
  instanceIndex,
} from 'three/tsl';
import { SurfelStruct, type SurfelPool } from './surfelPool';
import { SURFEL_LIFE_RECYCLED } from './constants';

export type SurfelPreparePass = {
  run: (
    renderer: THREE.WebGPURenderer,
    pool: SurfelPool,
    opts?: { totalCellCount?: number; forceClear?: boolean }, // if you have a cell buffer to clear
  ) => void;

  // Expose per-frame atomics to other passes
  getAliveSnapshotAtomic: ReturnType<typeof instancedArray>['toAtomic'];
  getRetiredCounterAtomic: ReturnType<typeof instancedArray>['toAtomic'];
  getAllocCounterAtomic: ReturnType<typeof instancedArray>['toAtomic'];
  getSpawnCounterAtomic: ReturnType<typeof instancedArray>['toAtomic'];
};

export function createSurfelPreparePass(): SurfelPreparePass {
  const aliveSnapshotAtomic = instancedArray(
    new Int32Array(1),
    'int',
  ).toAtomic();
  const retiredCounterAtomic = instancedArray(
    new Int32Array(1),
    'int',
  ).toAtomic();
  const allocCounterAtomic = instancedArray(
    new Int32Array(1),
    'int',
  ).toAtomic();
  const spawnCounterAtomic = instancedArray(
    new Int32Array(1),
    'int',
  ).toAtomic();
  let prepareOne: THREE.ComputeNode;

  // Track if we have initialized the GPU buffers
  let isInitialized = false;
  let currentCapacity = 0;

  function run(
    renderer: THREE.WebGPURenderer,
    pool: SurfelPool,
    opts?: { forceClear?: boolean },
  ) {
    const surfelAttr = pool.getSurfelAttr();

    if (!surfelAttr) {
      console.log('No surfel attr');
      return;
    }
    const capacity = surfelAttr.count;

    // 1. ONE-TIME INITIALIZATION
    // We only run this if capacity changed or forceClear is requested.
    if (!isInitialized || currentCapacity !== capacity || opts?.forceClear) {
      initializePool(renderer, pool, capacity);
      isInitialized = true;
      currentCapacity = capacity;
    }

    // 2. PER-FRAME COUNTER RESET
    return resetPerFrameCounters(renderer);
  }

  // This matches "clear_surfel_pool.hlsl" + "memset(meta, 0)"
  function initializePool(
    renderer: THREE.WebGPURenderer,
    pool: SurfelPool,
    capacity: number,
  ) {
    const poolAlloc = pool.getPoolAllocAtomic(); // The Stack Pointer
    const poolMax = pool.getPoolMaxAtomic(); // The High Water Mark
    const surfelsAttr = pool.getSurfelAttr();
    const poolAttr = pool.getPoolAttr();
    if (!poolAlloc || !poolMax || !surfelsAttr || !poolAttr) return;

    const surfels = storage(surfelsAttr, SurfelStruct, capacity);
    const poolBuf = storage(poolAttr, 'int', capacity);

    // 1. Fill the free list: pool[i] = i
    const initFn = Fn(() => {
      const idx = int(instanceIndex);
      surfels.element(idx).get('age').assign(int(SURFEL_LIFE_RECYCLED)); // Mark all as dead initially
      poolBuf.element(idx).assign(idx);
    })()
      .compute(capacity)
      .setName('Init Surfel Pool');

    // 2. Reset the Stack Pointer and High Water Mark to 0
    const resetMetaFn = Fn(() => {
      atomicStore(poolAlloc.element(0), int(0));
      atomicStore(poolMax.element(0), int(0));
    })()
      .compute(1)
      .setName('Reset Allocators');

    renderer.compute(initFn);
    renderer.compute(resetMetaFn);

    console.log('Surfel Pool Initialized/Reset');
  }

  // Only resets debug/profiling counters
  function resetPerFrameCounters(renderer: THREE.WebGPURenderer) {
    if (!prepareOne) {
      prepareOne = Fn(() => {
        // Reset PER-FRAME stats (like "how many spawned THIS frame")
        atomicStore(spawnCounterAtomic.element(0), int(0));
        atomicStore(retiredCounterAtomic.element(0), int(0));
      })().compute(1);
    }
    return renderer.compute(prepareOne);
  }

  return {
    run,
    getAliveSnapshotAtomic: () => aliveSnapshotAtomic,
    getRetiredCounterAtomic: () => retiredCounterAtomic,
    getAllocCounterAtomic: () => allocCounterAtomic,
    getSpawnCounterAtomic: () => spawnCounterAtomic,
  };
}
