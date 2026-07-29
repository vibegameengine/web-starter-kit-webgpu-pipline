import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  float,
  instanceIndex,
  ivec2,
  storage,
  texture,
  textureStore,
  uint,
  uniform,
  uv,
  vec2,
  vec4,
  wgsl,
  wgslFn,
} from 'three/tsl';
import {
  bvhIntersectFirstHit,
  constants,
  getVertexAttribute,
  rayStruct,
} from '../bvh/webgpu/index.js';
import type { BakeBvh } from './bakeBvh.ts';
import type { LightmapGBuffer } from './lightmapGBuffer.ts';

const helpers = wgsl(/* wgsl */ `
  fn lmHash( n: u32 ) -> f32 {
    var x = n;
    x = ( x ^ 61u ) ^ ( x >> 16u );
    x = x + ( x << 3u );
    x = x ^ ( x >> 4u );
    x = x * 0x27d4eb2du;
    x = x ^ ( x >> 15u );
    return f32( x & 0x00ffffffu ) / f32( 0x01000000u );
  }

  fn lmBasis( n: vec3f ) -> mat3x3f {
    let up = select( vec3f( 0.0, 1.0, 0.0 ), vec3f( 1.0, 0.0, 0.0 ), abs( n.y ) > 0.95 );
    let t = normalize( cross( up, n ) );
    let b = cross( n, t );
    return mat3x3f( t, b, n );
  }
`);

export interface LightmapBakerOptions {
  /** Rays cast per texel per pass. */
  raysPerPass?: number;
  /** Bounces followed from each primary ray. */
  bounces?: number;
}

/**
 * Path-traces irradiance for every texel of the lightmap atlas.
 *
 * One invocation per texel: read the world position and normal rasterised into the
 * atlas, cast a cosine-weighted hemisphere of rays, trace them against the static BVH,
 * shade each hit with the sun (occluded by a shadow ray) plus a sky term, and follow
 * further bounces for indirect. Passes accumulate as a running mean, so quality is a
 * function of how long the bake is allowed to run.
 *
 * Nothing here refers to a camera. That is the difference between this and the surfel
 * cache: the output depends only on geometry and lighting, so it converges once and is
 * afterwards simply sampled — a texture, not a residency structure.
 */
export class LightmapBaker {
  readonly lightmap: THREE.StorageTexture;
  readonly size: number;
  readonly raysPerPass: number;

  private readonly computeNode: THREE.ComputeNode;
  private readonly accumAttr: THREE.StorageBufferAttribute;
  private readonly uPass = uniform(0, 'uint');
  private readonly uSunDir = uniform(new THREE.Vector3(0, 1, 0));
  private readonly uSunColor = uniform(new THREE.Color(1, 1, 1));
  private readonly uSkyZenith = uniform(new THREE.Color(0.28, 0.42, 0.62));
  private readonly uSkyHorizon = uniform(new THREE.Color(0.55, 0.6, 0.66));
  private readonly uSkyIntensity = uniform(1);

  private passes = 0;

