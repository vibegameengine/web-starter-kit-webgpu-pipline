import * as THREE from 'three/webgpu';
import { HDRLoader } from 'three/examples/jsm/Addons.js';
import { Layer } from '../world/index.ts';
import { createSurfelImmortaliser } from './immortalise.ts';
import { createCacheAtlas } from './cacheAtlas.ts';
import { createLightmapSurfels } from './bake/lightmapSurfels.ts';
import type { LightmapGBuffer } from './bake/lightmapGBuffer.ts';

import { MAX_SURFELS, SURFEL_TTL } from './surfel/constants.ts';
import { createGBuffer } from './surfel/gbuffer.ts';
import { createSceneBVH, type SceneBVHBundle } from './surfel/sceneBvh.ts';
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
 * The known limits are inherited too: the BVH is built once over static geometry, and
 * alpha-tested foliage has no representation. Both are Phase 6 problems.
 */
export class SurfelGI {
  private readonly gbuffer: ReturnType<typeof createGBuffer>;
  private readonly pool: ReturnType<typeof createSurfelPool>;
  private readonly prepare = createSurfelPreparePass();
  private readonly age = createSurfelAgePass();
  private readonly findMissing = createSurfelFindMissingPass();
  private readonly allocate = createSurfelAllocatePass();
  private readonly dispatchArgs = createSurfelDispatchArgs();
  private readonly grid = createSurfelHashGrid();
  private readonly integratorArgs = createIntegratorDispatchArgs();
  private readonly resolve: ReturnType<typeof createSurfelGIResolvePass>;

  private integrate: ReturnType<typeof createSurfelIntegratePass> | null = null;
  private bvh: SceneBVHBundle | null = null;

  private readonly prevCameraPos = new THREE.Vector3();
  private lastOutput: THREE.Texture | null = null;
  private _frozen = false;
  /** Ray count restored after a bake finishes. */
  private runtimeSampleCount = 4;
  private readonly immortaliser = createSurfelImmortaliser();
  private cacheAtlas: ReturnType<typeof createCacheAtlas> | null = null;
  private lightmapSurfels: ReturnType<typeof createLightmapSurfels> | null = null;

  readonly envTexture: THREE.DataTexture;

  private constructor(
    renderer: THREE.WebGPURenderer,
    private readonly blueNoise: THREE.Texture,
    envTexture: THREE.DataTexture,
  ) {
    this.envTexture = envTexture;
    this.gbuffer = createGBuffer(renderer);
    this.pool = createSurfelPool();
    this.pool.ensureCapacity(MAX_SURFELS);
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
    this.bvh = createSceneBVH(renderer, scene);
    this.integrate = createSurfelIntegratePass(this.blueNoise, this.envTexture);
    this.prepare.run(renderer, this.pool, { forceClear: true });
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
    this.prepare.run(renderer, this.pool, { forceClear: true });
  }

  resize(renderer: THREE.WebGPURenderer): void {
    this.gbuffer.resize(renderer);
  }

  /** True once the resolve pass has produced a texture to composite. */
  get outputTexture(): THREE.Texture | null {
    return this.resolve.getOutputTexture();
  }

  /** The G-Buffer albedo the composite multiplies indirect light by. */
  get albedoTexture(): THREE.Texture {
    return this.gbuffer.target.textures[1];
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
    this.cacheAtlas = createCacheAtlas(momentsAttr, MAX_SURFELS);
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
    this._frozen = frozen;
  }

  /**
   * Runs the GI chain. Returns true when the output texture identity changed, which
   * means the composite node must be rebuilt (it changes on resize).
   *
   * `staticOnly` restricts the G-Buffer to `Layer.GiStatic`, so surfels are neither
   * spawned on movable geometry nor fed radiance from it. Used during the bake: a
   * frozen cache must not contain a moving object's lighting frozen with it.
   */
  update(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    dirLight: THREE.DirectionalLight,
    options: { staticOnly?: boolean } = {},
  ): boolean {
    if (!this.bvh || !this.integrate) {
      this.prevCameraPos.copy(camera.position);
      return false;
    }

    // --- G-Buffer, offscreen -------------------------------------------------
    const previousTarget = renderer.getRenderTarget();
    const previousBackground = scene.background;
    const cameraLayers = camera.layers.mask;

    scene.background = null;
    camera.layers.set(options.staticOnly ? Layer.GiStatic : 0);
    renderer.setMRT(this.gbuffer.sceneMRT);
    renderer.setRenderTarget(this.gbuffer.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previousTarget);
    renderer.setMRT(null);
    camera.layers.mask = cameraLayers;
    scene.background = previousBackground;

    // --- surfel lifecycle (skipped once frozen) ------------------------------
    this.prepare.run(renderer, this.pool);

    if (!this._frozen) {
      const found = this.findMissing.run(
        renderer,
        camera,
        this.gbuffer,
        this.pool,
        this.grid,
        this.prevCameraPos,
      );
      this.dispatchArgs.run(renderer, this.pool);

      this.age.run(
        renderer,
        this.pool,
        this.findMissing,
        this.grid,
        this.prevCameraPos,
        this.dispatchArgs.getIndirectAttr(),
      );
      this.allocate.run(renderer, this.pool, this.findMissing, found.tileCount);
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
        this.grid,
        camera,
        dirLight,
        this.integratorArgs.getIndirectAttr(),
      );
    }

