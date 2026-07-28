// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// surfelPool.ts
import * as THREE from 'three/webgpu';
import {
  Fn,
  storage,
  float,
  int,
  instanceIndex,
  instancedArray,
  vec4,
  struct,
} from 'three/tsl';
import { SLG_TOTAL_FLOATS, SURFEL_DEPTH_TEXELS } from './constants';

// [SLG] Number of guiding lobes per surfel (keep in sync with WGSL in surfelIntegratePass)

// ------------------------------------------------------------------
// Compact surfel representation
// ------------------------------------------------------------------
export const SurfelStruct = struct(
  {
    posb: 'vec4', // position + b(irth) frame
    normal: 'vec3',
    age: 'int',
  },
  'SurfelPacked',
);

// irradiance.rgb = Long Term Mean
// irradiance.w   = Total Sample Count (still useful for startup logic)
// msmeData0.rgb  = Short Term Mean
// msmeData0.w    = VBBR (Variance-Based Blend Reduction factor)
// msmeData1.rgb  = Variance
// msmeData1.w    = Inconsistency
export const SurfelMoments = struct(
  {
    irradiance: 'vec4',
    msmeData0: 'vec4',
    msmeData1: 'vec4',
    guiding: 'vec4',
    hit: 'vec4',
  },
  'SurfelMoments',
);

export type SurfelPool = {
  ensureCapacity: (capacity: number) => void;

  getSurfelAttr: () => THREE.StorageBufferAttribute | null;
  getAliveAtomic: () => THREE.StorageBufferNode;
  getPoolAttr: () => THREE.StorageInstancedBufferAttribute | null;
  getPoolAllocAtomic: () => THREE.StorageBufferNode;
  getPoolMaxAtomic: () => THREE.StorageBufferNode;
  getMomentsAttr: () => THREE.StorageBufferAttribute | null;
  getTouched: () => THREE.StorageBufferNode | null;
  getGuidingAttr: () => THREE.StorageBufferAttribute | null; // [SLG] new
  readFirstAsync: (
    renderer: THREE.WebGPURenderer,
  ) => Promise<{
    position: [number, number, number];
    birth: number;
    alive: boolean;
  } | null>;
  readAllAsync: (
    renderer: THREE.WebGPURenderer,
  ) => Promise<{ position: [number, number, number, number] }[] | null>;
  getDebugExecAttr: () => THREE.StorageBufferNode | null;
  swapMoments: () => void;
  getOffsets: () => { readOffset: number; writeOffset: number };
  getSurfelDepthAttr: () => THREE.StorageBufferAttribute | null;
};

