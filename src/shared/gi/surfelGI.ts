import * as THREE from 'three/webgpu';
import { HDRLoader } from 'three/examples/jsm/Addons.js';

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
   * Runs the full GI chain. Returns true when the output texture identity changed,
   * which means the composite node must be rebuilt (it changes on resize).
   */
  update(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    dirLight: THREE.DirectionalLight,
  ): boolean {
    if (!this.bvh || !this.integrate) {
      this.prevCameraPos.copy(camera.position);
      return false;
    }

    // --- G-Buffer, offscreen, layer 0 only -----------------------------------
    const previousTarget = renderer.getRenderTarget();
    const previousBackground = scene.background;
    const cameraLayers = camera.layers.mask;

    scene.background = null;
    camera.layers.set(0);
    renderer.setMRT(this.gbuffer.sceneMRT);
    renderer.setRenderTarget(this.gbuffer.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previousTarget);
    renderer.setMRT(null);
    camera.layers.mask = cameraLayers;
    scene.background = previousBackground;

    // --- surfel lifecycle ----------------------------------------------------
    this.prepare.run(renderer, this.pool);

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

    // Rebuild the grid so freshly spawned surfels are visible downstream.
    this.grid.build(renderer, this.pool, camera);

    // --- integrate + resolve -------------------------------------------------
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
    this.resolve.run(renderer, camera, this.gbuffer);

    this.prevCameraPos.copy(camera.position);
    this.pool.swapMoments();

    const output = this.resolve.getOutputTexture();
    const changed = output !== this.lastOutput;
    this.lastOutput = output;
    return changed;
  }

  setBaseSampleCount(count: number): void {
    this.integrate?.setBaseSampleCount(count);
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