    this.resolve.run(renderer, camera, this.gbuffer);

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

  /**
   * Converges the cache against static geometry under a wall-clock budget, then
   * freezes it.
   *
   * Surfels are spawned from the G-Buffer, so a bake from a single viewpoint only
   * covers what that viewpoint sees — turn the camera afterwards and the rest of the
   * world has no GI. The bake therefore sweeps a virtual camera around the static
   * bounds on an orbit at several elevations, at a wide FOV, so coverage is driven by
   * the geometry rather than by wherever the player happened to be standing.
   *
   * Ray count is raised for the duration: convergence quality is paid for once here
   * instead of every frame forever.
   */
  async bake(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    dirLight: THREE.DirectionalLight,
    options: {
      durationMs?: number;
      raysPerSurfel?: number;
      /** Orbit elevations cycled through, in radians. */
      elevations?: number[];
      onProgress?: (fraction: number, frames: number) => void;
    } = {},
  ): Promise<{ frames: number; ms: number }> {
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

    const bakeCamera = new THREE.PerspectiveCamera(100, 1, 0.05, radius * 20);

    const start = performance.now();
    let frames = 0;

    while (performance.now() - start < durationMs) {
      const elapsed = performance.now() - start;
      const fraction = elapsed / durationMs;

      // Golden-angle azimuth so successive views are spread out rather than
      // sweeping slowly through one side of the room first.
      // Inside the volume looking outward, not orbiting outside it. Surfels are
      // spawned from the G-Buffer, so an exterior orbit never sees inward-facing
      // surfaces -- which is precisely where a Cornell box needs coverage.
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

      this.update(renderer, scene, bakeCamera, dirLight, { staticOnly: true });

      frames++;
      onProgress?.(Math.min(1, fraction), frames);

      // Yield so the GPU actually executes and the page stays responsive.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    const ms = performance.now() - start;
    this.setBaseSampleCount(this.runtimeSampleCount);

    // Everything alive at this point is the static cache: make it immortal so it
    // survives without re-integration, then hand the lifecycle back so movable
    // geometry can still get surfels of its own.
    const surfelAttr = this.pool.getSurfelAttr();
    if (surfelAttr) this.immortaliser.run(renderer, surfelAttr);

    this._frozen = this.freezeCompletely;

    console.log(
      `[gi] baked in ${(ms / 1000).toFixed(2)}s over ${frames} views; static cache pinned` +
        (this._frozen ? ', all passes frozen' : ', lifecycle live for movers'),
    );
    return { frames, ms };
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
    dirLight: THREE.DirectionalLight,
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
      onProgress?: (fraction: number, iteration: number) => void;
    } = {},
  ): Promise<{
    texture: THREE.Texture;
    seeded: number;
    stats: Awaited<ReturnType<ReturnType<typeof createLightmapSurfels>['readStats']>>;
  } | null> {
    if (!this.bvh || !this.integrate) return null;

    // 200, not 64: MSME accumulates to MAX_TEMPORAL_M = 200 samples, so anything
    // less leaves every texel short of the temporal convergence the runtime reaches
    // in a few hundred frames -- and the shortfall is visible as per-texel grain,
    // because unlike the runtime resolve a bake has nothing averaging texels together.
    const {
      iterations = 200,
      raysPerSurfel = 32,
      viewpoint,
      denoise,
      dilate,
      onProgress,
    } = options;

    if (!this.lightmapSurfels) {
      this.lightmapSurfels = createLightmapSurfels(this.pool, size);
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
        this.bvh,
        this.grid,
        camera,
        dirLight,
        this.integratorArgs.getIndirectAttr(),
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
    lm.writeAtlas(renderer, gbuffer, { denoise, dilate, planeEpsilon });
    const stats = await lm.readStats(renderer);
    this.setBaseSampleCount(this.runtimeSampleCount);

    const ms = performance.now() - start;
    console.log(
      `[lightmap] ${iterations} integrations × ${raysPerSurfel} rays in ${(ms / 1000).toFixed(2)}s — ` +
        `${stats.lit}/${stats.total} texels lit, ${stats.filled} gutter-filled, ` +
        `${stats.black} black, ` +
        `mean ${stats.meanLuma.toFixed(4)}, max ${stats.maxLuma.toFixed(3)}`,
    );

    return { texture: lm.lightmap, seeded, stats };
  }

  /** Ray count to fall back to after a bake. */
  setRuntimeSampleCount(count: number): void {
    this.runtimeSampleCount = count;
    if (!this._frozen) this.setBaseSampleCount(count);
  }

  setEnvControls(intensity: number, lod: number): void {
    this.integrate?.setEnvControls(intensity, lod);
  }

  setGiScales(fromDirect: number, fromIndirect: number): void {
    this.integrate?.setGiScales(fromDirect, fromIndirect);
  }

  setAlbedoBoost(boost: number): void {
    this.integrate?.setAlbedoBoost(boost);
  }
}