export function createSurfelPool(): SurfelPool {
  let capacity = 0;
  let frameParity = 0; // to ping pong offsets in the double sized moments buffer

  let surfelAttr: THREE.StorageBufferAttribute | null = null; // packed struct (posb + normal + age int)
  let aliveCountAtomic: THREE.StorageBufferNode;
  let aliveCountArray: Int32Array | null = null;

  let poolAttr: THREE.StorageInstancedBufferAttribute | null = null; // pool stack (surfel_pool_buf)
  let poolAllocCountAtomic: THREE.StorageBufferNode;
  let poolAllocArray: Int32Array | null = null;
  let poolMaxCountAtomic: THREE.StorageBufferNode;
  let poolMaxArray: Int32Array | null = null;

  let debugExecAttr: THREE.StorageBufferNode | null = null;
  let momentsAttr: THREE.StorageBufferAttribute | null = null;

  let touchedAtomic: THREE.StorageBufferNode;
  let touchedArray: Int32Array | null = null;

  // [SLG] Per-surfel guiding lobe coefficients: linear float array of size (capacity * GUIDING_LOBE_COUNT)
  let guidingAttr: THREE.StorageBufferAttribute | null = null;

  let debugReadAttr: THREE.StorageInstancedBufferAttribute | null = null; // StorageInstancedBufferAttribute(vec4)
  let debugReadStore: any = null;
  let debugAllReadAttr: THREE.StorageInstancedBufferAttribute | null = null; // StorageInstancedBufferAttribute(vec4) per surfel
  let debugAllReadStore: any = null;

  let surfelDepthAttr: THREE.StorageBufferAttribute | null = null;

  function ensureCapacity(cap: number) {
    if (capacity === cap && surfelAttr) return;
    capacity = cap;

    // 1x vec4 per surfel: posb (xyz + age), 1x vec3 normal, 1x int age
    surfelAttr = new THREE.StorageBufferAttribute(
      new Float32Array(capacity * 8),
      8,
    );
    aliveCountArray = new Int32Array(1);
    aliveCountAtomic = instancedArray(aliveCountArray, 'int').toAtomic();
    aliveCountAtomic.value.array[0] = 0;

    // Initialize surfel_pool_buf
    const poolIdxBuf = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) poolIdxBuf[i] = i;
    poolAttr = new THREE.StorageInstancedBufferAttribute(poolIdxBuf, 1);
    poolAttr.needsUpdate = true;

    // Pool stack metadata (alloc pointer + max used)
    poolAllocArray = new Int32Array(1);
    poolAllocCountAtomic = instancedArray(poolAllocArray, 'int').toAtomic();
    poolAllocCountAtomic.value.array[0] = 0;

    poolMaxArray = new Int32Array(1);
    poolMaxCountAtomic = instancedArray(poolMaxArray, 'int').toAtomic();
    poolMaxCountAtomic.value.array[0] = 0;

    // Irradiance and Aux buffers (vec4) in one struct (double-buffered)
    const floatsPerMoment = 20;
    momentsAttr = new THREE.StorageBufferAttribute(
      new Float32Array(capacity * floatsPerMoment * 2),
      floatsPerMoment,
    );

    touchedArray = new Int32Array(capacity);
    touchedArray.fill(0);
    touchedAtomic = instancedArray(touchedArray, 'int').toAtomic();

    // [SLG] Allocate guiding lobe weights buffer (capacity * GUIDING_LOBE_COUNT scalars)
    guidingAttr = new THREE.StorageBufferAttribute(
      new Float32Array(capacity * SLG_TOTAL_FLOATS),
      1, // itemSize=1 → linear float array
    );

    // allocate debug readback (vec4: xyz=pos0, w=birth frame)
    const dbg = new Float32Array(4);
    debugReadAttr = new THREE.StorageInstancedBufferAttribute(dbg, 4);
    debugReadStore = storage(debugReadAttr, 'vec4', 1);

    // allocate debug readback for all surfels (vec4 per surfel: xyz=pos, w=radius; zeroed if not alive)
    const dbgAll = new Float32Array(capacity * 4);
    debugAllReadAttr = new THREE.StorageInstancedBufferAttribute(dbgAll, 4);
    debugAllReadStore = storage(debugAllReadAttr, 'vec4', capacity);

    debugExecAttr = instancedArray(new Int32Array(capacity), 'int').toAtomic();

    // ------------------------------------------------------------------
    // [RADIAL DEPTH ATLAS TEXTURE]
    // Atlas is (tiles*SURFEL_DEPTH_TEXELS)². tiles = ceil(sqrt(capacity)).
    // We use FloatType so WGSL can safely declare rgba32float.
    // ------------------------------------------------------------------
    const tileTexels = SURFEL_DEPTH_TEXELS * SURFEL_DEPTH_TEXELS;

    surfelDepthAttr = new THREE.StorageBufferAttribute(
      new Float32Array(capacity * tileTexels * 4), // 4 floats per vec4
      4, // itemSize = 4 => 'vec4'
    );
    surfelDepthAttr.name = 'surfelDepth';
    surfelDepthAttr.needsUpdate = true; // initial upload
  }

  function getTouched() {
    return touchedAtomic;
  }
  function getSurfelAttr() {
    return surfelAttr;
  }
  function getAliveAtomic(): THREE.StorageBufferNode {
    return aliveCountAtomic;
  }
  function getPoolAttr() {
    return poolAttr;
  }
  function getPoolAllocAtomic(): THREE.StorageBufferNode {
    return poolAllocCountAtomic;
  }
  function getPoolMaxAtomic(): THREE.StorageBufferNode {
    return poolMaxCountAtomic;
  }
  function getMomentsAttr() {
    return momentsAttr;
  }
  function getSurfelDepthAttr() {
    return surfelDepthAttr;
  }

  // [SLG] expose lobe-coefficient buffer to integrator
  function getGuidingAttr() {
    return guidingAttr;
  }

  function getDebugExecAttr() {
    return debugExecAttr;
  }

  async function readFirstAsync(
    renderer: THREE.WebGPURenderer,
  ): Promise<{
    position: [number, number, number];
    birth: number;
    alive: boolean;
  } | null> {
    if (!surfelAttr || !debugReadAttr) return null;
    const count = capacity;
    const surfels = storage(surfelAttr, SurfelStruct, count);

    const compute = Fn(() => {
      const s = surfels.element(int(0));
      const isAlive = float(1);
      debugReadStore
        .element(int(0))
        .assign(
          vec4(
            s.get('posb').x.mul(isAlive),
            s.get('posb').y.mul(isAlive),
            s.get('posb').z.mul(isAlive),
            s.get('posb').w.mul(isAlive),
          ),
        );
    })()
      .compute(1)
      .setName('Surfel Pool Read First');

    try {
      await renderer.compute(compute);
      const ab = await renderer.getArrayBufferAsync(debugReadAttr);
      const arr = new Float32Array(ab);
      const alive =
        arr[0] !== 0 || arr[1] !== 0 || arr[2] !== 0 || arr[3] !== 0;
      return {
        position: [arr[0], arr[1], arr[2]] as [number, number, number],
        birth: arr[3],
        alive,
      };
    } catch {
      return null;
    }
  }

  async function readAllAsync(
    renderer: THREE.WebGPURenderer,
  ): Promise<{ position: [number, number, number, number] }[] | null> {
    if (!surfelAttr || !debugAllReadAttr) return null;
    const count = capacity;
    if (count <= 0) return [];
    const surfels = storage(surfelAttr, SurfelStruct, count);
    const compute = Fn(() => {
      const i = instanceIndex;
      const s = surfels.element(i);

      debugAllReadStore.element(i).assign(s.get('posb'));
    })()
      .compute(Math.max(1, count))
      .setName('Surfel Pool Read All');

    try {
      await renderer.compute(compute);
      const ab = await renderer.getArrayBufferAsync(debugAllReadAttr);
      const arr = new Float32Array(ab);
      const result: { position: [number, number, number, number] }[] =
        new Array(count);
      for (let i = 0; i < count; i++) {
        const base = i * 4;
        const px = arr[base + 0];
        const py = arr[base + 1];
        const pz = arr[base + 2];
        const pr = arr[base + 3];
        result[i] = { position: [px, py, pz, pr] };
      }
      return result;
    } catch {
      return null;
    }
  }

  function swapMoments() {
    frameParity = 1 - frameParity;
  }

  function getOffsets() {
    return {
      // If parity 0: Read from Lower, Write to Upper
      // If parity 1: Read from Upper, Write to Lower
      readOffset: frameParity * capacity,
      writeOffset: (1 - frameParity) * capacity,
    };
  }

  return {
    ensureCapacity,
    getSurfelAttr,
    getAliveAtomic,
    getPoolAttr,
    getPoolAllocAtomic,
    getPoolMaxAtomic,
    getMomentsAttr,
    getTouched,
    getGuidingAttr,
    readFirstAsync,
    readAllAsync,
    getDebugExecAttr,
    swapMoments,
    getOffsets,
    getSurfelDepthAttr,
  };
}
