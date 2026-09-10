import * as THREE from 'three/webgpu';
import type { SurfelPool } from '../surfel/surfelPool.ts';
import { SURFEL_LIFE_RECYCLED } from '../surfel/constants.ts';
import type { FrozenSurfelData } from './persistedBake.ts';

export async function captureFrozenSurfels(renderer: THREE.WebGPURenderer, pool: SurfelPool, count: number): Promise<FrozenSurfelData> {
  const spatial = new Float32Array(await renderer.getArrayBufferAsync(pool.getSurfelAttr()!)).slice(0, count * 8);
  const ages = new Int32Array(spatial.buffer);
  for (let i = 0; i < count; i++) if (ages[i * 8 + 7] >= 0) throw new Error('Bake contains unconverged, unpinned surfels; refusing persistence');
  const offset = pool.getOffsets().readOffset * 20;
  const moments = new Float32Array(await renderer.getArrayBufferAsync(pool.getMomentsAttr()!)).slice(offset, offset + count * 20);
  const depth = new Float32Array(await renderer.getArrayBufferAsync(pool.getSurfelDepthAttr()!)).slice(0, count * 64);
  // New dynamic surfels inherit their static parent's learned sampling distribution.
  const guiding = new Float32Array(await renderer.getArrayBufferAsync(pool.getGuidingAttr()!)).slice(0, count * 72);
  return { capacity: pool.getCapacity(), count, spatial, moments, depth, guiding };
}

/** Restore the frozen prefix and its allocator ownership; tail remains available. */
export function restoreFrozenSurfels(pool: SurfelPool, data: FrozenSurfelData): void {
  const capacity = pool.getCapacity();
  const spatial = pool.getSurfelAttr()!, moments = pool.getMomentsAttr()!, depth = pool.getSurfelDepthAttr()!;
  const ages = new Int32Array(data.spatial.buffer, data.spatial.byteOffset, data.spatial.length);
  if (capacity < data.count) throw new Error('Frozen bake exceeds pool capacity');
  for (let i = 0; i < data.count; i++) if (ages[i * 8 + 7] >= 0) throw new Error('Invalid frozen surfel age');
  (spatial.array as Float32Array).fill(0);
  const targetAges = new Int32Array(spatial.array.buffer);
  for (let i = 0; i < capacity; i++) targetAges[i * 8 + 7] = SURFEL_LIFE_RECYCLED;
  (spatial.array as Float32Array).set(data.spatial);
  (moments.array as Float32Array).fill(0);
  (moments.array as Float32Array).set(data.moments, 0);
  (moments.array as Float32Array).set(data.moments, capacity * 20);
  (depth.array as Float32Array).fill(0);
  (depth.array as Float32Array).set(data.depth);
  spatial.needsUpdate = moments.needsUpdate = depth.needsUpdate = true;
  const guiding = pool.getGuidingAttr()!;
  (guiding.array as Float32Array).fill(0);
  (guiding.array as Float32Array).set(data.guiding);
  guiding.needsUpdate = true;
  const stack = pool.getPoolAttr()!;
  for (let i = 0; i < capacity; i++) stack.array[i] = i;
  stack.needsUpdate = true;
  for (const node of [pool.getPoolAllocAtomic(), pool.getPoolMaxAtomic(), pool.getAliveAtomic()]) {
    const attribute = node.value as THREE.BufferAttribute;
    attribute.array[0] = data.count; attribute.needsUpdate = true;
  }
}
