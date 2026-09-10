// @ts-nocheck
import * as THREE from 'three/webgpu';
import { storage, uniform, wgslFn } from 'three/tsl';
import { bvhIntersectFirstHit, constants, intersectionResultStruct, rayStruct } from '../bvh/webgpu/index.js';
import type { ContactBVHBundle } from '../contact/contactBvh.ts';

const KERNEL = /* wgsl */ `
  fn probeTrace( rayCount: f32, dirCount: f32, maxDistance: f32 ) -> void {
    let i = instanceIndex;
    if ( i >= u32( rayCount ) ) { return; }
    let probe = i / u32( dirCount );
    let dir = i % u32( dirCount );
    var ray: Ray;
    ray.origin = probeOrigins.value[ probe ].xyz;
    ray.direction = probeDirections.value[ dir ].xyz;
    let hit = bvhIntersectFirstHit( ray );
    var out = vec4f( maxDistance, 1.0, 0.0, 0.0 );
    if ( hit.didHit ) { out = vec4f( min( hit.dist, maxDistance ), hit.side, 1.0, hit.dist ); }
    probeHits.value[ i ] = out;
  }
`;

export const HIT_DISTANCE = 0;
export const HIT_SIDE = 1;
export const HIT_FLAG = 2;
export const HIT_RAW_DISTANCE = 3;

export interface ProbeTrace {
  hits: Float32Array;
  directions: number;
}

/* @important One ray per (probe, direction) against the full-detail contact tree, the same tree the
   reflections trace: the GI tree's cluster proxies put a ray inside a box (contact occlusion read
   0.45 on open sand with it, 1.0 without). Output is read back once; the bake is CPU-driven. */
export class ProbeTracePass {
  private readonly uRayCount = uniform(0);
  private readonly uDirCount = uniform(0);
  private readonly uMaxDistance = uniform(1);

  constructor(private readonly renderer: THREE.WebGPURenderer, private readonly bvh: ContactBVHBundle) {}

  async trace(origins: Float32Array, directions: Float32Array, maxDistance: number): Promise<ProbeTrace> {
    const probes = origins.length / 4;
    const dirCount = directions.length / 4;
    const rays = probes * dirCount;
    const originAttr = new THREE.StorageBufferAttribute(origins, 4);
    const directionAttr = new THREE.StorageBufferAttribute(directions, 4);
    const hitAttr = new THREE.StorageBufferAttribute(new Float32Array(rays * 4), 4);
    const fn = wgslFn(KERNEL, [
      bvhIntersectFirstHit, rayStruct, intersectionResultStruct, constants,
      this.bvh.bvhNode, this.bvh.positionNode, this.bvh.indexNode,
      storage(originAttr, 'vec4', probes).toReadOnly().setName('probeOrigins'),
      storage(directionAttr, 'vec4', dirCount).toReadOnly().setName('probeDirections'),
      storage(hitAttr, 'vec4', rays).setName('probeHits'),
    ]);
    this.uRayCount.value = rays;
    this.uDirCount.value = dirCount;
    this.uMaxDistance.value = maxDistance;
    const kernel = fn({ rayCount: this.uRayCount, dirCount: this.uDirCount, maxDistance: this.uMaxDistance }).compute(rays).setName('Probe trace');
    this.renderer.compute(kernel);
    const hits = new Float32Array(await this.renderer.getArrayBufferAsync(hitAttr));
    return { hits, directions: dirCount };
  }
}
