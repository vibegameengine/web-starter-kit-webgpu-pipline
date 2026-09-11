import * as THREE from 'three/webgpu';
import { HDRLoader } from 'three/examples/jsm/Addons.js';
import { Layer } from '../world/index.ts';
import { createSurfelImmortaliser } from './immortalise.ts';
import { createCacheAtlas } from './cacheAtlas.ts';
import { createLightmapSurfels } from './bake/lightmapSurfels.ts';
import { createFilterLinks } from './bake/filterLinks.ts';
import type { ContactBVHBundle } from './contact/contactBvh.ts';
import {
  createGeometrySeeder,
  sampleStaticSurfaces,
} from './bake/geometrySurfels.ts';
import { createSurfelHoleFill } from './bake/holeFill.ts';
import type { LightmapGBuffer } from './bake/lightmapGBuffer.ts';
import { captureFrozenSurfels, restoreFrozenSurfels } from './bake/frozenSurfels.ts';
import type { FrozenSurfelData } from './bake/persistedBake.ts';

import {
  CASCADES,
  MAX_SURFELS,
  MAX_TEMPORAL_M,
  RESOLVE_FETCH_CAP,
  SURFEL_CS,
  RUNTIME_POOL_TAIL,
  SURFEL_POOL_BASE,
  SURFEL_POOL_GROW_AT,
  SURFEL_TTL,
  SURFEL_KILL_SIGNAL,
  TOTAL_CELLS,
} from './surfel/constants.ts';
import { BYTES_PER_SURFEL } from './surfel/surfelPool.ts';
import { createIntegrationSchedule } from './surfel/integrationSchedule';
import { giKnobs } from './surfel/knobs.ts';

/**
 * Frames between pool-occupancy readbacks. ~1.5 s at 60 Hz: long enough that the
 * readback is free, short enough that a camera walking into denser geometry gets more
 * slots before the allocator has spent many frames refusing.
 */
const GROWTH_CHECK_FRAMES = 90;

/**
 * Window of the bake budget, as a fraction, during which the hole fill runs.
 *
 * Fractions rather than frame counts because the budget is wall-clock and the frame
 * rate is not ours to predict. It opens late enough that the sweep has had a real go at
 * the scene — filling from frame zero would spawn into places the very next view was
 * about to cover, which is competing with find-missing rather than supplementing it.
 * It closes early enough to leave a fifth of the budget for what it spawned to
 * converge, because a surfel short of TARGET_SAMPLE_COUNT is one the immortaliser
 * refuses to pin and the runtime then recycles — the hole would come back a few
 * seconds after the bake claimed to have closed it.
 *
 * It is a window and not a handful of instants because the fill dilates: each pass
 * grows the covered set by one step into a hole, so a hole wider than a step needs
 * several, with a grid rebuild between them.
 */
const HOLE_FILL_FROM = 0.3;
const HOLE_FILL_TO = 0.8;

/**
 * Wall-clock ceiling on a counted bake. A safety net and nothing else.
 *
 * Deliberately far above what either reference scene needs, because the moment this is
 * what ends a bake the result stops being reproducible — how much of the schedule ran
 * would again be a function of GPU scheduling. It is here so a pathological scene fails
 * loudly instead of hanging the page, and firing it is reported as an error rather than
 * as a completed bake.
 */
const BAKE_WALL_CLOCK_CAP_MS = 120000;
import { createGBuffer } from './surfel/gbuffer.ts';
import { createSceneBVH, refreshSceneMaterials, type SceneBVHBundle } from './surfel/sceneBvh.ts';
import { createDynamicBVH, type DynamicBVHBundle } from './surfel/dynamicBvh.ts';
import { createSurfelMotion } from './surfel/surfelMotion';
import { createSurfelPool } from './surfel/surfelPool.ts';
import { createSurfelPreparePass } from './surfel/surfelPreparePass.ts';
import { createSurfelAgePass } from './surfel/surfelAgePass.ts';
import { createSurfelFindMissingPass } from './surfel/surfelFindMissingPass.ts';
import { createSurfelAllocatePass } from './surfel/surfelAllocatePass.ts';
import { createSurfelDispatchArgs } from './surfel/surfelDispatchArgs.ts';
import { createSurfelHashGrid } from './surfel/surfelHashGrid.ts';
import { createIntegratorDispatchArgs } from './surfel/integratorDispatchArgs.ts';
import { createSurfelIntegratePass } from './surfel/surfelIntegratePass.ts';
import { createSurfelGIResolvePass } from './surfel/surfelGIResolvePass.ts';

export interface SurfelGiAssets {
  blueNoiseUrl?: string;
  envUrl?: string;
}

/**
 * Surfel global illumination, ported from jure/webgiya.
 *
 * This is the real thing rather than a re-derivation: surfels are spawned from the
 * G-Buffer where the current view lacks coverage, stored in a world-space hash grid,
 * aged and recycled against a fixed pool, and integrated by ray-tracing the scene BVH
 * with guiding + MSME. Radiance persists in world space across frames, so it is a
 * genuine cache — not a screen-space effect that dies when the camera turns.
 *
 * Pass order per frame (webgiya's, unchanged, because it is load-bearing):
 *   GBuffer → prepare → find-missing → dispatch args → age → allocate
 *           → grid build → integrate (BVH RT) → resolve → composite
 *
 * Geometry the tracer sees is split in two, the way UE splits mobility. The static BVH
 * is built once and holds everything that will not move; a second, much smaller BVH
 * holds `Mobility.Movable` geometry and is rebuilt on demand, so a mover occludes and
 * bleeds onto its surroundings without the forest being re-accelerated every frame.
 *
 * What the split deliberately does NOT do is let dynamic radiance settle into the
 * static pool: a bake pins its surfels, and pinned surfels are never re-integrated. A
 * mover's own indirect lighting is the dynamic GI pass's job, not this one's.
 *
 * One inherited limit remains: alpha-tested foliage has no representation in either
 * structure. That is a Phase 6 problem.
 */
export class SurfelGI {
  private readonly gbuffer: ReturnType<typeof createGBuffer>;
  private pool: ReturnType<typeof createSurfelPool>;
  private prepare = createSurfelPreparePass();
  private age = createSurfelAgePass();
  private findMissing = createSurfelFindMissingPass();
  private allocate = createSurfelAllocatePass();
  private dispatchArgs = createSurfelDispatchArgs();
  private grid = createSurfelHashGrid();
  private integratorArgs = createIntegratorDispatchArgs();
  private resolve: ReturnType<typeof createSurfelGIResolvePass>;

  private integrate: ReturnType<typeof createSurfelIntegratePass> | null = null;
  private bvh: SceneBVHBundle | null = null;
  private dynamicBvh: DynamicBVHBundle | null = null;
  private motion: ReturnType<typeof createSurfelMotion> | null = null;
  rigidSurfels = true;

  private readonly prevCameraPos = new THREE.Vector3();
  private lastOutput: THREE.Texture | null = null;
  private _frozen = false;
  /** Ray count restored after a bake finishes. */
  private runtimeSampleCount = 4;
  private integrationSchedule = createIntegrationSchedule();
  runtimeRayBudget = 4096;
  private lightingControls = { envIntensity: 1, envLod: 4, fromDirect: 1, fromIndirect: 1, albedoBoost: 1 };
  private leafTransmitEnabled = true;
  private immortaliser = createSurfelImmortaliser();
  private cacheAtlas: ReturnType<typeof createCacheAtlas> | null = null;
  private lightmapSurfels: ReturnType<typeof createLightmapSurfels> | null = null;

  /** Frames between growth checks, and the readback in flight for the current one. */
  private growthCheckPending = false;
  private growthCheckedAtFrame = 0;
  private poolSaturationReported = false;
  private releasedBakePoolBytes = 0;
  private bakedAtlas: THREE.Texture | null = null;
  /** @important The raster's gain on the atlas, so a bounce ray reads it at the same scale. */
  private bakedAtlasIntensity: unknown = null;
  private dynamicMembershipChanged = false;
  private dynamicRevision = 0;
  bakedFeedbackEnabled = true;

  /** Set for the duration of a counted bake; see `maybeGrowPool` and `bake`. */
  private bakeFreezesPool = false;

  /**
   * Set once a lightmap bake has pinned its atlas surfels under `?dynsurfel=1`.
   *
   * It is what splits the pool in two without the pool needing to know: pinned slots are
   * never recycled, so `[0, seeded)` belongs to the atlas forever and the allocator can
   * only reach the tail. See `setFrozen` and `maybeGrowPool` for the two behaviours that
   * change, and `giKnobs.dynamicSurfels` for the measurement.
   */
  private atlasPinned = false;

