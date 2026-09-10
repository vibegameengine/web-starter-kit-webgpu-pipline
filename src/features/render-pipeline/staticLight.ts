import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { SurfelGI } from '../../shared/gi/index.ts';
import { applyLightmap, assignLightmapUvs, measureCoverage, rasteriseLightmapGBuffer, type LightmapLayout } from '../../shared/gi/bake/index.ts';
import { padLightmapCharts } from '../../shared/gi/bake/chartPadding.ts';
import { bakeKey, loadBake, saveBake } from '../../shared/gi/bake/persistedBake.ts';
import { readFloatTexture } from '../../shared/render/gpuReadback.ts';
import { MAX_TEMPORAL_M } from '../../shared/gi/surfel/constants.ts';
import { Layer } from '../../shared/world/index.ts';
import { ProbeLiveUpdate, ProbeVolume, applyProbeVolume, bakeProbeVolume, fitProbeLayout, seedResidentProbes, setProbeReceiversBaked, storageMatchesLayout, type ProbeReceivers, type ProbeVolumeStorage, type ResidentProbeSurfels } from '../../shared/gi/probes/index.ts';
import type { FrozenSurfelData } from '../../shared/gi/bake/persistedBake.ts';
import type { ContactBVHBundle } from '../../shared/gi/contact/contactBvh.ts';
import type { FrameGraph } from '../../shared/render/index.ts';
import type { PipelineUi, UrlParams } from './host.ts';

const DEFAULT_ATLAS_SIZE = 512;
const DEFAULT_PROBE_SPACING = 2;
const DEFAULT_PROBE_ITERATIONS = 100;
const MAX_PROBES = 65536;

export interface BakeCacheState { source: string; storage: string; key: string; saved: boolean; error: string; probes: string }

interface AtlasResult { pixels: Float32Array; surfels: FrozenSurfelData | null; probes?: ProbeVolumeStorage; fresh: boolean }

