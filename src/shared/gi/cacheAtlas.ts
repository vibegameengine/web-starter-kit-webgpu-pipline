import * as THREE from 'three/webgpu';
import { Fn, float, floor, storage, uint, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { SurfelMoments } from './surfel/surfelPool.ts';

/**
 * Draws the baked light cache as a flat 2D image.
 *
 * There is no lightmap to show: surfel GI stores radiance in a buffer of surfels
 * addressed through a world-space hash grid, not in a UV-unwrapped texture. So the
 * closest honest equivalent is to lay that buffer out as an atlas — one texel per
 * surfel, in pool order — and display the irradiance each one holds.
 *
 * It looks like noise because pool order has nothing to do with world position:
 * neighbouring texels are unrelated surfels. What it does show truthfully is how much
 * of the pool is populated, what radiance is stored, and whether a re-bake actually
 * changed the contents.
 */
export function createCacheAtlas(
  momentsAttr: THREE.StorageBufferAttribute,
  capacity: number,
): {
  node: (uvNode: unknown) => unknown;
  readOffset: ReturnType<typeof uniform>;
  rows: ReturnType<typeof uniform>;
  side: number;
} {
  const side = Math.max(1, Math.floor(Math.sqrt(capacity)));
  const readOffset = uniform(0, 'uint');

  // Only a small fraction of a 262k-slot pool is ever populated, so showing the
  // whole square wastes the pane on empty slots. `rows` crops the view to the
  // populated head of the buffer; surfels are allocated from a stack, so the live
  // ones cluster at low indices.
  const rows = uniform(24, 'uint');

  const moments = storage(momentsAttr, SurfelMoments, momentsAttr.count).toReadOnly();

  const node = Fn(([uvNode]: [ReturnType<typeof vec2>]) => {
    const x = uint(floor(uvNode.x.mul(side)));
    const y = uint(floor(uvNode.y.mul(float(rows))));
    const index = y.mul(uint(side)).add(x).add(readOffset);

    const entry = moments.element(index);
    const irradiance = entry.get('irradiance');

    // .w carries the accumulated sample count; zero means the slot was never
    // integrated, which is worth seeing as empty rather than as black radiance.
    const populated = irradiance.w.greaterThan(0);
    return vec4(populated.select(irradiance.xyz, vec3(0.02, 0.0, 0.04)), 1);
  });

  return { node: node as unknown as (uvNode: unknown) => unknown, readOffset, rows, side };
}
