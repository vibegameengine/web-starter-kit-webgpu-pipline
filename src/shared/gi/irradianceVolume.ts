import * as THREE from 'three/webgpu';
import { storage, uniform, wgsl, wgslFn } from 'three/tsl';
import {
  bvhIntersectFirstHit,
  constants,
  getVertexAttribute,
  rayStruct,
} from './bvh/webgpu/index.js';
import type { SceneBvh } from './sceneBvh.ts';
import type { CacheStats, WorldState } from '../world/index.ts';

export interface IrradianceVolumeOptions {
  /** Probe counts per axis. Cost is O(x·y·z · rays). */
  resolution?: THREE.Vector3;
  /** Rays cast per probe per refresh. */
  raysPerProbe?: number;
  /** Probe refresh budget per frame — the hard cap that keeps frame time flat. */
  probesPerFrame?: number;
  /** Padding added around the static geometry bounds. */
  padding?: number;
}

const shGridStruct = wgsl(/* wgsl */ `
  fn hash1( n: u32 ) -> f32 {
    var x = n;
    x = ( x ^ 61u ) ^ ( x >> 16u );
    x = x + ( x << 3u );
    x = x ^ ( x >> 4u );
    x = x * 0x27d4eb2du;
    x = x ^ ( x >> 15u );
    return f32( x & 0x00ffffffu ) / f32( 0x01000000u );
  }
`);

/**
 * World-space irradiance cache — our analogue of UE's Volumetric Lightmap, and the
 * "static" half of the static/dynamic light split.
 *
 * Design rules, all inherited from the UE study:
 *   · It is a **cache, not a bake.** Probes refresh continuously under a per-frame
 *     budget, so a moving sun is a stream of work rather than a stall.
 *   · It is **sampled every frame, rebuilt on a budget.** Sampling never triggers a
 *     refresh; refreshing never blocks a frame.
 *   · It serves **static and dynamic receivers alike** — which is the whole reason
 *     UE has a Volumetric Lightmap on top of surface lightmaps. A moving object in
 *     a corner picks up that corner's bounce.
 *   · A camera move invalidates nothing. Only `sunVersion` / `staticGeoVersion` do.
 *
 * Storage is L1 spherical harmonics: 4 coefficients per colour channel, packed as
 * three vec4s per probe (one per channel). L2 would halve the ringing on hard
 * gradients; L1 is what fits in three fetches and is honest about being a cache.
 */
export class IrradianceVolume {
  readonly origin = new THREE.Vector3();
  readonly cellSize = new THREE.Vector3();
  readonly resolution: THREE.Vector3;
  readonly probeCount: number;
  readonly raysPerProbe: number;
  probesPerFrame: number;
  /** Blend factor toward the freshly traced value. 1 = replace, <1 = converge. */
  blend = 0.35;

  /** Live uniform so the GUI can retune without rebuilding materials. */
  readonly intensityUniform = uniform(1);

  get intensity(): number {
    return this.intensityUniform.value;
  }
  set intensity(value: number) {
    this.intensityUniform.value = value;
  }

  private readonly gridAttr: THREE.StorageBufferAttribute;
  private readonly gridRW: THREE.StorageBufferNode;
  private readonly gridRO: THREE.StorageBufferNode;
  private readonly computeNode: THREE.ComputeNode;

  private readonly uCursor = uniform(0, 'uint');
  private readonly uFrame = uniform(0, 'uint');
  private readonly uBlend = uniform(1);
  private readonly uSunDir = uniform(new THREE.Vector3(0, 1, 0));
  private readonly uSunColor = uniform(new THREE.Color(1, 1, 1));
  private readonly uSkyZenith = uniform(new THREE.Color(0.18, 0.28, 0.45));
  private readonly uSkyHorizon = uniform(new THREE.Color(0.42, 0.48, 0.55));
  private readonly uGround = uniform(new THREE.Color(0.06, 0.055, 0.05));

