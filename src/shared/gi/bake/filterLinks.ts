// @ts-nocheck -- wgslFn kernel with storage-node includes, the integrator's conventions.
import * as THREE from 'three/webgpu';
import { instanceIndex, storage, texture, uniform, wgslFn } from 'three/tsl';
import {
  bvhNodeStruct,
  constants,
  intersectionResultStruct,
  intersectsBounds,
  intersectsTriangle,
  rayStruct,
} from '../bvh/webgpu/index.js';
import { bvhAnyHitWithin } from '../contact/boundedTrace.ts';
import type { ContactBVHBundle } from '../contact/contactBvh.ts';
import type { LightmapGBuffer } from './lightmapGBuffer.ts';

/* @important Which neighbours a lightmap texel may be filtered with, decided by geometry once and
   not by brightness. The denoise used to accept a neighbour on normal and plane distance alone, and
   a floor that runs under a wall satisfies both on the far side of it: in the sealed room at
   0.23 m/texel that filter took an interior texel from 0.0013 to 0.0310, twelve per cent of the
   sunlit ground, in one pass. Design section 05. */
const KERNEL = /* wgsl */ `
  fn filterLinkKernel(
    positionTex: texture_2d<f32>,
    normalTex: texture_2d<f32>,
    size: f32,
    supportScale: f32,
    normalCos: f32
  ) -> void {
    let side = u32( size );
    let i = instanceIndex;
    if ( i >= side * side ) { return; }
    let px = vec2i( i32( i % side ), i32( i / side ) );
    let self = textureLoad( positionTex, px, 0 );
    if ( self.w < 0.5 ) { links.value[ i ] = 0u; return; }

    let p0 = self.xyz;
    let n0 = normalize( textureLoad( normalTex, px, 0 ).xyz );
    var mask = 0u;
    var bit = 0u;
    for ( var dy = -1; dy <= 1; dy = dy + 1 ) {
      for ( var dx = -1; dx <= 1; dx = dx + 1 ) {
        if ( dx == 0 && dy == 0 ) { continue; }
        let q = px + vec2i( dx, dy );
        if ( q.x < 0 || q.y < 0 || q.x >= i32( side ) || q.y >= i32( side ) ) { bit = bit + 1u; continue; }
        let other = textureLoad( positionTex, q, 0 );
        if ( other.w < 0.5 ) { bit = bit + 1u; continue; }
        let pj = other.xyz;
        let nj = normalize( textureLoad( normalTex, q, 0 ).xyz );
        if ( dot( n0, nj ) <= normalCos ) { bit = bit + 1u; continue; }

        let delta = pj - p0;
        let span = length( delta );
        if ( span <= 1e-6 ) { mask = mask | ( 1u << bit ); bit = bit + 1u; continue; }
        if ( span > supportScale ) { bit = bit + 1u; continue; }

        // Both ends step off their own surface before the segment is traced, so the
        // shared floor the two texels sit on cannot occlude the link to itself.
        let lift = max( 1e-4, span * 0.02 );
        let a = p0 + n0 * lift;
        let b = pj + nj * lift;
        var ray: Ray;
        ray.origin = a;
        let between = b - a;
        let reach = length( between );
        ray.direction = between / reach;
        if ( !bvhAnyHitWithin( ray, reach * 0.999 ) ) { mask = mask | ( 1u << bit ); }
        bit = bit + 1u;
      }
    }
    links.value[ i ] = mask;
  }
`;

function buildKernel(
  attr: THREE.StorageBufferAttribute,
  texelCount: number,
  gbuffer: LightmapGBuffer,
  bvh: ContactBVHBundle,
  uniforms: { size: unknown; support: unknown; normalCos: unknown },
): THREE.ComputeNode {
  const fn = wgslFn(KERNEL, [
    rayStruct,
    intersectionResultStruct,
    bvhNodeStruct,
    constants,
    intersectsBounds,
    intersectsTriangle,
    bvhAnyHitWithin,
    bvh.bvhNode,
    bvh.positionNode,
    bvh.indexNode,
    storage(attr, 'uint', texelCount).setName('links'),
  ]);
  return fn({
    positionTex: texture(gbuffer.position),
    normalTex: texture(gbuffer.normal),
    size: uniforms.size,
    supportScale: uniforms.support,
    normalCos: uniforms.normalCos,
  })
    .compute(texelCount)
    .setName('Lightmap filter links');
}

async function readLinkStats(renderer: THREE.WebGPURenderer, attr: THREE.StorageBufferAttribute, texelCount: number) {
  const data = new Uint32Array(await renderer.getArrayBufferAsync(attr));
  let texels = 0;
  let links = 0;
  for (let i = 0; i < texelCount; i++) {
    const mask = data[i];
    if (mask === 0) continue;
    texels++;
    for (let bit = 0; bit < 8; bit++) if (mask & (1 << bit)) links++;
  }
  return { texels, links, blocked: texels * 8 - links };
}

export function createFilterLinks(size: number, attr: THREE.StorageBufferAttribute) {
  const texelCount = size * size;
  const uSize = uniform(size);
  const uSupport = uniform(1);
  const uNormalCos = uniform(0.9);
  let kernel: THREE.ComputeNode | null = null;

  function run(
    renderer: THREE.WebGPURenderer,
    gbuffer: LightmapGBuffer,
    bvh: ContactBVHBundle,
    options: { supportMetres?: number; normalCos?: number } = {},
  ): void {
    uSupport.value = options.supportMetres ?? 1;
    uNormalCos.value = options.normalCos ?? 0.9;
    if (!kernel) kernel = buildKernel(attr, texelCount, gbuffer, bvh, { size: uSize, support: uSupport, normalCos: uNormalCos });
    renderer.compute(kernel);
  }

  return {
    attr,
    run,
    readStats: (renderer: THREE.WebGPURenderer) => readLinkStats(renderer, attr, texelCount),
    dispose: () => { kernel = null; },
  };
}
