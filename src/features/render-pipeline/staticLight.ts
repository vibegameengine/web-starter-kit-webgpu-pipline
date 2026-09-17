import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { SurfelGI } from '../../shared/gi/index.ts';
import { applyLightmap, assignLightmapUvs, measureCoverage, rasteriseLightmapGBuffer, type LightmapLayout } from '../../shared/gi/bake/index.ts';
import type { AtlasWindow } from '../../shared/gi/bake/lightmapGBuffer.ts';
import { padLightmapCharts, type LightmapRegion } from '../../shared/gi/bake/chartPadding.ts';
import { BakeLeakStages, leakHookApi } from '../../shared/gi/bake/leakStages.ts';
import { bakeKey, loadBake, loadBakeManifest, saveBake } from '../../shared/gi/bake/persistedBake.ts';
import { captureLightingProvenance, compareLightingProvenance, describeProvenance, environmentDigest, transportDigest, type LightingProvenance, type ProvenanceStatus } from '../../shared/gi/bake/lightingProvenance.ts';
import { readFloatTexture } from '../../shared/render/gpuReadback.ts';
import { LightmapLod } from '../../shared/gi/lod/index.ts';
import { MAX_SURFELS, MAX_TEMPORAL_M } from '../../shared/gi/surfel/constants.ts';
import { giLightSummary } from '../../shared/gi/surfel/sceneLights.ts';
import { Layer } from '../../shared/world/index.ts';
import { ProbeLiveUpdate, ProbeVolume, applyProbeVolume, bakeProbeVolume, fitProbeLayout, seedResidentProbes, setProbeReceiversBaked, storageMatchesLayout, type ProbeReceivers, type ProbeVolumeStorage, type ResidentProbeSurfels } from '../../shared/gi/probes/index.ts';
import type { FrozenSurfelData } from '../../shared/gi/bake/persistedBake.ts';
import type { ContactBVHBundle } from '../../shared/gi/contact/contactBvh.ts';
import type { FrameGraph } from '../../shared/render/index.ts';
import { hook, type UrlParams } from './host.ts';
import { bootNote, bootStage } from '../../shared/ui/bootProgress.ts';

const DEFAULT_ATLAS_SIZE = 512;
const DEFAULT_PROBE_SPACING = 2;
const DEFAULT_SAMPLE_METRES = 0.1;
const DEFAULT_BAKE_SECONDS = 15;
const DEFAULT_METRES_PER_TEXEL = 0.05;
const DEFAULT_PROBE_ITERATIONS = 100;
const BAKE_WINDOW = 512;
const BAKE_WINDOW_APRON = 32;
const DEFAULT_BOUNCE_CACHE_SURFELS = 65536;
const BOUNCE_CACHE_BUDGET_SHARE = 0.3;
const MAX_PROBES = 65536;
const DEFAULT_LOD_TILE = 64;
const DEFAULT_LOD_SLOTS_PER_SIDE = 16;
const DEFAULT_LOD_COPIES = 32;
const DEFAULT_LOD_UPLOAD_KIB = 1024;
const DEFAULT_LOD_FEEDBACK_SPACING = 4;

export interface BakeCacheState { source: string; storage: string; key: string; saved: boolean; error: string; probes: string }

interface AtlasResult { pixels: Float32Array; surfels: FrozenSurfelData | null; probes?: ProbeVolumeStorage; fresh: boolean }

function halfFloatTexture(renderer: THREE.WebGPURenderer, pixels: Float32Array, size: number, height = size): THREE.DataTexture {
  const texture = new THREE.DataTexture(Uint16Array.from(pixels, THREE.DataUtils.toHalfFloat), size, height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  renderer.initTexture(texture);
  return texture;
}

function pasteWindowInside(baked: Float32Array, window: AtlasWindow, atlas: Float32Array, atlasWidth: number, atlasHeight: number): void {
  const inside = window.size - 2 * BAKE_WINDOW_APRON;
  const originX = window.x + BAKE_WINDOW_APRON;
  const originY = window.y + BAKE_WINDOW_APRON;
  const rows = Math.min(inside, atlasHeight - originY);
  const columns = Math.min(inside, atlasWidth - originX);
  for (let row = 0; row < rows; row++) {
    const from = ((BAKE_WINDOW_APRON + row) * window.size + BAKE_WINDOW_APRON) * 4;
    atlas.set(baked.subarray(from, from + columns * 4), ((originY + row) * atlasWidth + originX) * 4);
  }
}

function staticBounds(scene: THREE.Scene): THREE.Box3 {
  const bounds = new THREE.Box3();
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.layers.isEnabled(Layer.GiStatic) && mesh.userData.giExclude !== true) bounds.expandByObject(mesh);
  });
  return bounds;
}