  /**
   * Scales the sky contribution inside the tracer. Live, because dialling it to zero
   * is the only clean way to see what is genuine surface-to-surface bounce and what
   * is just ambient — Phase 4 replaces the placeholder sky with a real atmosphere LUT.
   */
  readonly skyIntensityUniform = uniform(1);

  get skyIntensity(): number {
    return this.skyIntensityUniform.value;
  }
  set skyIntensity(value: number) {
    this.skyIntensityUniform.value = value;
    this.markDirty();
  }

  private cursor = 0;
  private builtSunVersion = -1;
  private dirtyProbes: number;

  constructor(
    bvh: SceneBvh,
    private readonly world: WorldState,
    options: IrradianceVolumeOptions = {},
  ) {
    const {
      resolution = new THREE.Vector3(20, 14, 20),
      raysPerProbe = 96,
      probesPerFrame = 192,
      padding = 1.0,
    } = options;

    this.resolution = resolution.clone();
    this.raysPerProbe = raysPerProbe;
    this.probesPerFrame = probesPerFrame;
    this.probeCount = resolution.x * resolution.y * resolution.z;
    this.dirtyProbes = this.probeCount;

    const min = bvh.bounds.min.clone().subScalar(padding);
    const max = bvh.bounds.max.clone().addScalar(padding);
    this.origin.copy(min);
    this.cellSize
      .copy(max)
      .sub(min)
      .divide(new THREE.Vector3(resolution.x - 1, resolution.y - 1, resolution.z - 1));

    // 3 vec4 per probe: R, G, B channel coefficients (sh0, sh1x, sh1y, sh1z).
    this.gridAttr = new THREE.StorageBufferAttribute(
      new Float32Array(this.probeCount * 3 * 4),
      4,
    );
    this.gridRW = storage(this.gridAttr, 'vec4', this.gridAttr.count).setName('shGrid');
    this.gridRO = storage(this.gridAttr, 'vec4', this.gridAttr.count)
      .toReadOnly()
      .setName('shGrid');

    const integrate = wgslFn(
      /* wgsl */ `
      fn compute(
        gridResX: u32, gridResY: u32, gridResZ: u32,
        gridOrigin: vec3f,
        cellSize: vec3f,
        sunDir: vec3f,
        sunColor: vec3f,
        skyZenith: vec3f,
        skyHorizon: vec3f,
        groundColor: vec3f,
        skyIntensity: f32,
        cursor: u32,
        frame: u32,
        blend: f32
      ) -> void {

        let probeCount = gridResX * gridResY * gridResZ;
        let probe = ( instanceIndex + cursor ) % probeCount;

        let slice = gridResX * gridResY;
        let pz = probe / slice;
        let rem = probe % slice;
        let py = rem / gridResX;
        let px = rem % gridResX;

        let origin = gridOrigin + vec3f( f32( px ), f32( py ), f32( pz ) ) * cellSize;

        var sh0 = vec3f( 0.0 );
        var shX = vec3f( 0.0 );
        var shY = vec3f( 0.0 );
        var shZ = vec3f( 0.0 );

        // Rotating the sequence per refresh turns repeated passes into progressive
        // refinement instead of the same ${'${RAYS}'} samples forever.
        let jitter = hash1( probe * 7919u + frame * 104729u );

        for ( var i = 0u; i < RAYS_PER_PROBE; i = i + 1u ) {

          let fi = ( f32( i ) + jitter ) / f32( RAYS_PER_PROBE );
          let cosT = 1.0 - 2.0 * fi;
          let sinT = sqrt( max( 0.0, 1.0 - cosT * cosT ) );
          let phi = 2.39996323 * f32( i ) + jitter * 6.2831853;
          let dir = vec3f( sinT * cos( phi ), cosT, sinT * sin( phi ) );

          var ray: Ray;
          ray.origin = origin;
          ray.direction = dir;
          let hit = bvhIntersectFirstHit( ray );

          var radiance: vec3f;

          if ( hit.didHit ) {

            let hitPoint = origin + dir * hit.dist;
            var n = normalize( hit.normal );
            if ( dot( n, dir ) > 0.0 ) { n = -n; }

            let albedo = getVertexAttribute( hit.barycoord, hit.indices.xyz );

            // Direct sun at the hit point, occluded by the same BVH. This shadow ray
            // is why the cache produces real bounce instead of ambient mush.
            var lit = 0.0;
            let ndl = max( dot( n, sunDir ), 0.0 );
            if ( ndl > 0.0 ) {
              var shadowRay: Ray;
              shadowRay.origin = hitPoint + n * 0.02;
              shadowRay.direction = sunDir;
              let shadowHit = bvhIntersectFirstHit( shadowRay );
              if ( ! shadowHit.didHit ) { lit = ndl; }
            }

            let skyAtHit = mix( groundColor, skyZenith, clamp( n.y * 0.5 + 0.5, 0.0, 1.0 ) );
            radiance = albedo * ( sunColor * lit + skyAtHit * 0.35 * skyIntensity );

          } else {

            if ( dir.y >= 0.0 ) {
              radiance = mix( skyHorizon, skyZenith, clamp( dir.y, 0.0, 1.0 ) ) * skyIntensity;
            } else {
              radiance = groundColor * skyIntensity;
            }

          }

          sh0 += radiance * 0.282095;
          shX += radiance * 0.488603 * dir.x;
          shY += radiance * 0.488603 * dir.y;
          shZ += radiance * 0.488603 * dir.z;

        }

        let norm = 12.56637061 / f32( RAYS_PER_PROBE );
        sh0 = sh0 * norm;
        shX = shX * norm;
        shY = shY * norm;
        shZ = shZ * norm;

        let base = probe * 3u;
        let newR = vec4f( sh0.r, shX.r, shY.r, shZ.r );
        let newG = vec4f( sh0.g, shX.g, shY.g, shZ.g );
        let newB = vec4f( sh0.b, shX.b, shY.b, shZ.b );

        shGrid.value[ base + 0u ] = mix( shGrid.value[ base + 0u ], newR, blend );
        shGrid.value[ base + 1u ] = mix( shGrid.value[ base + 1u ], newG, blend );
        shGrid.value[ base + 2u ] = mix( shGrid.value[ base + 2u ], newB, blend );

      }
      `.replace(/RAYS_PER_PROBE/g, `${raysPerProbe}u`),
      [
        constants,
        rayStruct,
        shGridStruct,
        bvhIntersectFirstHit,
        getVertexAttribute,
        bvh.bvhNode,
        bvh.positionNode,
        bvh.indexNode,
        bvh.albedoNode,
        this.gridRW,
      ],
    );

    this.computeNode = integrate({
      gridResX: uniform(resolution.x, 'uint'),
      gridResY: uniform(resolution.y, 'uint'),
      gridResZ: uniform(resolution.z, 'uint'),
      gridOrigin: uniform(this.origin),
      cellSize: uniform(this.cellSize),
      sunDir: this.uSunDir,
      sunColor: this.uSunColor,
      skyZenith: this.uSkyZenith,
      skyHorizon: this.uSkyHorizon,
      groundColor: this.uGround,
      skyIntensity: this.skyIntensityUniform,
      cursor: this.uCursor,
      frame: this.uFrame,
      blend: this.uBlend,
    })
      .compute(this.probesPerFrame)
      .setName('GI / Irradiance refresh') as unknown as THREE.ComputeNode;
  }