function halfFloatTexture(renderer: THREE.WebGPURenderer, pixels: Float32Array, size: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(Uint16Array.from(pixels, THREE.DataUtils.toHalfFloat), size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  renderer.initTexture(texture);
  return texture;
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
  readonly atlasSize: number;
  readonly atlasIntensity = uniform(0);
  readonly atlasParams: { intensity: number };
  readonly bakeParams: { passes: number; rays: number };
  readonly bakeCache: BakeCacheState = { source: 'none', storage: 'none', key: '', saved: false, error: '', probes: 'none' };
  layout: LightmapLayout | null = null;
  atlas: THREE.Texture | null = null;
  probes: ProbeVolume | null = null;
  probeLive: ProbeLiveUpdate | null = null;
  probeReceivers = 0;
  private receivers: ProbeReceivers | null = null;
  private probeIntensity = 1;
  ready = false;
  private gbuffer: ReturnType<typeof rasteriseLightmapGBuffer> | null = null;
  private coverage = 0;
  private busy = false;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly gi: SurfelGI,
    private readonly scene: THREE.Scene,
    private readonly sun: THREE.DirectionalLight,
    private readonly url: UrlParams,
    private readonly ui: PipelineUi,
  ) {
    this.atlasSize = url.num('lm') ?? DEFAULT_ATLAS_SIZE;
    this.atlasParams = { intensity: url.num('lmi') ?? 1 };
    this.bakeParams = { passes: url.num('iters') ?? MAX_TEMPORAL_M, rays: url.num('rays') ?? 32 };
  }

  unwrap(): void {
    this.ui.setLoading('Unwrapping lightmap UVs');
    this.layout = assignLightmapUvs(this.scene, { padding: this.url.num('pad') ?? 0.12, atlasSize: this.atlasSize });
  }

  async prepare(frameGraph: FrameGraph, options: { forceBake?: boolean; contactTree?: ContactBVHBundle | null; interiorVolumes?: THREE.Box3[] } = {}): Promise<void> {
    if (this.busy) { console.warn('[static-light] bake ignored: one is already running'); return; }
    this.busy = true;
    this.ready = false;
    try {
      frameGraph.setGiTextures(null, null);
      const atlas = await this.prepareAtlas(frameGraph, options.forceBake === true);
      this.atlasIntensity.value = this.atlasParams.intensity;
      const probesBaked = await this.prepareProbes(options.contactTree ?? null, atlas.probes, options.interiorVolumes ?? []);
      if ((atlas.fresh || probesBaked) && atlas.surfels) await this.save(atlas.pixels, atlas.surfels);
      this.gi.setFrozen(true);
      this.ready = true;
    } finally {
      this.busy = false;
      this.ui.clearLoading();
    }
  }

  private async prepareAtlas(frameGraph: FrameGraph, forceBake: boolean): Promise<AtlasResult> {
    const cache = this.bakeCache;
    Object.assign(cache, { source: 'none', storage: 'none', saved: false, error: '', probes: 'none' });
    if (this.url.flag('bakeCache', true)) {
      this.ui.setLoading('Checking saved static lighting');
      try {
        cache.key = await bakeKey(this.url.get('scene') ?? 'default');
        const saved = forceBake ? null : await loadBake(cache.key);
        if (saved) {
          this.ui.setLoading('Restoring saved static lighting');
          this.gi.restoreStaticBake(this.renderer, saved.surfels, this.url.get('atlasSurfels') === '1');
          this.publishAtlas(frameGraph, halfFloatTexture(this.renderer, saved.pixels, saved.size));
          Object.assign(cache, { source: 'saved', storage: 'bundle', saved: true });
          console.log(`[bake-cache] restored ${cache.key}`);
          return { pixels: saved.pixels, surfels: saved.surfels, probes: saved.probes, fresh: false };
        }
      } catch (error) {
        cache.error = String(error);
        console.warn(`[bake-cache] cannot reuse saved data: ${error}`);
      }
    }
    const baked = await this.bakeAtlas(frameGraph);
    Object.assign(cache, { source: 'baked', storage: 'computed' });
    return { ...baked, fresh: true };
  }

  private async save(pixels: Float32Array, surfels: FrozenSurfelData): Promise<void> {
    const cache = this.bakeCache;
    if (!this.url.flag('bakeCache', true) || !cache.key) return;
    this.ui.setLoading('Saving static lighting in project');
    try {
      const probes = cache.probes === 'baked' || cache.probes === 'saved' ? this.probes?.export() : undefined;
      await saveBake(cache.key, { size: this.atlasSize, pixels, surfels, probes });
      cache.saved = true;
      console.log(`[bake-cache] saved ${cache.key}${probes ? ' with probes' : ' without probes'}`);
    } catch (error) {
      cache.error = String(error);
      console.warn(`[bake-cache] bake is usable but could not be saved: ${error}`);
    }
  }

  private async rasterise(): Promise<void> {
    this.ui.setLoading('Rasterising lightmap G-Buffer');
    this.gbuffer = rasteriseLightmapGBuffer(this.renderer, this.scene, this.atlasSize);
    const coverage = await measureCoverage(this.renderer, this.gbuffer, this.atlasSize);
    console.log(`[lightmap] atlas coverage ${coverage.covered}/${coverage.total} texels (${(coverage.fraction * 100).toFixed(1)}%)`);
    if (coverage.covered === 0) throw new Error('lightmap: the UV-space rasterisation covered zero texels');
    this.coverage = coverage.covered;
  }

  private async bakeAtlas(frameGraph: FrameGraph): Promise<{ pixels: Float32Array; surfels: FrozenSurfelData }> {
    if (!this.gbuffer) await this.rasterise();
    if (!this.gbuffer || !this.layout) throw new Error('lightmap: unwrap before baking');
    this.gi.resetCache(this.renderer);
    const result = await this.gi.bakeLightmap(this.renderer, this.scene, this.gbuffer, this.atlasSize, {
      iterations: this.bakeParams.passes,
      raysPerSurfel: this.bakeParams.rays,
      dilate: 0,
      dynamicReceivers: true,
      onProgress: (fraction, iteration) => this.ui.setLoading(`Baking lightmap ${(fraction * 100).toFixed(0)}% · pass ${iteration}`),
    });
    if (result && result.seeded < this.coverage) throw new Error(`[lightmap] surfel pool exhausted: ${result.seeded}/${this.coverage} covered texels got a surfel. Lower ?lm=`);
    if (!result?.texture) throw new Error('lightmap: the bake produced no texture');
    const pixels = (await readFloatTexture(this.renderer, result.texture)).data;
    const filled = padLightmapCharts(pixels, this.atlasSize, this.layout.regions);
    if (filled > 0) console.log(`[lightmap] padded ${filled} unmeasured texels within ${this.layout.regions.length} charts; safe mip ${this.layout.safeMip}`);
    this.publishAtlas(frameGraph, filled > 0 ? halfFloatTexture(this.renderer, pixels, this.atlasSize) : result.texture);
    const surfels = await this.gi.captureStaticBake(this.renderer, result.seeded);
    return { pixels, surfels };
  }

  private publishAtlas(frameGraph: FrameGraph, texture: THREE.Texture): void {
    this.atlas = texture;
    applyLightmap(this.scene, texture, this.atlasIntensity);
    frameGraph.setLightmapTexture(texture);
    frameGraph.hybridReceivers.value = 1;
    if (this.url.flag('atlasHits', true)) this.gi.useBakedAtlas(texture, this.atlasIntensity);
  }

  private async prepareProbes(contactTree: ContactBVHBundle | null, saved: ProbeVolumeStorage | undefined, interiorVolumes: THREE.Box3[]): Promise<boolean> {
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
    else if (contactTree) { resident = await this.bakeProbes(volume, viewpoint, contactTree, live); this.bakeCache.probes = classify ? 'baked' : 'baked-unclassified'; baked = classify; }
    else throw new Error('probes: the bake needs the contact tree');
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
      onProgress: (stage, fraction) => this.ui.setLoading(`Baking probes: ${stage} ${(fraction * 100).toFixed(0)}%`),
    });
    console.log(`[probes] baked ${result.texels} probe surfels, ${result.active}/${volume.count} probes active, sun ${volume.bakedSunIntensity.toFixed(2)} split off, ${((performance.now() - started) / 1000).toFixed(1)} s`);
    return result.resident;
  }
}