export class StaticLight {
  atlasSize: number;
  readonly atlasIntensity = uniform(0);
  readonly atlasParams: { intensity: number };
  readonly bakeParams: { passes: number; rays: number };
  readonly bakeCache: BakeCacheState = { source: 'none', storage: 'none', key: '', saved: false, error: '', probes: 'none' };
  layout: LightmapLayout | null = null;
  atlas: THREE.Texture | null = null;
  atlasPixels: Float32Array | null = null;
  lod: LightmapLod | null = null;
  leak: BakeLeakStages | null = null;
  probes: ProbeVolume | null = null;
  probeLive: ProbeLiveUpdate | null = null;
  probeReceivers = 0;
  private receivers: ProbeReceivers | null = null;
  private probeIntensity = 1;
  ready = false;
  private gbuffer: ReturnType<typeof rasteriseLightmapGBuffer> | null = null;
  private busy = false;
  private bakedProvenance: LightingProvenance | null = null;
  private digests = { environment: 'pending', transport: 'pending' };
  bakedWith: { passes: number; rays: number; atlasIntensity: number; atlasSize: number } | null = null;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly gi: SurfelGI,
    private readonly scene: THREE.Scene,
    private readonly sun: THREE.DirectionalLight,
    private readonly url: UrlParams,
  ) {
    this.atlasSize = url.num('lm') ?? DEFAULT_ATLAS_SIZE;
    this.atlasParams = { intensity: url.num('lmi') ?? 1 };
    this.bakeParams = { passes: url.num('iters') ?? MAX_TEMPORAL_M, rays: url.num('rays') ?? 32 };
  }

  async unwrap(): Promise<void> {
    const density = this.url.num('lmDensity') ?? DEFAULT_METRES_PER_TEXEL;
    this.layout = await bootStage('Unwrapping lightmap UVs', () => assignLightmapUvs(this.scene, {
      padding: this.url.num('pad') ?? 0.12,
      atlasSize: this.atlasSize,
      metresPerTexel: density,
    }));
    this.atlasSize = this.layout.atlasSize;
    if (this.url.flag('leak', false)) {
      this.leak = new BakeLeakStages(this.atlasSize, this.layout.atlasHeight, this.layout.regions);
      hook('__leak', leakHookApi(this.leak));
      console.log(`[leak] capturing ${this.leak.slots} charted texels of the ${this.atlasSize}x${this.layout.atlasHeight} atlas per stage, ${this.layout.regions.length} charts on ${this.layout.pages} page(s)`);
    }
  }

  async prepare(frameGraph: FrameGraph, options: { forceBake?: boolean; bakeTree?: () => ContactBVHBundle | null; interiorVolumes?: THREE.Box3[] } = {}): Promise<void> {
    if (this.busy) { console.warn('[static-light] bake ignored: one is already running'); return; }
    this.busy = true;
    this.ready = false;
    try {
      await this.warmProvenance();
      frameGraph.setGiTextures(null, null);
      const bakeTree = options.bakeTree ?? (() => null);
      const atlas = await this.prepareAtlas(frameGraph, options.forceBake === true, bakeTree);
      this.atlasPixels = atlas.pixels;
      this.enableLod(atlas.pixels);
      this.atlasIntensity.value = this.atlasParams.intensity;
      const probesBaked = await this.prepareProbes(bakeTree, atlas.probes, options.interiorVolumes ?? []);
      if ((atlas.fresh || probesBaked) && atlas.surfels) await this.save(atlas.pixels, atlas.surfels);
      this.gi.setFrozen(true);
      this.ready = true;
    } finally {
      this.busy = false;
    }
  }

  private async prepareAtlas(frameGraph: FrameGraph, forceBake: boolean, bakeTree: () => ContactBVHBundle | null): Promise<AtlasResult> {
    const cache = this.bakeCache;
    Object.assign(cache, { source: 'none', storage: 'none', saved: false, error: '', probes: 'none' });
    if (this.leak) console.log('[leak] stage capture on: this bake is fresh and is neither read from nor written to the saved cache');
    if (this.url.flag('bakeCache', true) && !this.leak) {
      bootNote('Checking the saved static lighting');
      try {
        cache.key = await bakeKey(this.url.get('scene') ?? 'default', {
          metresPerTexel: this.layout?.metresPerTexel ?? 0,
          sampleMetres: this.url.num('sample') ?? DEFAULT_SAMPLE_METRES,
          atlasSize: this.atlasSize,
        });
        const saved = forceBake ? null : await loadBake(cache.key);
        if (saved && (saved.pages ?? 1) !== (this.layout?.pages ?? 1)) {
          console.warn(`[bake-cache] ${cache.key} holds ${saved.pages ?? 1} page(s) against this layout's ${this.layout?.pages ?? 1}; baking instead`);
        } else if (saved) {
          bootNote('Restoring the saved static lighting');
          this.gi.restoreStaticBake(this.renderer, saved.surfels, this.url.get('atlasSurfels') === '1');
          this.markUnlit(saved.pixels, this.layout?.regions ?? [], saved.size);
          this.publishAtlas(frameGraph, halfFloatTexture(this.renderer, saved.pixels, saved.size, saved.size * (saved.pages ?? 1)));
          Object.assign(cache, { source: 'saved', storage: 'bundle', saved: true });
          this.bakedProvenance = ((await loadBakeManifest(cache.key).catch(() => null))?.provenance as LightingProvenance | undefined) ?? null;
          console.log(`[bake-cache] restored ${cache.key}, indirect light ${this.bakeStatusText()}`);
          return { pixels: saved.pixels, surfels: saved.surfels, probes: saved.probes, fresh: false };
        }
      } catch (error) {
        cache.error = String(error);
        console.warn(`[bake-cache] cannot reuse saved data: ${error}`);
      }
    }
    const baked = await this.bakeAtlas(frameGraph, bakeTree());
    Object.assign(cache, { source: 'baked', storage: 'computed' });
    return { ...baked, fresh: true };
  }

  /* @important The two digests are taken once and kept: the panorama and the transport
     settings do not change while the scene runs, and the HUD asks for the status every
     frame. Only the sun's transform, intensity and colour are read live. */
  private async warmProvenance(): Promise<void> {
    this.digests = {
      environment: await environmentDigest(this.gi.envTexture as THREE.DataTexture),
      transport: await transportDigest({ atlasSize: this.atlasSize, passes: this.bakeParams.passes, rays: this.bakeParams.rays, scene: this.url.get('scene') ?? 'default' }),
    };
  }

  currentProvenance(): LightingProvenance {
    return captureLightingProvenance(this.sun, this.digests.environment, this.digests.transport);
  }

  /* @important Reports only. The rule of this project is that nothing in code decides to
     rebake: a stale indirect term is shown to the person, who presses "re-bake now". */
  bakeStatus(): ProvenanceStatus {
    return compareLightingProvenance(this.bakedProvenance, this.currentProvenance());
  }

  bakeStatusText(): string {
    return describeProvenance(this.bakeStatus());
  }

  private async save(pixels: Float32Array, surfels: FrozenSurfelData): Promise<void> {
    const cache = this.bakeCache;
    if (!this.url.flag('bakeCache', true) || this.leak || !cache.key) return;
    bootNote('Saving the static lighting in the project');
    try {
      const probes = cache.probes === 'baked' || cache.probes === 'saved' ? this.probes?.export() : undefined;
      this.bakedProvenance = this.currentProvenance();
      await saveBake(cache.key, { size: this.atlasSize, pages: this.layout?.pages ?? 1, pixels, surfels, probes }, this.bakedProvenance);
      cache.saved = true;
      console.log(`[bake-cache] saved ${cache.key}${probes ? ' with probes' : ' without probes'}`);
    } catch (error) {
      cache.error = String(error);
      console.warn(`[bake-cache] bake is usable but could not be saved: ${error}`);
    }
  }

  atlasHeight(): number {
    return this.layout?.atlasHeight ?? this.atlasSize;
  }

  private async bakeAtlas(frameGraph: FrameGraph, contactTree: ContactBVHBundle | null): Promise<{ pixels: Float32Array; surfels: FrozenSurfelData }> {
    if (!this.layout) throw new Error('lightmap: unwrap before baking');
    this.bakedWith = { passes: this.bakeParams.passes, rays: this.bakeParams.rays, atlasIntensity: this.atlasParams.intensity, atlasSize: this.atlasSize };
    const direction = this.sun.position.clone().normalize();
    console.log(`[bake] ${this.bakedWith.passes} passes, ${this.bakedWith.rays} rays, atlas mul ${this.bakedWith.atlasIntensity}, sun ${this.sun.intensity.toFixed(3)} from ${direction.x.toFixed(2)},${direction.y.toFixed(2)},${direction.z.toFixed(2)} (elevation ${(Math.asin(direction.y) * 180 / Math.PI).toFixed(1)}°)`);
    const size = this.atlasSize;
    const pages = Math.max(1, this.layout.pages);
    const height = size * pages;
    const sampleMetres = this.url.num('sample') ?? DEFAULT_SAMPLE_METRES;
    const stride = sampleMetres > 0 && this.layout.metresPerTexel > 0
      ? Math.max(1, Math.round(sampleMetres / this.layout.metresPerTexel))
      : 1;
    const budgetMs = (this.url.num('bakeSeconds') ?? DEFAULT_BAKE_SECONDS) * 1000;
    const cache = await this.gi.bakeBounceCache(this.renderer, this.scene, {
      budget: this.url.num('bounceCache') ?? DEFAULT_BOUNCE_CACHE_SURFELS,
      passes: this.bakeParams.passes,
      budgetMs: budgetMs * BOUNCE_CACHE_BUDGET_SHARE,
      raysPerSurfel: this.bakeParams.rays,
      onProgress: (fraction) => bootNote(`Baking the bounce cache ${(fraction * 100).toFixed(0)}%`),
    });
    if (!cache) throw new Error('lightmap: the static world sampled to no bounce cache');

    const windows = this.bakeWindows(size, height);
    const pixels = new Float32Array(size * height * 4);
    const windowBudget = (budgetMs * (1 - BOUNCE_CACHE_BUDGET_SHARE)) / Math.max(1, windows.length);
    let covered = 0;
    for (const [index, window] of windows.entries()) {
      bootNote(`Baking lightmap window ${index + 1} of ${windows.length}`);
      covered += await this.bakeWindow(contactTree, window, { cache, stride, budgetMs: windowBudget, pixels, size, height });
    }
    console.log(`[lightmap] ${windows.length} window(s) of ${BAKE_WINDOW}² over a ${size}x${height} atlas, ${covered} covered texels, bounce cache ${cache.count} surfels`);
    if (covered === 0) throw new Error('lightmap: the atlas rasterised zero texels');
    console.log(`[bake] the tracer carried ${giLightSummary().length} analytic light(s) through this bake`);
    this.leak?.record('blit', pixels);
    const filled = padLightmapCharts(pixels, size, this.layout.regions, height);
    this.leak?.record('padded', pixels);
    if (filled > 0) console.log(`[lightmap] padded ${filled} unmeasured texels within ${this.layout.regions.length} charts on ${pages} page(s); safe mip ${this.layout.safeMip}`);
    this.markUnlit(pixels, this.layout.regions, size);
    this.gi.restoreStaticBake(this.renderer, cache, false);
    this.publishAtlas(frameGraph, halfFloatTexture(this.renderer, pixels, size, height));
    await this.captureLeakStages(frameGraph);
    return { pixels, surfels: cache };
  }

  /* @important The atlas is baked in windows of a fixed size, so what the GPU holds for a bake
     is one window and the bounce cache, whatever the size of the world. Windows overlap by an
     apron and only their inside is kept: the denoiser and the links need neighbours on both
     sides of a window's edge, and a chart larger than a window is cut by these edges. */
  private bakeWindows(size: number, height: number): AtlasWindow[] {
    const regions = this.layout?.regions ?? [];
    const windows: AtlasWindow[] = [];
    for (let y = 0; y < height; y += BAKE_WINDOW) {
      for (let x = 0; x < size; x += BAKE_WINDOW) {
        const touched = regions.some((region) => region.x < x + BAKE_WINDOW && region.x + region.width > x && region.y < y + BAKE_WINDOW && region.y + region.height > y);
        if (touched) windows.push({ x: x - BAKE_WINDOW_APRON, y: y - BAKE_WINDOW_APRON, size: BAKE_WINDOW + 2 * BAKE_WINDOW_APRON, atlasWidth: size, atlasHeight: height });
      }
    }
    return windows;
  }

  private async bakeWindow(
    contactTree: ContactBVHBundle | null,
    window: AtlasWindow,
    job: { cache: FrozenSurfelData; stride: number; budgetMs: number; pixels: Float32Array; size: number; height: number },
  ): Promise<number> {
    const layout = this.layout!;
    this.gbuffer?.dispose();
    this.gbuffer = rasteriseLightmapGBuffer(this.renderer, this.scene, job.size, 1, window);
    const coverage = await measureCoverage(this.renderer, this.gbuffer, window.size, window.size);
    if (coverage.covered === 0) return 0;
    const regions = layout.regions.map((region) => ({ x: region.x - window.x, y: region.y - window.y, width: region.width, height: region.height }));
    const atLeast = Math.ceil(coverage.covered / (job.stride * job.stride)) + job.cache.count;
    if (atLeast > MAX_SURFELS) throw new Error(`[lightmap] a ${window.size}² window needs at least ${atLeast} surfels with its bounce cache, against a ${MAX_SURFELS} pool. Lower ?bounceCache= or raise ?sample=`);
    const result = await this.gi.bakeLightmap(this.renderer, this.scene, this.gbuffer, window.size, {
      height: window.size,
      sampleStride: job.stride,
      budgetMs: job.budgetMs,
      sampleFallback: this.url.flag('sampleFallback', true),
      regions,
      bounceCache: job.cache,
      iterations: this.bakeParams.passes,
      raysPerSurfel: this.bakeParams.rays,
      freshSurfels: true,
      dilate: 0,
      dynamicReceivers: false,
      denoiseIgnoresSurface: this.url.get('leakMutation') === 'denoiseAll',
      atlasGain: this.url.get('leakMutation') === 'atlasHalf' ? 0.5 : 1,
      filterLinks: this.url.flag('filterLinks', true) ? contactTree : null,
    });
    if (!result?.texture) throw new Error('lightmap: a window baked no texture');
    const baked = (await readFloatTexture(this.renderer, result.texture)).data;
    pasteWindowInside(baked, window, job.pixels, job.size, job.height);
    return coverage.covered;
  }

  private async captureLeakStages(frameGraph: FrameGraph): Promise<void> {
    const leak = this.leak;
    if (!leak || !this.atlas) return;
    leak.record('resident', (await readFloatTexture(this.renderer, this.atlas)).data);
    frameGraph.setLeakTexture(leak.view);
    console.log(`[leak] ${leak.stages.length} stages captured: ${leak.stages.map((stage) => stage.name).join(' -> ')}`);
  }

  /* @important A texel a chart covers and the bake left at zero is painted loud green before
     the atlas is published, and it is on by default. A hole in the lightmap otherwise reads as
     shade - the frame still has the sun and the sky on it - and every "looks lit to me" this
     branch produced was exactly that mistake. `?zeroGreen=0` turns it off for a capture that
     has to show the real colours. */
  private markUnlit(pixels: Float32Array, regions: LightmapRegion[], size: number): number {
    /* @important Off unless asked for. The mark is for a hunt, not for a frame: most of what it
       paints is correct - the inside of a closed house shell, a cavity under the terrace where
       64 rays out of 64 hit the shell itself - and a frame covered in green over correct black
       teaches nothing. `?zeroGreen=1` (or a threshold) turns it on. */
    const threshold = this.url.num('zeroGreen') ?? (this.url.flag('zeroGreen', false) ? 1e-4 : 0);
    if (threshold <= 0) return 0;
    let dark = 0;
    let uncovered = 0;
    /* @important Two failures, two colours, because they need different fixes. GREEN: the
       chart covers this texel and the bake left it at (or below) the threshold - the transport
       found no light. MAGENTA: the chart's rectangle holds this texel and nothing ever wrote
       it - neither a surfel, nor the spread, nor the gutter fill - so the surface is not in the
       atlas at all. Marking only exact zeros hid the second class entirely. */
    for (const region of regions) {
      const right = Math.min(size, region.x + region.width);
      const bottom = region.y + region.height;
      for (let y = region.y; y < bottom; y++) {
        for (let x = region.x; x < right; x++) {
          const texel = (y * size + x) * 4;
          if (texel + 3 >= pixels.length) continue;
          if (pixels[texel + 3] < 0.25) {
            pixels[texel] = 1; pixels[texel + 1] = 0; pixels[texel + 2] = 1;
            uncovered++;
            continue;
          }
          const luma = 0.2126 * pixels[texel] + 0.7152 * pixels[texel + 1] + 0.0722 * pixels[texel + 2];
          if (luma > threshold) continue;
          pixels[texel] = 0; pixels[texel + 1] = 1; pixels[texel + 2] = 0;
          dark++;
        }
      }
    }
    if (dark + uncovered > 0) console.warn(`[lightmap] ${dark} chart texel(s) below ${threshold} painted green, ${uncovered} never written painted magenta; ?zeroGreen=0 hides both`);
    return dark + uncovered;
  }

  /* @important The pages are what the bake wrote, cut per chart into a mip chain; the frame
     reads one working atlas the camera's own fragments ask for. The full stacked atlas stays
     published for the tracer and the split view, which address it by the baked uv1. */
  private lodWanted(): boolean {
    return this.url.flag('lod', true) && (this.layout?.regions.length ?? 0) > 0;
  }

  private enableLod(pixels: Float32Array): void {
    this.lod?.dispose();
    this.lod = null;
    if (!this.lodWanted() || !this.layout) return;
    this.lod = new LightmapLod(this.renderer, this.scene, this.layout, pixels, this.atlasIntensity, {
      tileSize: this.url.num('vtTile') ?? DEFAULT_LOD_TILE,
      slotsPerSide: this.url.num('vtPool') ?? DEFAULT_LOD_SLOTS_PER_SIDE,
      copyBudget: this.url.num('lodCopies') ?? DEFAULT_LOD_COPIES,
      uploadBytesPerFrame: (this.url.num('vtUploadKiB') ?? DEFAULT_LOD_UPLOAD_KIB) * 1024,
      feedbackSpacing: this.url.num('lodFeedback') ?? DEFAULT_LOD_FEEDBACK_SPACING,
      shiftSlots: this.url.get('vtMutation') === 'slot',
      evictAll: this.url.get('vtEvict') === 'all',
    });
  }

  private publishAtlas(frameGraph: FrameGraph, texture: THREE.Texture): void {
    this.atlas = texture;
    if (!this.lodWanted()) applyLightmap(this.scene, texture, this.atlasIntensity);
    frameGraph.setLightmapTexture(texture);
    frameGraph.hybridReceivers.value = 1;
    if (this.url.flag('atlasHits', true)) this.gi.useBakedAtlas(texture, this.atlasIntensity);
  }

  private async prepareProbes(bakeTree: () => ContactBVHBundle | null, saved: ProbeVolumeStorage | undefined, interiorVolumes: THREE.Box3[]): Promise<boolean> {
    if (!this.url.flag('probes', true)) return false;
    const bounds = staticBounds(this.scene);
    if (bounds.isEmpty()) return false;
    const spacing = this.url.num('probeSpacing') ?? DEFAULT_PROBE_SPACING;
    const viewpoint = bounds.getCenter(new THREE.Vector3());
    bounds.expandByScalar(spacing);
    const volume = new ProbeVolume(fitProbeLayout(bounds, spacing, MAX_PROBES));
    const { dims, spacing: step } = volume.layout;
    console.log(`[probes] grid ${dims.join('x')} = ${volume.count} probes, spacing ${step.toFixed(2)} m`);
    const fill = this.url.num('probeFill');
    const classify = this.url.flag('probeClassify', true);
    const reusable = saved !== undefined && storageMatchesLayout(saved, volume.layout) && !this.url.flag('probeBake', false) && classify;
    let baked = false;
    let resident: ResidentProbeSurfels | undefined;
    const live = this.url.flag('probeLive', false);
    if (fill !== null) { volume.fillConstant(fill); this.bakeCache.probes = 'constant'; }
    else if (reusable && this.tryLoad(volume, saved)) {
      this.bakeCache.probes = 'saved'; console.log('[probes] restored from the bake');
      if (live) resident = await seedResidentProbes(this.renderer, this.gi, volume);
    }
    else {
      const tree = bakeTree();
      if (!tree) throw new Error('probes: the bake needs the detailed tree');
      resident = await this.bakeProbes(volume, viewpoint, tree, live);
      this.bakeCache.probes = classify ? 'baked' : 'baked-unclassified';
      baked = classify;
    }
    if (resident) {
      this.probeLive = new ProbeLiveUpdate(this.renderer, this.gi, this.scene, volume, resident, viewpoint);
      const budget = this.url.num('probeRayBudget'); if (budget !== null) this.probeLive.settings.rayBudget = budget;
      console.log(`[probes] live: ${volume.count * resident.directions} direction surfels resident, ${this.probeLive.settings.rayBudget} rays a frame`);
    }
    this.probeIntensity = this.url.num('probeMul') ?? 1;
    volume.intensity.value = this.probeIntensity;
    volume.visibilityTest.value = this.url.flag('probeVisibility', true) ? 1 : 0;
    const normalBias = this.url.num('probeNormalBias'); if (normalBias !== null) volume.normalBias.value = normalBias;
    const viewBias = this.url.num('probeViewBias'); if (viewBias !== null) volume.viewBias.value = viewBias;
    volume.layersEnabled.value = this.url.flag('probeLayers', true) ? 1 : 0;
    volume.forcedLayerMask = this.url.num('probeLayerMask');
    const layers = volume.assignLayers(interiorVolumes);
    if (interiorVolumes.length) console.log(`[probes] layers: ${layers.interior} interior, ${layers.exterior} exterior`);
    this.probes = volume;
    this.receivers = applyProbeVolume(this.scene, volume);
    this.probeReceivers = this.receivers.materials;
    return baked;
  }

  private tryLoad(volume: ProbeVolume, saved: ProbeVolumeStorage): boolean {
    try { volume.load(saved); return true; } catch (error) { console.warn(`[probes] saved probes unusable, baking again: ${error}`); return false; }
  }

  setLiveChainServesReceivers(live: boolean): void {
    if (!this.receivers || !this.probes) return;
    setProbeReceiversBaked(this.receivers, !live);
    this.probes.intensity.value = live ? 0 : this.probeIntensity;
  }

  private sunSplit(): { sunIntensity: number; skyOnly: () => void; restore: () => void } {
    const sun = this.sun;
    const sunIntensity = sun.intensity;
    const atlas = this.atlas;
    return {
      sunIntensity,
      skyOnly: () => { sun.intensity = 0; this.gi.useBakedAtlas(null); },
      restore: () => { sun.intensity = sunIntensity; if (atlas && this.url.flag('atlasHits', true)) this.gi.useBakedAtlas(atlas, this.atlasIntensity); },
    };
  }

  private async bakeProbes(volume: ProbeVolume, viewpoint: THREE.Vector3, contactTree: ContactBVHBundle, keepResident: boolean): Promise<ResidentProbeSurfels | undefined> {
    const started = performance.now();
    const result = await bakeProbeVolume(this.renderer, this.gi, this.scene, volume, contactTree, {
      keepResident,
      iterations: this.url.num('probeIters') ?? DEFAULT_PROBE_ITERATIONS,
      raysPerSurfel: this.url.num('probeRays') ?? this.bakeParams.rays,
      viewpoint,
      classify: this.url.flag('probeClassify', true),
      sunSplit: this.url.flag('probeSunSplit', true) ? this.sunSplit() : undefined,
      onProgress: (stage, fraction) => bootNote(`Baking probes: ${stage} ${(fraction * 100).toFixed(0)}%`),
    });
    console.log(`[probes] baked ${result.texels} probe surfels, ${result.active}/${volume.count} probes active, sun ${volume.bakedSunIntensity.toFixed(2)} split off, ${((performance.now() - started) / 1000).toFixed(1)} s`);
    return result.resident;
  }
}