  /**
   * WGSL sampler for materials. Trilinear across eight probes, then an L1 SH
   * evaluation — the same per-pixel interpolation UE's Volumetric Lightmap does,
   * which is what keeps light leaking down to something acceptable.
   */
  createSampler(): ReturnType<typeof wgslFn> {
    return wgslFn(
      /* wgsl */ `
      fn sampleIrradiance(
        worldPos: vec3f,
        worldNormal: vec3f,
        gridResX: u32, gridResY: u32, gridResZ: u32,
        gridOrigin: vec3f,
        cellSize: vec3f,
        intensity: f32
      ) -> vec3f {

        let maxIdx = vec3f( f32( gridResX - 1u ), f32( gridResY - 1u ), f32( gridResZ - 1u ) );
        let g = ( worldPos - gridOrigin ) / cellSize;
        let gc = clamp( g, vec3f( 0.0 ), maxIdx );
        let b = floor( gc );
        let f = gc - b;

        var R = vec4f( 0.0 );
        var G = vec4f( 0.0 );
        var B = vec4f( 0.0 );

        for ( var c = 0u; c < 8u; c = c + 1u ) {

          let ox = f32( c & 1u );
          let oy = f32( ( c >> 1u ) & 1u );
          let oz = f32( ( c >> 2u ) & 1u );

          let p = min( b + vec3f( ox, oy, oz ), maxIdx );
          let w = mix( 1.0 - f.x, f.x, ox ) * mix( 1.0 - f.y, f.y, oy ) * mix( 1.0 - f.z, f.z, oz );
          if ( w <= 0.0 ) { continue; }

          let idx = ( u32( p.z ) * gridResY + u32( p.y ) ) * gridResX + u32( p.x );
          let base = idx * 3u;

          R += shGrid.value[ base + 0u ] * w;
          G += shGrid.value[ base + 1u ] * w;
          B += shGrid.value[ base + 2u ] * w;

        }

        let n = normalize( worldNormal );
        let c0 = 0.886227;
        let c1 = 1.023328;

        let e = vec3f(
          c0 * R.x + c1 * ( R.y * n.x + R.z * n.y + R.w * n.z ),
          c0 * G.x + c1 * ( G.y * n.x + G.z * n.y + G.w * n.z ),
          c0 * B.x + c1 * ( B.y * n.x + B.z * n.y + B.w * n.z )
        );

        return max( e, vec3f( 0.0 ) ) * ( intensity / 3.14159265 );

      }
      `,
      [this.gridRO],
    );
  }

