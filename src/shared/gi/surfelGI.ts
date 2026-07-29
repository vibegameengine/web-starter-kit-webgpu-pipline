import * as THREE from 'three/webgpu';
import { HDRLoader } from 'three/examples/jsm/Addons.js';
import { Layer } from '../world/index.ts';
import { createSurfelImmortaliser } from './immortalise.ts';
import { createCacheAtlas } from './cacheAtlas.ts';

import { MAX_SURFELS } from './surfel/constants.ts';
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
      const azimuth = frames * 2.39996323;
      const elevation = elevations[frames % elevations.length];
      const dist = radius * 1.15;

      bakeCamera.position.set(
        centre.x + Math.cos(azimuth) * Math.cos(elevation) * dist,
        centre.y + Math.sin(elevation) * dist,
        centre.z + Math.sin(azimuth) * Math.cos(elevation) * dist,
      );
      bakeCamera.lookAt(centre);
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
