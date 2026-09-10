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

/**
 * Fixed per-slot storage. Anchors are a separate, compact allocation; small
 * allocator counters and the four-float debug readback add 28 bytes per pool.
 *
 * Exported because docs/scale-report.md had to reconstruct this number by reading that
 * function term by term, and a reconstruction goes stale the first time somebody adds a
 * buffer. `scaleProbe.ts` now asserts its own breakdown against this, so the two are
 * wrong together or not at all.
 */
export const BYTES_PER_SURFEL =
  8 * 4 + // packed struct: posb.xyzw, normal.xyz, age
  1 * 4 + // free-list stack slot
  20 * 4 * 2 + // moments, double-buffered
  1 * 4 + // touched flag
  SLG_TOTAL_FLOATS * 4 + // SLG guiding lobes
  1 * 4 + // debug exec counter (read by surfelAgePass)
  SURFEL_DEPTH_TEXELS * SURFEL_DEPTH_TEXELS * 4 * 4; // radial depth atlas tile

export type SurfelPool = {
  /**
   * Grows the pool to at least `capacity`. Returns true when it actually reallocated,
   * which is the caller's signal that every compute pipeline holding these buffers is
   * now stale — see the note on `ensureCapacity` below.
   */
  ensureCapacity: (capacity: number) => boolean;
  getCapacity: () => number;
  /** Bumped on every reallocation. Cheaper for a caller to compare than the buffers. */
  getGeneration: () => number;

  getSurfelAttr: () => THREE.StorageBufferAttribute | null;
  getAnchorAttr: () => THREE.StorageBufferAttribute;
  /** Anchor slot zero is a null sentinel; the remaining slots cover [start, capacity). */
  getAnchorStart: () => number;
  setAnchorStart: (renderer: THREE.WebGPURenderer, start: number) => void;
  dispose: (renderer: THREE.WebGPURenderer) => number;
  releaseRetired: (renderer: THREE.WebGPURenderer) => number;
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
  getDebugExecAttr: () => THREE.StorageBufferNode | null;
  /** The allocator's stack pointer, for the CPU-side growth check. */
  getPoolAllocAttr: () => THREE.BufferAttribute | null;
  swapMoments: () => void;
  getOffsets: () => { readOffset: number; writeOffset: number };
  getSurfelDepthAttr: () => THREE.StorageBufferAttribute | null;
};

export function createSurfelPool(): SurfelPool {
  let capacity = 0;
  let generation = 0;
  let frameParity = 0; // to ping pong offsets in the double sized moments buffer

  let surfelAttr: THREE.StorageBufferAttribute | null = null; // packed struct (posb + normal + age int)
  let anchorAttr: THREE.StorageBufferAttribute;
  let anchorStart = 0;
  const retiredAnchors: THREE.StorageBufferAttribute[] = [];
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

  let surfelDepthAttr: THREE.StorageBufferAttribute | null = null;

  /**
   * Allocates, or reallocates larger, every buffer in the pool.
   *
   * Grow-only, and it hands back whether it did anything, because the caller has work
   * to do afterwards that it cannot be told about any other way. Three.js creates one
   * `GPUBuffer` per `StorageBufferAttribute` at the size the array had when the
   * attribute was first bound (`WebGPUAttributeUtils.createAttribute`), and
   * `updateAttribute` afterwards only ever writes *into* that allocation. Swapping the
   * backing array for a longer one therefore does not resize anything: the pipeline
   * keeps the old, smaller buffer, and the shader's `capacity` — which several passes
   * bake in as a WGSL literal, e.g. `int(capacity)` in surfelAllocatePass — keeps the
   * old value too.
   *
   * So growth means new attribute objects, and new attribute objects mean every cached
   * `ComputeNode` that referenced the old ones has to be thrown away and rebuilt. That
   * is not something this module can do; it is `SurfelGI`'s, because `SurfelGI` is what
   * constructs all of them. Hence the return value and `getGeneration`.
   *
   * The GPU-side contents do not survive. That is not a limitation to be worked around
   * later — the cache lives in device memory and there is no copy of it here to carry
   * across. It is why growth is a rare, deliberate event and not a per-frame policy.
   */
  function ensureCapacity(cap: number): boolean {
    const wanted = Math.max(1, Math.floor(cap));
    if (surfelAttr && wanted <= capacity) return false;
    capacity = wanted;
    generation++;
    retiredAnchors.push(...attributes());
    anchorStart = capacity;
    // Baking and the unbound path need only the null sentinel. Never allocate
    // motion history for the atlas texels that dominate this pool.
    anchorAttr = new THREE.StorageBufferAttribute(new Float32Array(8), 4);

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

    // LOCAL CHANGE vs upstream: the per-surfel debug readback (one vec4 each, 4 MiB at
    // the old fixed capacity, mirrored on the host) is gone. `readAllAsync` was its only
    // reader and nothing in this build calls it — the surfel census in
    // `SurfelGI.readSurfelStats` reads the packed struct directly, which is the same
    // data without a second copy of it. Deleted rather than left dormant because a
    // dormant buffer is indistinguishable from a live one in a memory table.

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

    return true;
  }

  function getTouched() {
    return touchedAtomic;
  }

  function setAnchorStart(renderer: THREE.WebGPURenderer, start: number): void {
    if (!Number.isInteger(start) || start < 0 || start > capacity) throw new Error('Invalid anchor range');
    if (start !== anchorStart) {
      retiredAnchors.push(anchorAttr);
      anchorStart = start;
      anchorAttr = new THREE.StorageBufferAttribute(new Float32Array((capacity - start + 1) * 8), 4);
    }
    // Three r182 has no BufferAttribute.dispose(). Release replaced GPU storage
    // through its backend; callers rebuild anchor-bound compute nodes by identity.
    // Only destroy attributes that have actually been uploaded.
    releaseRetired(renderer);
  }

  function attributes(): THREE.BufferAttribute[] {
    return [surfelAttr, anchorAttr, poolAttr, momentsAttr, guidingAttr, surfelDepthAttr,
      debugReadAttr, aliveCountAtomic?.value, poolAllocCountAtomic?.value, poolMaxCountAtomic?.value,
      touchedAtomic?.value, debugExecAttr?.value].filter(Boolean);
  }

  function releaseRetired(renderer: THREE.WebGPURenderer): number {
    let released = 0;
    for (const attribute of new Set(retiredAnchors.splice(0))) {
      if (renderer.backend.has(attribute) && renderer.backend.get(attribute).buffer) {
        released += renderer.backend.get(attribute).buffer.size;
        renderer.backend.destroyAttribute(attribute);
      }
    }
    return released;
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
    getCapacity: () => capacity,
    getGeneration: () => generation,
    getSurfelAttr,
    getAnchorAttr: () => anchorAttr,
    getAnchorStart: () => anchorStart,
    setAnchorStart,
    releaseRetired,
    dispose: renderer => { retiredAnchors.push(...attributes()); return releaseRetired(renderer); },
    getAliveAtomic,
    getPoolAttr,
    getPoolAllocAtomic,
    getPoolMaxAtomic,
    getMomentsAttr,
    getTouched,
    getGuidingAttr,
    readFirstAsync,
    getDebugExecAttr,
    getPoolAllocAttr: () =>
      (poolAllocCountAtomic?.value as THREE.BufferAttribute) ?? null,
    swapMoments,
    getOffsets,
    getSurfelDepthAttr,
  };
}