  /** Uniform bundle the material sampler needs. */
  get samplerUniforms(): Record<string, unknown> {
    return {
      gridResX: uniform(this.resolution.x, 'uint'),
      gridResY: uniform(this.resolution.y, 'uint'),
      gridResZ: uniform(this.resolution.z, 'uint'),
      gridOrigin: uniform(this.origin),
      cellSize: uniform(this.cellSize),
    };
  }

  /**
   * Runs the per-frame refresh slice. Never exceeds `probesPerFrame`; when the sun
   * steps, the whole grid is marked dirty and paid off over subsequent frames.
   */
  /** Marks the whole grid for re-integration, paid off over subsequent frames. */
  markDirty(): void {
    this.dirtyProbes = this.probeCount;
  }

  update(renderer: THREE.WebGPURenderer, stats?: CacheStats): void {
    if (this.world.sunVersion !== this.builtSunVersion) {
      this.builtSunVersion = this.world.sunVersion;
      this.markDirty();
    }

    if (this.dirtyProbes <= 0) return;

    const sun = this.world.sun;
    this.uSunDir.value.copy(sun.direction);
    this.uSunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
    this.uCursor.value = this.cursor;
    this.uFrame.value = this.world.frame;

    renderer.compute(this.computeNode);

    this.cursor = (this.cursor + this.probesPerFrame) % this.probeCount;
    this.dirtyProbes -= this.probesPerFrame;
    if (this.dirtyProbes <= 0) this.uBlend.value = this.blend;

    if (stats) stats.giBricksRefreshed += this.probesPerFrame;
  }

  /** Fills the whole grid before the first frame is shown. */
  primeAll(renderer: THREE.WebGPURenderer): void {
    const passes = Math.ceil(this.probeCount / this.probesPerFrame);
    this.uBlend.value = 1.0;
    for (let i = 0; i < passes; i++) {
      this.update(renderer);
    }
    this.uBlend.value = this.blend;
    this.dirtyProbes = 0;
  }
}