  get staticPinned(): boolean { return this.atlasPinned; }
  /** Receiver-aware live coverage; legacy is retained for the focused regression check. */
  liveCoverage = true;

  dynamicGi = giKnobs.dynamicGi();

  unboundGi = giKnobs.unboundGi();

  readonly envTexture: THREE.DataTexture;
  /** The 128x128 LDR blue-noise tile (nearest, repeat), shared with screen-space filters. */
  get blueNoiseTexture(): THREE.Texture { return this.blueNoise; }
  /** The static BVH bundle (null before `buildScene`), for passes that trace the same world. */
  get staticBvh(): SceneBVHBundle | null { return this.bvh; }
  /** The movers' BVH bundle, replaced on membership changes; read it every frame. */
  get dynamicBvhBundle(): DynamicBVHBundle | null { return this.dynamicBvh; }
  /** Depth of the GI's own G-buffer, rendered this frame by the scene camera. */
  get gbufferDepthTexture(): THREE.Texture { return this.gbuffer.target.depthTexture!; }
  /** (specularColor.rgb, roughness) of the GI G-buffer, for the reflection pass. */
  get specularTexture(): THREE.Texture { return this.gbuffer.target.textures[2]; }
  /** The static material array the GI shades hits with (null before `buildScene`). */
  get diffuseArrayTexture(): THREE.Texture | null { return this.bvh?.diffuseArrayTex ?? null; }

  private constructor(
    renderer: THREE.WebGPURenderer,
    private readonly blueNoise: THREE.Texture,
    envTexture: THREE.DataTexture,
  ) {
    this.envTexture = envTexture;
    this.gbuffer = createGBuffer(renderer);
    this.pool = createSurfelPool();

    const override = giKnobs.surfelBase();
    const base = Math.min(
      MAX_SURFELS,
      Math.max(256, override > 0 ? override : SURFEL_POOL_BASE),
    );
    this.pool.ensureCapacity(base);
    this.resolve = createSurfelGIResolvePass(this.grid, this.pool);
  }

  static async create(
    renderer: THREE.WebGPURenderer,
    assets: SurfelGiAssets = {},
  ): Promise<SurfelGI> {
    const base = import.meta.env.BASE_URL;
    const {
      blueNoiseUrl = `${base}textures/LDR_RGBA_0.png`,
      envUrl = `${base}exr/pizzo_pernice_puresky_2k.hdr`,
    } = assets;

    const blueNoise = await new THREE.TextureLoader().loadAsync(blueNoiseUrl);
    blueNoise.colorSpace = THREE.NoColorSpace;
    blueNoise.wrapS = blueNoise.wrapT = THREE.RepeatWrapping;
    blueNoise.minFilter = THREE.NearestFilter;
    blueNoise.magFilter = THREE.NearestFilter;
    blueNoise.generateMipmaps = false;

    const env = (await new HDRLoader().loadAsync(envUrl)) as THREE.DataTexture;
    env.generateMipmaps = true;
    env.mapping = THREE.EquirectangularReflectionMapping;

    return new SurfelGI(renderer, blueNoise, env);
  }

  /**
   * Builds the static-scene BVH the integrator traces against. Call after the scene
   * is populated, and again only when static geometry actually changes — this is the
   * expensive half, and rebuilding it per frame is exactly the cost the static/dynamic
   * split exists to avoid.
   */
  buildScene(renderer: THREE.WebGPURenderer, scene: THREE.Scene): void {
    this.gbuffer.prepareScene(scene);
    this.bvh = createSceneBVH(renderer, scene);
    // Built here rather than lazily: the buffers are bound into the integrator's
    // pipeline the first time it runs, and a structure that appears after that point
    // cannot be bound without recompiling the shader. It is created even when nothing
    // in the scene moves, so there is exactly one shader variant to reason about.
    this.dynamicBvh = createDynamicBVH(scene, this.bvh.materialIdByUUID);
    this.motion = createSurfelMotion(scene);
    this.integrate = createSurfelIntegratePass(this.blueNoise, this.envTexture);
    this.integrate.setDynamicTracing(this.dynamicTracing);
    this.prepare.run(renderer, this.pool, { forceClear: true });
  }

  /**
   * Grows the surfel pool to at least `wanted` slots and rebuilds everything bound to
   * it. Returns true if it grew.
   *
   * The rebuild is the whole cost of growth, and it is unavoidable. A pool buffer is a
   * `StorageBufferAttribute`; three.js sizes its `GPUBuffer` once, when the attribute is
   * first bound, and several passes additionally bake the capacity into their WGSL as a
   * literal. So a larger pool is a different set of attributes, and every `ComputeNode`
   * that closed over the old ones is now pointing at buffers of the wrong size. This
   * class constructs all of them, which is the only reason growth is implementable at
   * all: the fix is to drop the passes and let them lazily rebuild against the new
   * buffers on their next `run`.
   *
   * What does not survive is the cache. The converged radiance is in device memory, in
   * the buffers being replaced, and there is no host copy to carry over. So this is a
   * deliberate, rare event — a safety net for a world bigger than the base guess, not a
   * per-frame policy — and it says so out loud when it fires.
   */
  ensurePoolCapacity(renderer: THREE.WebGPURenderer, wanted: number, restoring = false): boolean {
    const from = this.pool.getCapacity();
    if (wanted <= from) return false;

    if (from >= MAX_SURFELS) {
      if (!this.poolSaturationReported) {
        this.poolSaturationReported = true;
        console.error(
          `[gi] surfel pool is full at its ceiling of ${MAX_SURFELS} and ${wanted} were ` +
            'asked for. Every surfel past the ceiling is refused by the allocator, and a ' +
            'refused surfel is not an error anywhere downstream — the geometry that wanted ' +
            'it simply resolves to no indirect light and comes out BLACK. Raise ' +
            'MAX_SURFELS if the memory is there, or reduce what is asking (a lightmap ' +
            'atlas edge, ?lm=, is the usual culprit).',
        );
      }
      return false;
    }

    const target = Math.min(MAX_SURFELS, Math.max(wanted, from * 2));
    const size = `${from} → ${target} slots (${((target * BYTES_PER_SURFEL) / 1048576).toFixed(1)} MiB GPU)`;
    // Growing to make room for a cache that is about to be written into it loses
    // nothing; saying it does sent a reader hunting a bake that never happened.
    if (restoring) console.log(`[gi] sizing the surfel pool for the restored cache: ${size}`);
    else console.warn(`[gi] growing the surfel pool ${size}. The cached radiance does not ` +
      'survive this and the cache will re-converge from empty.');

    this.pool.ensureCapacity(target);
    this.pool.releaseRetired(renderer);
    this.rebuildPoolBoundPasses();
    this.prepare.run(renderer, this.pool, { forceClear: true });
    return true;
  }

  /**
   * Drops every pass holding a binding to the pool so it rebuilds on next use.
   *
   * The list is exactly the set constructed by this class, which is also exactly the
   * set that binds pool buffers — including the screen-probe chain, which is built
   * inside `createSurfelGIResolvePass` and therefore replaced along with it. The
   * G-Buffer is the one thing kept: it is sized by the screen, not by the pool.
   */
  private rebuildPoolBoundPasses(): void {
    this.prepare = createSurfelPreparePass();
    this.age = createSurfelAgePass();
    this.findMissing = createSurfelFindMissingPass();
    this.allocate = createSurfelAllocatePass();
    this.dispatchArgs = createSurfelDispatchArgs();
    this.grid = createSurfelHashGrid();
    this.integratorArgs = createIntegratorDispatchArgs();
    this.immortaliser = createSurfelImmortaliser();
    this.resolve = createSurfelGIResolvePass(this.grid, this.pool);

    // Null rather than rebuilt: both are lazily created by their getters against the
    // pool's current capacity, and neither exists unless something asked for it.
    this.cacheAtlas = null;
    this.lightmapSurfels = null;
    this.geometrySeeder = null;

    if (this.blueNoise && this.envTexture) {
      this.integrate = createSurfelIntegratePass(this.blueNoise, this.envTexture);
      this.integrate.setDynamicTracing(this.dynamicTracing);
      this.integrate.setBaseSampleCount(this.runtimeSampleCount);
      const c = this.lightingControls;
      this.integrate.setEnvControls(c.envIntensity, c.envLod);
      this.integrate.setLeafTransmit(this.leafTransmitEnabled);
      this.integrate.setBakedAtlas(this.bakedAtlas, this.bakedAtlasIntensity);
      this.integrate.setGiScales(c.fromDirect, c.fromIndirect);
      this.integrate.setAlbedoBoost(c.albedoBoost);
    }
  }