  constructor(
    bvh: BakeBvh,
    gbuffer: LightmapGBuffer,
    size: number,
    options: LightmapBakerOptions = {},
  ) {
    const { raysPerPass = 48, bounces = 2 } = options;
    this.size = size;
    this.raysPerPass = raysPerPass;

    this.lightmap = new THREE.StorageTexture(size, size);
    this.lightmap.type = THREE.HalfFloatType;
    this.lightmap.minFilter = THREE.LinearFilter;
    this.lightmap.magFilter = THREE.LinearFilter;

    // The running sum is kept at full float precision in a storage buffer; the
    // texture only ever holds the current mean, so half-float rounding cannot
    // compound across hundreds of passes.
    const accumAttr = new THREE.StorageBufferAttribute(
      new Float32Array(size * size * 4),
      4,
    );
    this.accumAttr = accumAttr;
    const accum = storage(accumAttr, 'vec4', accumAttr.count);

    // The tracing itself is WGSL, because it calls into the harvested BVH traversal.
    // Accumulation and the texture write stay in TSL, which is how three expects a
    // storage texture to be driven.
    const traceTexel = wgslFn(
      /* wgsl */ `
      fn traceTexel(
        origin: vec3f,
        normal: vec3f,
        seed: u32,
        sunDir: vec3f,
        sunColor: vec3f,
        skyZenith: vec3f,
        skyHorizon: vec3f,
        skyIntensity: f32
      ) -> vec3f {

        let basis = lmBasis( normal );
        var sum = vec3f( 0.0 );

        for ( var i = 0u; i < ${raysPerPass}u; i = i + 1u ) {

          // Cosine-weighted hemisphere, stratified and jittered per pass so
          // successive passes refine instead of repeating the same directions.
          let u1 = ( f32( i ) + lmHash( seed + i ) ) / f32( ${raysPerPass}u );
          let u2 = fract( f32( i ) * 0.61803398875 + lmHash( seed ) );
          let r = sqrt( u1 );
          let phi = 6.28318530718 * u2;

          var dir = normalize( basis * vec3f( r * cos( phi ), r * sin( phi ), sqrt( max( 0.0, 1.0 - u1 ) ) ) );
          var throughput = vec3f( 1.0 );
          var rayOrigin = origin + normal * 0.01;

          for ( var bounce = 0u; bounce < ${bounces}u; bounce = bounce + 1u ) {

            var ray: Ray;
            ray.origin = rayOrigin;
            ray.direction = dir;
            let hit = bvhIntersectFirstHit( ray );

            if ( ! hit.didHit ) {
              let sky = mix( skyHorizon, skyZenith, clamp( dir.y, 0.0, 1.0 ) ) * skyIntensity;
              sum += throughput * sky;
              break;
            }

            let hitPoint = ray.origin + dir * hit.dist;
            var hitNormal = normalize( hit.normal );
            if ( dot( hitNormal, dir ) > 0.0 ) { hitNormal = -hitNormal; }

            throughput = throughput * getVertexAttribute( hit.barycoord, hit.indices.xyz );

            let ndl = max( dot( hitNormal, sunDir ), 0.0 );
            if ( ndl > 0.0 ) {
              var shadowRay: Ray;
              shadowRay.origin = hitPoint + hitNormal * 0.01;
              shadowRay.direction = sunDir;
              if ( ! bvhIntersectFirstHit( shadowRay ).didHit ) {
                sum += throughput * sunColor * ndl;
              }
            }

            let nextBasis = lmBasis( hitNormal );
            let b1 = lmHash( seed + i * 31u + bounce * 7u );
            let b2 = lmHash( seed + i * 17u + bounce * 13u + 1u );
            let br = sqrt( b1 );
            let bphi = 6.28318530718 * b2;
            dir = normalize( nextBasis * vec3f( br * cos( bphi ), br * sin( bphi ), sqrt( max( 0.0, 1.0 - b1 ) ) ) );
            rayOrigin = hitPoint + hitNormal * 0.01;

          }

        }

        return sum / f32( ${raysPerPass}u );

      }
      `,
      [
        constants,
        rayStruct,
        helpers,
        bvhIntersectFirstHit,
        getVertexAttribute,
        bvh.bvhNode,
        bvh.positionNode,
        bvh.indexNode,
        bvh.albedoNode,
      ],
    );

    const positionTex = texture(gbuffer.position);
    const normalTex = texture(gbuffer.normal);

    this.computeNode = Fn(() => {
      const index = instanceIndex;
      const x = index.mod(uint(size));
      const y = index.div(uint(size));
      const texel = ivec2(x, y);
      const sampleUv = vec2(
        float(x).add(0.5).div(size),
        float(y).add(0.5).div(size),
      );

      const posSample = positionTex.sample(sampleUv);

      // w < 0.5 means no chart covers this texel — leave it alone rather than
      // burning rays on empty atlas space.
      If(posSample.w.greaterThan(0.5), () => {
        const normal = normalTex.sample(sampleUv).xyz.normalize();

        const traced = traceTexel({
          origin: posSample.xyz,
          normal,
          seed: index.mul(uint(9781)).add(this.uPass.mul(uint(6151))),
          sunDir: this.uSunDir,
          sunColor: this.uSunColor,
          skyZenith: this.uSkyZenith,
          skyHorizon: this.uSkyHorizon,
          skyIntensity: this.uSkyIntensity,
        });

        const previous = accum.element(index);
        const total = previous.w.add(1);
        const mean = previous.xyz.mul(previous.w).add(traced).div(total);

        accum.element(index).assign(vec4(mean, total));
        textureStore(this.lightmap, texel, vec4(mean, 1));
      });
    })()
      .compute(size * size)
      .setName('Lightmap bake') as unknown as THREE.ComputeNode;

    void uv;
  }

  get passCount(): number {
    return this.passes;
  }

  /**
   * Reads the accumulation buffer back off the GPU. Separates "the trace produced
   * nothing" from "the trace worked but the texture write or the sampling is wrong",
   * which are otherwise indistinguishable from a black image.
   */
  async readStats(renderer: THREE.WebGPURenderer): Promise<{
    traced: number;
    total: number;
    meanLuma: number;
    maxLuma: number;
  }> {
    const buffer = await renderer.getArrayBufferAsync(
      this.accumAttr as unknown as THREE.BufferAttribute,
    );
    const data = new Float32Array(buffer);
    let traced = 0;
    let sum = 0;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] <= 0) continue;
      traced++;
      const luma = (data[i] + data[i + 1] + data[i + 2]) / 3;
      sum += luma;
      if (luma > max) max = luma;
    }
    return {
      traced,
      total: data.length / 4,
      meanLuma: traced ? sum / traced : 0,
      maxLuma: max,
    };
  }

  set skyIntensity(value: number) {
    this.uSkyIntensity.value = value;
  }

  /** One accumulation pass. */
  step(renderer: THREE.WebGPURenderer, sun: THREE.DirectionalLight): void {
    this.uSunDir.value.copy(sun.position).normalize();
    this.uSunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
    this.uPass.value = this.passes;
    renderer.compute(this.computeNode);
    this.passes++;
  }

  /**
   * Runs passes until the wall-clock budget is spent, yielding between them so the
   * GPU actually executes and the page stays responsive.
   */
  async bake(
    renderer: THREE.WebGPURenderer,
    sun: THREE.DirectionalLight,
    durationMs: number,
    onProgress?: (fraction: number, passes: number) => void,
  ): Promise<{ passes: number; ms: number }> {
    const start = performance.now();
    while (performance.now() - start < durationMs) {
      this.step(renderer, sun);
      onProgress?.(Math.min(1, (performance.now() - start) / durationMs), this.passes);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const ms = performance.now() - start;
    console.log(
      `[lightmap] ${this.passes} passes in ${(ms / 1000).toFixed(2)}s — ` +
        `${this.passes * this.raysPerPass} rays/texel at ${this.size}²`,
    );
    return { passes: this.passes, ms };
  }
}