  /**
   * Polls how full the pool is and grows it before the allocator starts refusing.
   *
   * The readback is one integer and runs at most every `GROWTH_CHECK_FRAMES`; the
   * alternative signal — noticing that allocations failed — is only available *after*
   * the frames that came out black.
   */
  private maybeGrowPool(renderer: THREE.WebGPURenderer): void {
    if (this.bakeFreezesPool) return;
    // Same argument as `bakeFreezesPool`, held permanently: growth replaces every pool
    // buffer, and the atlas cache pinned into them has no host copy. Under `?dynsurfel=1`
    // the pool is mostly atlas and the runtime population is a few thousand surfels in
    // the tail, so there is nothing growth could buy that is worth the whole bake.
    if (this.atlasPinned) return;
    if (this.growthCheckPending) return;
    if (this.pool.getCapacity() >= MAX_SURFELS) return;

    const frame = renderer.info.frame;
    if (frame - this.growthCheckedAtFrame < GROWTH_CHECK_FRAMES) return;
    this.growthCheckedAtFrame = frame;

    const attr = this.pool.getPoolAllocAttr();
    if (!attr) return;

    this.growthCheckPending = true;
    const capacityAtRequest = this.pool.getCapacity();
    renderer
      .getArrayBufferAsync(attr)
      .then((buffer) => {
        // Capacity moving under the readback means somebody else already grew it, and
        // acting on a count measured against the old ceiling would double the pool for
        // no reason.
        if (this.pool.getCapacity() !== capacityAtRequest) return;
        const alive = new Int32Array(buffer)[0] ?? 0;
        if (alive >= capacityAtRequest * SURFEL_POOL_GROW_AT) {
          this.ensurePoolCapacity(renderer, capacityAtRequest * 2);
        }
      })
      .catch((error) => {
        // Not swallowed. A growth check that fails quietly is the same defect as an
        // allocator that fails quietly: the pool stops growing and the only symptom is
        // geometry that never gets lit.
        console.error('[gi] surfel pool occupancy readback failed', error);
      })
      .finally(() => {
        this.growthCheckPending = false;
      });
  }

  /**
   * Re-bakes `Mobility.Movable` geometry into the dynamic BVH. Returns true if it
   * actually rebuilt, which it only does when a mover's world matrix changed.
   *
   * Call it from the animation loop next to whatever moves the movers. The cost is a
   * matrix compare per mover when nothing moved, and a full re-transform plus BVH build
   * when something did — which is why the mover set wants to stay small. It is the
   * static structure, not this one, that holds the forest.
   */
  updateDynamicScene(options: { force?: boolean } = {}): boolean {
    return this.dynamicBvh?.refresh(options) ?? false;
  }

  /** Call once after a batch of dynamic additions/removals or geometry/material
   * replacements. Does not bake, unwrap, rebuild static BVH or clear live history. */
  syncDynamicScene(renderer: THREE.WebGPURenderer, scene: THREE.Scene, options: { materialsChanged?: boolean } = {}): void {
    if (!this.bvh || !this.motion) throw new Error('Build the scene before synchronising movers');
    if (this.bakeFreezesPool) throw new Error('Cannot change movers during an authoring bake');
    this.gbuffer.prepareScene(scene);
    let needsMaterials = options.materialsChanged === true;
    const materialIds = new Set<string>();
    scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materialIds.add(material.uuid);
        if (!this.bvh!.materialIdByUUID.has(material.uuid)) needsMaterials = true;
      }
    });
    if (materialIds.size !== this.bvh.materialIdByUUID.size) needsMaterials = true;
    this.integrate?.invalidate();
    if (needsMaterials) refreshSceneMaterials(renderer, scene, this.bvh);
    const nextBvh = createDynamicBVH(scene, this.bvh.materialIdByUUID);
    const nextMotion = createSurfelMotion(scene, this.motion);
    this.motion.remapTo(renderer, this.pool, nextMotion);
    this.motion.dispose(renderer); this.dynamicBvh?.dispose(renderer);
    this.motion = nextMotion; this.dynamicBvh = nextBvh;
    this.dynamicMembershipChanged = true; this.dynamicRevision++;
  }

  get dynamicSceneRevision() { return this.dynamicRevision; }

  /**
   * The dynamic acceleration structure itself: bindings, world bounds and the enable
   * flag. Exposed so the dynamic GI pass can trace it without going back through the
   * scene graph.
   */
  getDynamicBvh(): DynamicBVHBundle | null {
    return this.dynamicBvh;
  }

  /**
   * The static acceleration structure, for the same reason `getDynamicBvh` exists:
   * there is exactly one static scene and it gets exactly one BVH.
   *
   * The screen-probe final gather traces this. It used to build its own copy — 600 ms
   * and a duplicate set of node/position/index/attribute buffers on a 168k-triangle
   * scene, plus a second copy of the per-material diffuse array — which is a price
   * nobody should pay for the want of one getter. Null until `buildScene` has run.
   */
  getSceneBvh(): SceneBVHBundle | null {
    return this.bvh;
  }

  /**
   * Size of the static acceleration structure, as numbers rather than as buffers.
   *
   * `scaleProbe.ts` was reaching through TypeScript `private` at runtime to read
   * `this.bvh` and measuring `byteLength` off the attributes it found. That works —
   * `private` is a compile-time fence — right up until this field is renamed, at which
   * point the harness silently reports zero and the report it feeds reads as an
   * improvement. A measurement that fails quietly is worse than no measurement.
   */
  get bvhStats(): {
    triangles: number;
    nodes: number;
    bytes: number;
    breakdown: Record<string, number>;
    fullDetail: number;
    dropped: number;
    proxied: number;
    buildMs: number;
  } | null {
    if (!this.bvh) return null;
    const bytesOf = (node: unknown): number => {
      const attr = (node as { value?: { array?: { byteLength?: number } } })?.value;
      return attr?.array?.byteLength ?? 0;
    };
    const breakdown = {
      nodes: bytesOf(this.bvh.bvhNode),
      position: bytesOf(this.bvh.positionNode),
      normal: bytesOf(this.bvh.normalNode),
      index: bytesOf(this.bvh.indexNode),
      color: bytesOf(this.bvh.colorNode),
      lightmapUv: this.bvh.lightmapUvTexture.image.data?.byteLength ?? 0,
    };
    return {
      triangles: this.bvh.stats.triangles,
      nodes:
        (this.bvh.bvhNode as unknown as { value?: { count?: number } })?.value?.count ?? 0,
      bytes: Object.values(breakdown).reduce((sum, v) => sum + v, 0),
      breakdown,
      fullDetail: this.bvh.stats.fullDetailTriangles,
      dropped: this.bvh.stats.droppedTriangles,
      proxied: this.bvh.stats.proxiedTriangles,
      buildMs: this.bvh.stats.buildMs,
    };
  }

  /** Slots the pool currently holds, and what one slot costs. */
  get poolStats(): { capacity: number; bytesPerSurfel: number; anchorBytes: number; totalGpuBytes: number; generation: number } {
    return {
      capacity: this.pool.getCapacity(),
      bytesPerSurfel: BYTES_PER_SURFEL,
      anchorBytes: this.pool.getAnchorAttr().array.byteLength,
      totalGpuBytes: this.pool.getCapacity() * BYTES_PER_SURFEL + this.pool.getAnchorAttr().array.byteLength + 28,
      generation: this.pool.getGeneration(),
    };
  }

  /**
   * Empties the surfel pool: free list refilled, every surfel marked dead, allocator
   * and high-water mark back to zero.
   *
   * There is exactly one pool, and the lightmap bake spends all of it on atlas texels.
   * Switching back to runtime GI therefore has to reclaim it first — otherwise the
   * allocator has nothing to hand out, no surfel is ever spawned for the current view,
   * and the screen resolve quietly returns black.
   */
  resetCache(renderer: THREE.WebGPURenderer): void {
    this._frozen = false;
    // The clear rewrites the free list and every age to the recycled sentinel, so the
    // pins go with it and the pool is one undivided region again.
    this.atlasPinned = false;
    this.pool.setAnchorStart(renderer, this.pool.getCapacity());
    this.prepare.run(renderer, this.pool, { forceClear: true });
  }

  captureStaticBake(renderer: THREE.WebGPURenderer, count: number): Promise<FrozenSurfelData> {
    return captureFrozenSurfels(renderer, this.pool, count);
  }

  /** Surfels the allocator has handed out — the size of the cache a warm produced. */
  async readAllocatedCount(renderer: THREE.WebGPURenderer): Promise<number> {
    const attr = this.pool.getPoolAllocAttr();
    if (!attr) return 0;
    return new Int32Array(await renderer.getArrayBufferAsync(attr))[0] ?? 0;
  }

  get bakeNoiseTexture(): THREE.Texture { return this.blueNoise; }

  /**
   * Hands the tracer the baked atlas, so a ray landing on unwrapped static geometry
   * reads its light from there instead of gathering the surfel cache at that point.
   * Survives a pool rebuild through `rebuildPoolBoundPasses`.
   */
  useBakedAtlas(texture: THREE.Texture | null, intensity?: unknown): void {
    this.bakedAtlasIntensity = intensity ?? this.bakedAtlasIntensity;
    if (texture === this.bakedAtlas) return;
    this.bakedAtlas = texture;
    this.integrate?.setBakedAtlas(texture, this.bakedAtlasIntensity);
    console.log(texture
      ? '[gi] rays read the baked atlas at unwrapped static hits'
      : '[gi] rays read the surfel cache at every hit');
  }

  get bakedTransportStats() {
    return { releasedBakePoolBytes: this.releasedBakePoolBytes,
      livePool: this.poolStats, uvBytes: this.bvh?.lightmapUvTexture.image.data?.byteLength ?? 0 };
  }

  /**
   * @param withSurfels false restores the receiver ownership without the surfel data
   *   — the experiment for what still reads the baked surfels now that rays take
   *   unwrapped static hits from the atlas. Dropping the whole call instead also
   *   drops `atlasPinned`, and then live GI is added on top of the atlas: measured
   *   2026-09-09 on Cornell as 11.7/255 of double lighting, which answers a
   *   different question than the one being asked.
   */
  restoreStaticBake(renderer: THREE.WebGPURenderer, data: FrozenSurfelData, withSurfels = true): void {
    if (data.capacity > MAX_SURFELS) throw new Error('Saved bake exceeds supported pool capacity');
    // Room for what was actually saved plus a runtime tail, not for the authoring pool
    // the bake happened to run in. A lightmap bake sizes its pool to the atlas — one
    // slot per texel, 262144 at 512 square — and saves that number as the capacity,
    // while the surfels it actually placed cover the lit texels only: 186880 on Cornell
    // (2026-09-08), the other 75264 slots dead weight at 748 bytes each, 54 MiB of GPU.
    // The tail is what movable geometry allocates from; 4096 is the size the runtime
    // pool used to be given after a bake.
    this.ensurePoolCapacity(renderer, Math.min(MAX_SURFELS, (withSurfels ? data.count : 0) + RUNTIME_POOL_TAIL), true);
    this.resetCache(renderer);
    if (withSurfels) restoreFrozenSurfels(this.pool, data);
    if (this.rigidSurfels) this.pool.setAnchorStart(renderer, withSurfels ? data.count : 0);
    this.atlasPinned = true;
    this._frozen = false;
    // @important Say what went into the pool, not what the file holds: they differ whenever withSurfels is false, and a log reading "restored 92361" beside an empty pool sends anyone debugging a dark surface to the wrong place.
    console.log(withSurfels
      ? `[lightmap] restored ${data.count} pinned surfels; no integration`
      : `[lightmap] receiver ownership restored; ${data.count} saved surfels NOT loaded (?atlasSurfels=1 loads them)`);
  }

  resize(renderer: THREE.WebGPURenderer, scale?: number): void {
    this.gbuffer.resize(renderer, scale);
  }

  /** True once the resolve pass has produced a texture to composite. */
  get outputTexture(): THREE.Texture | null {
    return this.resolve.getOutputTexture();
  }

  /** The G-Buffer albedo the composite multiplies indirect light by. */
  get albedoTexture(): THREE.Texture {
    return this.gbuffer.target.textures[1];
  }

  /** World normal RGB and baked/rigid receiver ownership in alpha. */
  get receiverTexture(): THREE.Texture {
    return this.gbuffer.target.textures[0];
  }

  /** On-demand lifecycle snapshot for diagnosing a missing receiver; no frame polling. */
  async readCoverageDebug(renderer: THREE.WebGPURenderer) {
    const fields = { spatial: this.pool.getSurfelAttr(), free: this.pool.getPoolAttr(),
      allocated: this.pool.getPoolAllocAttr(), flags: this.findMissing.getTileAllocAttr(),
      candidates: this.findMissing.getCandidatePackedAttr(), pixel: this.findMissing.getDebugAttr() };
    const result: Record<string, number[]> = {};
    for (const [name, attribute] of Object.entries(fields)) {
      if (!attribute) continue;
      const bytes = await renderer.getArrayBufferAsync(attribute);
      result[name] = Array.from(name === 'spatial' || name === 'candidates' || name === 'pixel' ? new Float32Array(bytes) : new Int32Array(bytes));
      if (name === 'spatial') result.ages = Array.from(new Int32Array(bytes)).filter((_, i) => i % 8 === 7);
    }
    return { frame: renderer.info.frame, inputs: this.findMissing.inputs(), shader: this.findMissing.getShader(renderer), ...result };
  }

  setCoverageDebugPixel(x: number, y: number) { this.findMissing.setDebugPixel(x, y); }

  /** Audit: re-evaluate current coverage without aging, allocation or integration. */
  recheckCoverage(renderer: THREE.WebGPURenderer, camera: THREE.PerspectiveCamera, rebuild: boolean | 'replay' = false) {
    if (rebuild === 'replay') { this.findMissing.replay(renderer); return; }
    if (rebuild) this.findMissing.invalidate();
    this.findMissing.run(renderer, camera, this.gbuffer, this.pool, this.grid, this.prevCameraPos,
      { hybridLive: this.atlasPinned && this.liveCoverage, motion: this.motion });
  }

  /** Audit-only fault injection: let the real economy retire one receiver's samples. */
  async expireRigidReceiver(renderer: THREE.WebGPURenderer, owner: number) {
    if (!Number.isInteger(owner) || owner <= 0 || !this.motion) throw new Error('Expected a rigid receiver id');
    const state = await this.motion.readState(renderer, this.pool);
    const rows = state.rows.filter(row => row.owner === owner);
    const backend = renderer.backend as any;
    const buffer = backend.get(this.pool.getTouched()!.value).buffer;
    const kill = new Int32Array([SURFEL_KILL_SIGNAL]);
    for (const row of rows) backend.device.queue.writeBuffer(buffer, row.sid * 4, kill);
    return rows.map(row => ({ sid: row.sid, birth: row.birth }));
  }

  /**
   * A flat 2D view of the cache itself — one texel per surfel, in pool order.
   * Null until the scene has been built. See cacheAtlas.ts for why this is an atlas
   * of a buffer rather than a lightmap.
   */
  getCacheAtlas(): ReturnType<typeof createCacheAtlas> | null {
    if (this.cacheAtlas) return this.cacheAtlas;
    const momentsAttr = this.pool.getMomentsAttr();
    if (!momentsAttr) return null;
    // The pool's live capacity, not MAX_SURFELS: the atlas is one texel per slot, and
    // sizing it against the ceiling drew a mostly-empty square whose occupied corner
    // shrank every time the pool got smaller.
    this.cacheAtlas = createCacheAtlas(momentsAttr, this.pool.getCapacity());
    return this.cacheAtlas;
  }

  /**
   * When frozen, the surfel population and its radiance are held fixed: spawning,
   * ageing, allocation and ray integration all stop. Only the view-dependent tail of
   * the chain still runs each frame — the G-Buffer, the camera-centred hash grid, and
   * the per-pixel resolve.
   *
   * This is the whole point of baking: pay for convergence once, then sample.
   */
  get frozen(): boolean {
    return this._frozen;
  }

  setFrozen(frozen: boolean): void {
    // A freeze asked for after the atlas has been pinned is declined, not obeyed. The
    // caller's intent is "hold the baked cache still", and the pins already do exactly
    // that for the half of the pool the bake owns — while a blanket freeze would also
    // stop spawning on the half it does not, which is where every movable surface lives.
    // Under `?dynsurfel=0` nothing is ever pinned this way and this branch never runs.
    // `freezeCompletely` is a scene saying it has no movable receivers at all, and
    // then a pinned cache is the whole lighting solution: freezing is exactly right.
    if (frozen && this.atlasPinned && !this.freezeCompletely) {
      this._frozen = false;
      return;
    }
    this._frozen = frozen;
  }

  get bakeMachinery() {
    return { pool: this.pool, grid: this.grid, integrate: this.integrate, integratorArgs: this.integratorArgs, bvh: this.bvh, dynamicBvh: this.dynamicBvh, integrationSchedule: this.integrationSchedule };
  }

  renderGBuffer(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, layer: Layer = Layer.Default): void {
    const previousTarget = renderer.getRenderTarget();
    const previousBackground = scene.background;
    const cameraLayers = camera.layers.mask;
    scene.background = null;
    camera.layers.set(layer);
    renderer.setMRT(this.gbuffer.sceneMRT);
    renderer.setRenderTarget(this.gbuffer.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previousTarget);
    renderer.setMRT(null);
    camera.layers.mask = cameraLayers;
    scene.background = previousBackground;
  }

  update(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    options: { staticOnly?: boolean } = {},
  ): boolean {
    if (!this.bvh || !this.dynamicBvh || !this.integrate) {
      this.prevCameraPos.copy(camera.position);
      return false;
    }

    this.motion?.prepare(renderer, this.pool, camera, this.rigidSurfels && this.atlasPinned && !options.staticOnly);
    if (this.dynamicMembershipChanged) {
      this.grid.build(renderer, this.pool, camera);
      this.prevCameraPos.copy(camera.position);
      this.dynamicMembershipChanged = false;
    }

    this.renderGBuffer(renderer, scene, camera, options.staticOnly ? Layer.GiStatic : Layer.Default);

    // --- surfel lifecycle (skipped once frozen) ------------------------------
    this.prepare.run(renderer, this.pool);

    // Ahead of spawning, not after: a pool that grows in response to allocations
    // already having failed has produced black frames to get the signal.
    if (!this._frozen) this.maybeGrowPool(renderer);

    if (!this._frozen) {
      const found = this.findMissing.run(
        renderer,
        camera,
        this.gbuffer,
        this.pool,
        this.grid,
        this.prevCameraPos,
        { hybridLive: this.atlasPinned && this.liveCoverage, motion: this.motion,
          skipRigid: !this.dynamicGi, skipUnbound: !this.unboundGi },
      );
      this.dispatchArgs.run(renderer, this.pool);

      this.age.run(
        renderer,
        this.pool,
        this.findMissing,
        this.grid,
        this.prevCameraPos,
        this.dispatchArgs.getIndirectAttr(),
        { hybridLive: this.atlasPinned && this.liveCoverage, motion: this.motion },
      );
      this.allocate.run(renderer, this.pool, this.findMissing, found.tileCount);
      this.motion?.capture(renderer, this.pool, camera, this.gbuffer);
    }

    // The grid is centred on the camera, so it must be rebuilt even when frozen —
    // otherwise the resolve stops finding surfels as soon as the camera moves.
    this.grid.build(renderer, this.pool, camera);

    if (!this._frozen) {
      this.integratorArgs.run(renderer, this.pool);
      this.integrate.run(
        renderer,
        this.pool,
        this.bvh,
        this.dynamicBvh,
        this.grid,
        camera,
        scene,
        this.integratorArgs.getIndirectAttr(),
        // A bake writes into surfels that are about to be pinned, so it must see the
        // static world and nothing else. Trace a mover here and its pose is frozen into
        // the cache permanently -- the cache stops being a property of the level.
        { includeDynamic: !options.staticOnly,
          schedule: this.atlasPinned && !options.staticOnly && this.runtimeRayBudget > 0
            ? this.integrationSchedule.run(renderer, this.pool, this.runtimeRayBudget, this.runtimeSampleCount) : undefined },
      );
    }

    this.resolve.run(renderer, camera, this.gbuffer,
      { skipPinned: this.atlasPinned, skipRigid: !this.dynamicGi, skipUnbound: !this.unboundGi });

    this.reportGridOccupancy(renderer);

    this.prevCameraPos.copy(camera.position);
    if (!this._frozen) this.pool.swapMoments();

    // Keep the atlas view pointed at whichever half of the double buffer is current.
    if (this.cacheAtlas) {
      this.cacheAtlas.readOffset.value = this.pool.getOffsets().readOffset;
    }

    const output = this.resolve.getOutputTexture();
    const changed = output !== this.lastOutput;
    this.lastOutput = output;
    return changed;
  }

  private gridStatsDone = false;

  /**
   * Logs how many surfels each occupied grid cell holds, once, at `?gridstats=N`.
   *
   * After the grid's slot pass has run, cell `i` occupies `[header[i], header[i+1])` of
   * the list, so occupancy is a difference of adjacent header entries and needs no second
   * structure. The number that matters is how many cells exceed the resolve's fetch cap:
   * above it the resolve sees an arbitrary subset, and which subset is decided by atomic
   * retirement order — so the frame stops being a function of the cache.
   */
  private reportGridOccupancy(renderer: THREE.WebGPURenderer): void {
    const at = giKnobs.gridStatsAt();
    if (at <= 0 || this.gridStatsDone || renderer.info.frame < at) return;
    this.gridStatsDone = true;

    const attr = this.grid.getOffsetsAndListAttr();
    if (!attr) return;

    void renderer
      .getArrayBufferAsync(attr as unknown as THREE.BufferAttribute)
      .then((buffer) => {
        const ints = new Int32Array(buffer);
        const header = TOTAL_CELLS + 1;
        const counts: number[] = [];
        let over = 0;
        let inOver = 0;
        let total = 0;
        // Cell index is x + y*CS + z*CS² + cascade*CS³, so the cascade a cell belongs to
        // is the quotient. Broken out because cell size doubles per cascade and therefore
        // so does the density a cell has to hold: if the overfull cells are all coarse,
        // no amount of thinning the cache fixes them for a camera standing further back.
        const perCascade = new Array<number>(CASCADES).fill(0);
        const overPerCascade = new Array<number>(CASCADES).fill(0);
        const cascadeSpan = SURFEL_CS * SURFEL_CS * SURFEL_CS;
        for (let i = 0; i < TOTAL_CELLS; i++) {
          const n = ints[i + 1] - ints[i];
          if (n <= 0) continue;
          counts.push(n);
          total += n;
          const cascade = Math.floor(i / cascadeSpan);
          perCascade[cascade] = (perCascade[cascade] ?? 0) + 1;
          if (n > RESOLVE_FETCH_CAP) {
            over++;
            inOver += n;
            overPerCascade[cascade] = (overPerCascade[cascade] ?? 0) + 1;
          }
        }
        counts.sort((a, b) => a - b);
        const pct = (p: number) => counts[Math.floor((counts.length - 1) * p)] ?? 0;
        console.log(
          `[gridstats] frame ${renderer.info.frame}: ${counts.length} occupied cells, ` +
            `${total} entries, occupancy p50=${pct(0.5)} p90=${pct(0.9)} p99=${pct(0.99)} ` +
            `max=${counts[counts.length - 1] ?? 0}; ${over} cells over the resolve's ` +
            `fetch cap of ${RESOLVE_FETCH_CAP}, holding ${inOver} entries ` +
            `(${((100 * inOver) / Math.max(1, total)).toFixed(1)}% of the grid). ` +
            `cells/cascade [${perCascade}] over/cascade [${overPerCascade}]. ` +
            `header ${header} ints`,
        );
      })
      .catch((error) => console.error('[gridstats] readback failed', error));
  }

  /* @important Counted phases, not a wall clock: a clock never stopped spawning, so 23 views put
     10,144 entries into the hash grid and 618 views 41,809 into the same ~950 cells; past the
     RESOLVE_FETCH_CAP density 51.7 % of cells returned a different subset every frame and a wedge
     flickered 6..75 with the cache byte-identical. Spawn views, then hold the population and run
     800 integrations; `?bakeclock=1` is the old budget as ablation. Pool growth is refused for
     the duration because it discards the radiance. */
  async bake(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    options: {
      durationMs?: number;
      raysPerSurfel?: number;
      /** Orbit elevations cycled through, in radians. Only used by the fallback. */
      elevations?: number[];
      onProgress?: (fraction: number, frames: number) => void;
    } = {},
  ): Promise<{ frames: number; ms: number; seeded: number }> {
    const {
      durationMs = 5000,
      raysPerSurfel = 32,
      elevations = [0.15, 0.45, 0.8],
      onProgress,
    } = options;

    this._frozen = false;
    this.setBaseSampleCount(raysPerSurfel);

    const bounds = this.staticBounds(scene);
    const centre = bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(0.5, bounds.getBoundingSphere(new THREE.Sphere()).radius);

    const seeded = giKnobs.geometrySeed()
      ? this.seedFromGeometry(renderer, scene)
      : 0;

    // Only ever alongside the orbit sweep. `geoseed` deletes the sweep, and a pass whose
    // entire contract is "spawn where find-missing did not" has nothing to supplement
    // when find-missing is not in the loop.
    let holeFill: ReturnType<typeof createSurfelHoleFill> | null =
      seeded === 0 && giKnobs.holeFill() ? this.createHoleFill(scene) : null;
    let filling = false;

    const deterministic = giKnobs.deterministicBake();

    // geoseed places the entire population up front, so it has nothing to spawn and its
    // whole budget is integration. The orbit sweep is the one that grows as it goes.
    const spawnViews =
      seeded > 0 ? 0 : Math.max(0, Math.round(giKnobs.bakeSpawnViews()));
    const integrations = Math.max(1, Math.round(giKnobs.bakeIntegrations()));
    const scheduled = spawnViews + integrations;

    // Nothing may grow the pool between here and the immortaliser. Growth replaces every
    // buffer and the converged radiance in them is gone; whether it fires at all depends
    // on how many surfels happened to be alive when a periodic readback landed, which is
    // GPU scheduling rather than scene content. Refusing outright and reporting occupancy
    // afterwards turns a silent coin flip into a number.
    this.bakeFreezesPool = deterministic;

    let start = performance.now();
    let frames = 0;
    let generation = this.pool.getGeneration();
    let overran = false;

    // The fixed viewpoint the grid and the bounce weighting are parameterised by.
    const bakeCamera = new THREE.PerspectiveCamera(100, 1, 0.05, radius * 20);
    bakeCamera.position.copy(centre);
    bakeCamera.updateMatrixWorld();

    for (;;) {
      if (deterministic) {
        if (frames >= scheduled) break;
        if (performance.now() - start > BAKE_WALL_CLOCK_CAP_MS) {
          overran = true;
          break;
        }
      } else if (performance.now() - start >= durationMs) {
        break;
      }

      // A pool that grows mid-bake takes the partially converged cache with it, so the
      // frames spent so far bought nothing. Restarting the clock is the difference
      // between "the bake was interrupted and shipped half-converged" and "the bake cost
      // twice as long once, on a scene that needed a bigger pool".
      const currentGeneration = this.pool.getGeneration();
      if (currentGeneration !== generation) {
        generation = currentGeneration;
        console.warn(
          `[gi] the surfel pool grew ${frames} views into the bake; the cache it had ` +
            'built went with it. Restarting the bake budget against the new pool.',
        );
        start = performance.now();
        frames = 0;
        // The fill's nodes bind the pool that just went away, and the surfels it had
        // spawned went with it. Both have to start over, or `keepAlive` pays rent on
        // slot indices that now belong to somebody else.
        holeFill = giKnobs.holeFill() ? this.createHoleFill(scene) : null;
        filling = false;
      }

      // Spawning is a phase, not the whole bake. Every orbit view adds surfels wherever
      // the previous one lacked coverage and nothing ever calls that finished, so a
      // longer sweep does not converge the cache — it thickens it, until a hash-grid cell
      // holds more surfels than the resolve will read out of one and the pixels it feeds
      // are drawn from an arbitrary subset. Coverage is reached in a few dozen views;
      // everything after that is spent on radiance instead.
      const spawning = frames < spawnViews;
      const fraction = deterministic
        ? frames / scheduled
        : (performance.now() - start) / durationMs;

      if (seeded > 0 || (deterministic && !spawning)) {
        if (frames === spawnViews) {
          // Back to the centre for the convergence phase, for the same reason the geoseed
          // path never leaves it: the grid and the bounce weighting are parameterised by a
          // viewpoint, and a bake needs that parameter to be a constant rather than
          // whichever way the sweep happened to stop looking.
          bakeCamera.position.copy(centre);
          bakeCamera.updateMatrixWorld();
        }
        // The integrator keys its blue-noise sequence off the frame counter and nothing
        // renders here, so without advancing it by hand every iteration would cast the
        // same directions and the estimate would never move.
        renderer.info.frame++;
        this.grid.build(renderer, this.pool, bakeCamera);
        this.integratorArgs.run(renderer, this.pool);
        this.integrate!.run(
          renderer,
          this.pool,
          this.bvh!,
          this.dynamicBvh!,
          this.grid,
          bakeCamera,
          scene,
          this.integratorArgs.getIndirectAttr(),
          { includeDynamic: false },
        );
        this.pool.swapMoments();
      } else {
        // Fallback (`?geoseed=0`): the original orbit sweep, kept whole so the coverage
        // claim can be measured against the thing it replaced.
        const azimuth = frames * 2.39996323;
        const elevation = elevations[frames % elevations.length];
        const inset = radius * 0.35;

        bakeCamera.position.set(
          centre.x + Math.cos(azimuth * 0.37) * inset,
          centre.y + Math.sin(azimuth * 0.23) * inset * 0.5,
          centre.z + Math.sin(azimuth * 0.37) * inset,
        );
        bakeCamera.lookAt(
          centre.x + Math.cos(azimuth) * Math.cos(elevation) * radius * 4,
          centre.y + Math.sin(elevation - 0.4) * radius * 4,
          centre.z + Math.sin(azimuth) * Math.cos(elevation) * radius * 4,
        );
        bakeCamera.updateMatrixWorld();

        this.update(renderer, scene, bakeCamera, { staticOnly: true });

        if (holeFill) {
          // After `update`, so the coverage query reads a grid that already contains
          // everything this view spawned.
          const sweep = deterministic
            ? frames / Math.max(1, spawnViews)
            : fraction;
          if (sweep >= HOLE_FILL_FROM && sweep <= HOLE_FILL_TO) {
            holeFill.fill(renderer, this.pool, this.grid, bakeCamera);
            filling = true;
          }
          if (filling) holeFill.keepAlive(renderer);
        }
      }

      frames++;
      onProgress?.(Math.min(1, fraction), frames);

      // Yield so the GPU actually executes and the page stays responsive.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    const ms = performance.now() - start;
    this.bakeFreezesPool = false;
    this.setBaseSampleCount(this.runtimeSampleCount);

    if (overran) {
      console.error(
        `[gi] the bake hit its ${(BAKE_WALL_CLOCK_CAP_MS / 1000).toFixed(0)}s wall-clock ` +
          `safety cap after ${frames} of ${scheduled} scheduled iterations. This result is ` +
          'NOT reproducible — how much of the schedule ran was decided by the clock, which ' +
          'is exactly what the counted schedule exists to avoid. Treat every number taken ' +
          'from this cache as noise.',
      );
    }

    // The pool was not allowed to grow above, so if the bake filled it past the point the
    // runtime allocator would have doubled at, the first frames after this will do the
    // growing instead — and take the cache that was just paid for with them.
    if (deterministic) await this.reportBakeOccupancy(renderer);

    // Read before pinning, so the number reported is what the fill actually placed
    // rather than what survived the immortaliser's convergence test.
    const filled = holeFill ? await holeFill.readSpawned(renderer) : 0;

    // Everything alive at this point is the static cache: make it immortal so it
    // survives without re-integration, then hand the lifecycle back so movable
    // geometry can still get surfels of its own.
    this.immortaliser.run(renderer, this.pool);

    this._frozen = this.freezeCompletely;

    const schedule = !deterministic
      ? `${frames} orbit views under a ${(durationMs / 1000).toFixed(1)}s clock`
      : seeded > 0
        ? `${frames} integrations of ${seeded} geometry-seeded surfels`
        : `${spawnViews} spawn views + ${integrations} integrations`;

    console.log(
      `[gi] baked in ${(ms / 1000).toFixed(2)}s over ${schedule}` +
        (holeFill
          ? `, ${filled} surfels hole-filled from ${holeFill.candidates} candidates`
          : '') +
        '; static cache pinned' +
        (this._frozen ? ', all passes frozen' : ', lifecycle live for movers'),
    );
    return { frames, ms, seeded };
  }

  /**
   * Reports how full the pool is once a counted bake has finished.
   *
   * Growth is refused for the duration of such a bake, so this is where the refusal gets
   * paid for: if the population landed above the threshold the runtime allocator doubles
   * at, the frames immediately after this will grow and take the cache with them. Loud,
   * because the symptom — a cache that vanishes a second after it was built — looks
   * nothing like its cause.
   */
  private async reportBakeOccupancy(renderer: THREE.WebGPURenderer): Promise<void> {
    const attr = this.pool.getPoolAllocAttr();
    if (!attr) return;
    try {
      const buffer = await renderer.getArrayBufferAsync(attr);
      const alive = new Int32Array(buffer)[0] ?? 0;
      const capacity = this.pool.getCapacity();
      if (alive >= capacity * SURFEL_POOL_GROW_AT) {
        console.error(
          `[gi] the bake left ${alive}/${capacity} pool slots in use, at or above the ` +
            `${(SURFEL_POOL_GROW_AT * 100).toFixed(0)}% mark the runtime allocator doubles ` +
            'at. It will double on one of the next few frames and the cache just baked ' +
            'does not survive that. Raise ?surfels= past ' +
            `${Math.ceil(alive / (SURFEL_POOL_GROW_AT * 0.9))} and bake again.`,
        );
      }
    } catch (error) {
      console.error('[gi] post-bake pool occupancy readback failed', error);
    }
  }

  /**
   * Fills the pool from the static geometry, growing it first if the sample set needs
   * more slots than it currently holds.
   *
   * The budget handed to the sampler is the pool's ceiling rather than its current
   * size, because a bake is the one consumer that genuinely wants the ceiling — the
   * same argument `bakeLightmap` makes — and because discovering the shortfall during
   * seeding means the tail of the world bakes black.
   */
  private seedFromGeometry(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
  ): number {
    if (!this.bvh) return 0;

    const override = giKnobs.geometrySeedBudget();
    const budget = Math.min(
      MAX_SURFELS,
      override > 0 ? override : Math.max(SURFEL_POOL_BASE, 65536),
    );

    const seeds = sampleStaticSurfaces(scene, this.bvh.materialIdByUUID, { budget });
    if (seeds.count === 0) {
      console.error(
        '[geoseed] the static scene sampled to zero surfels. Falling back to the orbit ' +
          'sweep, which covers what a camera can see and leaves concave corners empty.',
      );
      return 0;
    }

    // Headroom above the growth threshold, not just above the seed count. A pool that
    // the seeds fill to 99 % is a pool `maybeGrowPool` doubles on the first runtime
    // frame after the bake — and growth throws the cache away, so the entire bake would
    // be spent and then discarded a frame later. Sizing so occupancy lands under
    // `SURFEL_POOL_GROW_AT` is what stops that.
    this.ensurePoolCapacity(
      renderer,
      Math.min(MAX_SURFELS, Math.ceil(seeds.count / (SURFEL_POOL_GROW_AT * 0.9)) + 256),
    );

    if (!this.geometrySeeder) {
      // Sized against what was actually sampled, not against the budget: the sampler
      // solves a spacing and then deduplicates, so its output overshoots the budget by
      // whatever the dedup did not remove, and a seed buffer sized to the budget
      // silently drops the tail.
      this.geometrySeeder = createGeometrySeeder(this.pool, seeds.count);
    }
    return this.geometrySeeder.run(renderer, seeds);
  }

  private geometrySeeder: ReturnType<typeof createGeometrySeeder> | null = null;
  private lightmapFilterLinks: ReturnType<typeof createFilterLinks> | null = null;

  /**
   * Builds the candidate set the hole fill tests for coverage.
   *
   * It borrows `sampleStaticSurfaces` — the same area sampler `geoseed` uses, and the
   * same one the BVH's own gather feeds, so a candidate always stands on a triangle a
   * ray can actually hit. What it does *not* borrow is geoseed's conclusion. There the
   * sample set became the cache; here it is only a list of questions, and all but a few
   * hundred of them are answered "already covered, do nothing".
   *
   * The budget is therefore about candidate density, not about pool spend: it decides
   * how finely the fill can resolve a hole, and the surfels it costs are bounded by how
   * much of the world the sweep missed rather than by how many points are on this list.
   */
  private createHoleFill(
    scene: THREE.Scene,
  ): ReturnType<typeof createSurfelHoleFill> | null {
    if (!this.bvh) return null;

    const override = giKnobs.holeFillBudget();
    const budget = Math.min(
      MAX_SURFELS,
      override > 0 ? override : Math.max(SURFEL_POOL_BASE, 65536),
    );
    const seeds = sampleStaticSurfaces(scene, this.bvh.materialIdByUUID, { budget });
    if (seeds.count === 0) {
      console.error(
        '[holefill] the static scene sampled to zero candidates; the bake is back on ' +
          'the orbit sweep alone and concave corners will stay empty.',
      );
      return null;
    }

    return createSurfelHoleFill(seeds, {
      coverage: giKnobs.holeFillCoverage(),
      rate: giKnobs.holeFillRate(),
      edge: giKnobs.holeFillEdge(),
    });
  }

  /**
   * Full freeze halts spawning entirely, which is cheapest but leaves anything that
   * moves without indirect light. Off by default: a black moving object is a worse
   * failure than a few hundred microseconds.
   */
  freezeCompletely = false;

  /** World bounds of everything tagged `Layer.GiStatic`. */
  private staticBounds(scene: THREE.Scene): THREE.Box3 {
    const box = new THREE.Box3();
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      if (!mesh.layers.isEnabled(Layer.GiStatic)) return;
      box.expandByObject(mesh);
    });
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(4, 4, 4));
    return box;
  }

  setBaseSampleCount(count: number): void {
    this.integrate?.setBaseSampleCount(count);
  }

  async readIntegrationSchedule(renderer: THREE.WebGPURenderer) {
    const schedule = await this.integrationSchedule.read(renderer);
    if (!schedule) return null;
    const moments = new Float32Array(await renderer.getArrayBufferAsync(this.pool.getMomentsAttr()!));
    const spatial = new Float32Array(await renderer.getArrayBufferAsync(this.pool.getSurfelAttr()!));
    const offset = this.pool.getOffsets().readOffset * 20;
    return { ...schedule, moments: Array.from(moments.subarray(offset, offset + this.pool.getCapacity() * 20)),
      spatial: Array.from(spatial) };
  }

  /**
   * Reads the surfel buffer back off the GPU and counts what is actually in it.
   *
   * This is the only way to answer "is there a cache, or is it being rebuilt every
   * frame" with a number instead of an opinion. Stride is 8 floats per surfel
   * (posb.xyzw, normal.xyz, age); age occupies the last slot as raw int bits.
   */
  async readSurfelStats(renderer: THREE.WebGPURenderer): Promise<{
    capacity: number;
    alive: number;
    pinned: number;
    live: number;
    recycled: number;
  } | null> {
    const attr = this.pool.getSurfelAttr();
    if (!attr) return null;

    const buffer = await renderer.getArrayBufferAsync(attr as unknown as THREE.BufferAttribute);
    const ints = new Int32Array(buffer);
    const stride = 8;
    const capacity = Math.floor(ints.length / stride);

    let pinned = 0;
    let live = 0;
    let recycled = 0;
    for (let i = 0; i < capacity; i++) {
      const age = ints[i * stride + 7];
      if (age < 0) pinned++;
      else if (age < SURFEL_TTL) live++;
      else recycled++;
    }
    return { capacity, alive: pinned + live, pinned, live, recycled };
  }

  readRigidSurfelState(renderer: THREE.WebGPURenderer) {
    return this.motion?.readState(renderer, this.pool) ?? null;
  }

  /**
   * Bakes the lightmap by running webgiya's integrator on surfels that live in the
   * atlas instead of on screen.
   *
   * The loop below is `update()` with the screen half deleted. What is gone is only
   * ever the camera-shaped part — the G-Buffer render, find-missing, allocate, age,
   * resolve. What remains is upstream's, verbatim and in upstream's order:
   *
   *   grid build → integrator args → integrate (BVH RT, SLG, MSME) → swap moments
   *
   * The one camera that remains is a fixed point at the centre of the static bounds,
   * because the grid is camera-centred and `lookupSurfelGI` weights the *bounce* by
   * distance to it. Fixed, so that weighting is a constant property of the bake
   * rather than a function of where anyone was standing.
   */
  async bakeLightmap(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    gbuffer: LightmapGBuffer,
    size: number,
    options: {
      iterations?: number;
      raysPerSurfel?: number;
      /**
       * Viewpoint the hash grid is centred on. The bake does not render from it --
       * it exists because `surfel_radius_for_pos` and therefore the weighting inside
       * `lookupSurfelGI` are parameterised by a camera, so the bounce term needs one.
       * Defaults to the centre of the static bounds.
       */
      viewpoint?: THREE.Vector3;
      /** Bilateral filter passes over the finished atlas. */
      denoise?: number;
      /** Gutter-fill passes, so bilinear at a chart border never reads a hole. */
      dilate?: number;
      /** Keep webgiya's lifecycle running beside the baked atlas for moving receivers. */
      dynamicReceivers?: boolean;
      denoiseIgnoresSurface?: boolean;
      filterLinks?: ContactBVHBundle | null;
      height?: number;
      freshSurfels?: boolean;
      onStage?: (name: string, pixels: Float32Array) => void;
      onProgress?: (fraction: number, iteration: number) => void;
    } = {},
  ): Promise<{
    texture: THREE.Texture;
    seeded: number;
    stats: Awaited<ReturnType<ReturnType<typeof createLightmapSurfels>['readStats']>>;
  } | null> {
    if (!this.bvh || !this.dynamicBvh || !this.integrate) return null;

    // MSME accumulates to MAX_TEMPORAL_M samples and no further, so that is what the
    // default is -- not a number that happens to resemble it. See the note on the
    // constant for why this stopped being written out by hand in two places.
    const {
      iterations = MAX_TEMPORAL_M,
      raysPerSurfel = 32,
      viewpoint,
      denoise,
      dilate,
      denoiseIgnoresSurface,
      filterLinks,
      height = size,
      freshSurfels,
      onStage,
      onProgress,
    } = options;

    // A lightmap bake is the one consumer that genuinely wants the ceiling: it spends
    // one surfel per covered atlas texel, and a 512 atlas on a 400 m landscape covers
    // ~143 k of them. Growing here rather than discovering the shortfall during seeding
    // is what stops the tail of the atlas baking black — and this is the safe moment to
    // do it, because `resetCache` has already thrown the runtime cache away.
    this.ensurePoolCapacity(renderer, Math.min(MAX_SURFELS, size * height));

    if (freshSurfels) this.lightmapSurfels = null;
    if (!this.lightmapSurfels) {
      this.lightmapSurfels = createLightmapSurfels(this.pool, size, height);
    }
    const lm = this.lightmapSurfels;

    const start = performance.now();

    if (!lm.seed(renderer, gbuffer)) return null;
    const seeded = await lm.countSeeded(renderer);
    console.log(`[lightmap] seeded ${seeded} surfels from the atlas`);
    if (seeded === 0) return null;

    this.setBaseSampleCount(raysPerSurfel);

    // A fixed viewpoint at the centre of the static world. Nothing is rendered from
    // it — it exists because the hash grid and the bounce lookup are parameterised
    // by a camera position, and a bake needs that parameter to be a constant.
    const bounds = this.staticBounds(scene);

    const camera = new THREE.PerspectiveCamera();
    camera.position.copy(viewpoint ?? bounds.getCenter(new THREE.Vector3()));
    camera.updateMatrixWorld();

    for (let i = 0; i < iterations; i++) {
      // The integrator keys its blue-noise sequence and MSME window off the frame
      // counter, and nothing renders during a bake — so without advancing it by hand
      // every iteration would cast the *same* directions and never converge.
      renderer.info.frame++;

      this.grid.build(renderer, this.pool, camera);
      this.integratorArgs.run(renderer, this.pool);
      this.integrate.run(
        renderer,
        this.pool,
        this.bvh!,
        this.dynamicBvh!,
        this.grid,
        camera,
        scene,
        this.integratorArgs.getIndirectAttr(),
        // A lightmap is by definition the static half. Anything movable in it is a
        // stain that no amount of re-baking removes.
        { includeDynamic: false },
      );
      this.pool.swapMoments();

      onProgress?.((i + 1) / iterations, i + 1);
      // Yield so the GPU actually executes and the page stays responsive; a whole
      // bake submitted in one tick is how a driver reset happens.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    // Plane epsilon scales with the world: it decides which neighbouring texels are
    // "the same surface", and a fixed constant would either bleed across faces in a
    // small scene or reject valid neighbours in a large one.
    const planeEpsilon =
      bounds.getSize(new THREE.Vector3()).length() * 0.0025;
    let useLinks = false;
    if (filterLinks) {
      if (!this.lightmapFilterLinks) this.lightmapFilterLinks = createFilterLinks(size, lm.links);
      const support = bounds.getSize(new THREE.Vector3()).length() * 0.05;
      this.lightmapFilterLinks.run(renderer, gbuffer, filterLinks, { supportMetres: support });
      const stats = await this.lightmapFilterLinks.readStats(renderer);
      console.log(`[lightmap] filter links: ${stats.links} allowed, ${stats.blocked} blocked across ${stats.texels} texels, ${stats.hidden} hidden inside solids, support ${support.toFixed(2)} m`);
      useLinks = true;
    }
    await lm.writeAtlas(renderer, gbuffer, { denoise, dilate, planeEpsilon, denoiseIgnoresSurface, useLinks, onStage });
    const stats = await lm.readStats(renderer);
    this.setBaseSampleCount(this.runtimeSampleCount);

    // Pin the atlas, so the lifecycle can be left running for everything that is not in
    // it. This is `bake()`'s last step, applied to the other kind of bake for the same
    // reason: a pinned surfel is skipped by the age pass and by the integrator and is
    // never pushed back onto the free list, so the atlas holds pool slots `[0, seeded)`
    // for good and the allocator's only reachable region is the tail. Movable geometry
    // then gets real surfels — with MSME behind them — instead of nothing at all.
    //
    // After `writeAtlas`, which is deliberate: the atlas texture is finished and read
    // back before anything is allowed to change the pool's meaning, so `?dynsurfel=1`
    // cannot alter a single texel of the lightmap it is bolted onto.
    if (options.dynamicReceivers ?? giKnobs.dynamicSurfels()) {
      this.immortaliser.run(renderer, this.pool);
      this.atlasPinned = true;
      if (this.rigidSurfels) this.pool.setAnchorStart(renderer, seeded);
      this._frozen = false;
    }

    const ms = performance.now() - start;
    console.log(
      `[lightmap] ${iterations} integrations × ${raysPerSurfel} rays in ${(ms / 1000).toFixed(2)}s — ` +
        `${stats.lit}/${stats.total} texels lit, ${stats.filled} gutter-filled, ` +
        `${stats.black} black, ` +
        `mean ${stats.meanLuma.toFixed(4)}, max ${stats.maxLuma.toFixed(3)}` +
        (this.atlasPinned
          ? `; ${seeded} atlas surfels pinned, lifecycle live for movers`
          : ''),
    );

    return { texture: lm.lightmap, seeded, stats };
  }

  /** Ray count to fall back to after a bake. */
  setRuntimeSampleCount(count: number): void {
    this.runtimeSampleCount = count;
    if (!this._frozen) this.setBaseSampleCount(count);
  }

  /** Bounce rays that stop on foliage also collect the light coming through the leaf. */
  setLeafTransmit(enabled: boolean): void {
    this.leafTransmitEnabled = enabled;
    this.integrate?.setLeafTransmit(enabled);
  }

  setEnvControls(intensity: number, lod: number): void {
    this.lightingControls.envIntensity = intensity;
    this.lightingControls.envLod = lod;
    this.integrate?.setEnvControls(intensity, lod);
  }

  setGiScales(fromDirect: number, fromIndirect: number): void {
    this.lightingControls.fromDirect = fromDirect;
    this.lightingControls.fromIndirect = fromIndirect;
    this.integrate?.setGiScales(fromDirect, fromIndirect);
  }

  setAlbedoBoost(boost: number): void {
    this.lightingControls.albedoBoost = boost;
    this.integrate?.setAlbedoBoost(boost);
  }

  /**
   * Turns tracing of the dynamic BVH on and off without touching the scene. The mover
   * stays rastered and stays in the surfel population, so a pair of captures taken
   * across this switch differs in exactly one thing: whether a ray can see it.
   */
  setDynamicTracing(enabled: boolean): void {
    this.dynamicTracing = enabled;
    this.integrate?.setDynamicTracing(enabled);
  }

  private dynamicTracing = true;
}
