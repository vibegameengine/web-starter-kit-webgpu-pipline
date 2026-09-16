import * as THREE from 'three/webgpu';
import type GUI from 'lil-gui';
import { cameraProjectionMatrixInverse, cameraWorldMatrix, float, getViewPosition, normalize, screenUV, uint, uniform, vec3, vec4 } from 'three/tsl';
import type { SurfelGI } from '../../shared/gi/index.ts';
import type { ReflectionCache } from '../../shared/gi/reflect/cache/index.ts';
import { createContactBVH, type ContactBVHBundle } from '../../shared/gi/contact/contactBvh.ts';
import { ReflectionPass } from '../../shared/gi/reflect/reflectionPass.ts';
import { meanEnvironmentRadiance } from '../../shared/render/atmosphere/volumetricFog.ts';
import type { FrameGraph } from '../../shared/render/index.ts';
import type { SceneHost, UrlParams } from './host.ts';

type TslNode = THREE.Node;
type Reader = { current: THREE.Node; previous: THREE.Node; parity: THREE.Node; width: number; height: number };

function readCell(reader: Reader, x: THREE.Node, y: THREE.Node): TslNode {
  const index = uint(y).mul(uint(reader.width)).add(uint(x));
  const parity = reader.parity as unknown as ReturnType<typeof float>;
  return parity.lessThan(0.5).select(vec4((reader.current as any).element(index)), vec4((reader.previous as any).element(index))) as unknown as TslNode;
}

function boxReader(reader: Reader) {
  return (uv: TslNode) => {
    const { width, height } = reader;
    const cx = float((uv as any).x).mul(width).clamp(0, width - 1);
    const cy = float((uv as any).y).mul(height).clamp(0, height - 1);
    let sum: any = vec4(0);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      sum = sum.add(readCell(reader, cx.add(dx).clamp(0, width - 1), cy.add(dy).clamp(0, height - 1)));
    }
    return sum.div(9) as TslNode;
  };
}

export class TraceStages {
  readonly reflections: ReflectionPass;
  readonly reflectionsIntensity: THREE.UniformNode<number>;
  readonly mode: 'legacy' | 'cached';
  private staticTree: ContactBVHBundle | null = null;
  private bakeTree: ContactBVHBundle | null = null;
  private reflectionsReaderBound: unknown = null;
  private cache: ReflectionCache | null = null;
  private cachedReader: { sample: (uv: TslNode) => TslNode; intensity: THREE.UniformNode<number> } | null = null;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly gi: SurfelGI,
    host: SceneHost,
    url: UrlParams,
  ) {
    const ambient = meanEnvironmentRadiance(gi.envTexture as THREE.DataTexture).multiplyScalar(0.5);
    this.reflections = new ReflectionPass(renderer, host.camera, gi.blueNoiseTexture, gi.envTexture, ambient, {
      ...host.reflections,
      enabled: url.flag('reflections', host.reflections?.enabled ?? true),
    });
    const roughness = url.num('reflectionsRoughness'); if (roughness !== null) this.reflections.settings.maxRoughness = roughness;
    const every = url.num('reflectionsEvery'); if (every !== null) this.reflections.settings.traceInterval = every;
    const budget = url.num('reflectionsBudget'); if (budget !== null) this.reflections.settings.rayNodeBudget = budget;
    const denoise = url.num('reflectionsDenoise'); if (denoise !== null) this.reflections.settings.denoisePasses = denoise;
    this.reflectionsIntensity = uniform(this.reflections.settings.intensity) as THREE.UniformNode<number>;
    this.mode = url.get('reflections') === 'cached' ? 'cached' : 'legacy';
  }

  installReflectionCache(cache: ReflectionCache, frameGraph: FrameGraph): void {
    this.cache = cache;
    this.reflections.setEnabled(false);
    this.cachedReader = {
      intensity: this.reflectionsIntensity,
      sample: () => this.cachedSample(frameGraph),
    };
    this.reflectionsReaderBound = this.cachedReader;
    frameGraph.setReflections(this.cachedReader);
  }

  private cachedSample(frameGraph: FrameGraph): TslNode {
    const scenePass = frameGraph.scenePass;
    const depthNode = scenePass.getTextureNode('depth');
    const viewPosition = getViewPosition(screenUV, depthNode, cameraProjectionMatrixInverse);
    const worldPosition = vec3(cameraWorldMatrix.mul(vec4(viewPosition, 1)).xyz);
    const viewNormal = normalize(scenePass.getTextureNode('normal').rgb);
    const worldNormal = normalize(cameraWorldMatrix.mul(vec4(viewNormal, 0)).xyz);
    const viewDirection = normalize(vec3(cameraWorldMatrix[3].xyz).sub(worldPosition));
    const roughness = scenePass.getTextureNode('velocity').a;
    const lookup = this.cache!.sampler.sample({
      worldPosition,
      worldNormal,
      viewDirection,
      roughness,
      regionId: float(0),
    });
    return vec4(vec3(lookup.radiance), float(lookup.sourceKind).greaterThan(0).select(float(1), float(0))) as unknown as TslNode;
  }

  get needsTree(): boolean {
    return this.reflections.enabled || this.mode === 'cached';
  }

  tree(): ContactBVHBundle | null {
    if (this.staticTree) return this.staticTree;
    const bvh = this.gi.staticBvh;
    if (!bvh) return null;
    /* @important One tree for the whole frame. The second, full-detail contact tree was
       built on every launch (8 M triangles, 6.5 s of the village boot) for a pass that has
       been off since 2026-09-09, and the reflections that also read it are the only
       consumer left. Distant geometry the GI budget demoted to a proxy box reflects as
       that box; raise `?bvhBudget=` if a scene needs it back. */
    this.staticTree = {
      bvhNode: bvh.bvhNode,
      positionNode: bvh.positionNode,
      indexNode: bvh.indexNode,
      attributeNode: bvh.colorNode,
      triangles: bvh.stats.triangles,
      buildMs: 0,
      dispose: () => {},
    };
    return this.staticTree;
  }

  /* @important Full detail, no demotion, built on demand and kept: the bake's visibility
     queries and the probe distances need the triangles the GI tree replaced with boxes.
     A launch that reads its bake from disk never calls this. */
  detailedTree(scene: THREE.Scene): ContactBVHBundle | null {
    if (!this.bakeTree && this.gi.staticBvh) this.bakeTree = createContactBVH(scene, this.gi.staticBvh.materialIdByUUID);
    return this.bakeTree;
  }

  disposeDetailedTree(): void {
    this.bakeTree?.dispose();
    this.bakeTree = null;
  }

  bindGui(gui: GUI, frameGraph: FrameGraph): void {
    if (this.cache) { this.bindCacheGui(gui); return; }
    const reflectionsFolder = gui.addFolder('Reflections');
    reflectionsFolder.add(this.reflections.settings, 'enabled').name('enabled').onChange((v: boolean) => { this.reflections.setEnabled(v); this.syncReflections(frameGraph); });
    reflectionsFolder.add(this.reflections.settings, 'maxRoughness', 0.05, 1, 0.01).name('max roughness');
    reflectionsFolder.add(this.reflections.settings, 'historyWeight', 0, 0.97, 0.01).name('history');
    reflectionsFolder.add(this.reflections.settings, 'screenSteps', 8, 96, 1).name('screen steps');
    reflectionsFolder.add(this.reflections.settings, 'denoisePasses', 0, 3, 1).name('denoise passes').onChange(() => this.syncReflections(frameGraph));
    reflectionsFolder.add(this.reflections.settings, 'intensity', 0, 2, 0.01).name('strength').onChange((v: number) => { this.reflectionsIntensity.value = v; });
    reflectionsFolder.close();
  }

  private bindCacheGui(gui: GUI): void {
    const cache = this.cache!;
    const folder = gui.addFolder('Reflection cache');
    folder.add(cache.settings, 'enabled').name('enabled');
    folder.add(cache.settings, 'freezeUpdates').name('freeze updates');
    folder.add(cache.settings, 'intensity', 0, 2, 0.01).name('strength').onChange((v: number) => { cache.sampler.intensity.value = v; });
    folder.add(cache.settings, 'wideBlendRoughness', 0, 1, 0.01).name('wide blend roughness').onChange((v: number) => { cache.sampler.wideBlendRoughness.value = v; });
    folder.add(cache.settings, 'maxFootprintTaps', 1, 8, 1).name('footprint taps').onChange((v: number) => { cache.sampler.maxTaps.value = v; });
    folder.add(cache.settings, 'depthCorrection').name('depth correction').onChange((v: boolean) => { cache.sampler.depthCorrection.value = v ? 1 : 0; });
    folder.add({ rebuild: () => cache.invalidate(performance.now()) }, 'rebuild').name('recapture');
    folder.open();
  }

  update(frameGraph: FrameGraph): void {
    const { width, height } = this.renderer.domElement;
    const tree = this.tree();
    const gi = this.gi;
    const scenePass = frameGraph.scenePass;
    const depth = scenePass.getTexture('depth');
    const normal = scenePass.getTexture('normal');
    if (this.cache) {
      this.cache.update(performance.now(), 1, gi.dynamicBvhBundle ? gi.dynamicBvhBundle.enabled.value > 0 : false);
      return;
    }
    this.reflections.update(tree, gi.dynamicBvhBundle, gi.diffuseArrayTexture, depth, normal,
      scenePass.getTexture('velocity'), scenePass.getTexture('albedo'), frameGraph.taa.historyTexture, width, height, 1);
    this.syncReflections(frameGraph);
  }

  private syncReflections(frameGraph: FrameGraph): void {
    if (this.cache) return;
    const reader = this.reflections.enabled ? this.reflections.reader : null;
    if (reader === this.reflectionsReaderBound) return;
    this.reflectionsReaderBound = reader;
    frameGraph.setReflections(reader ? { intensity: this.reflectionsIntensity, sample: boxReader(reader as unknown as Reader) } : null);
  }

  hooks(frameGraph: FrameGraph) {
    return {
      reflections: (value?: boolean) => {
        if (typeof value === 'boolean') { this.reflections.setEnabled(value); this.syncReflections(frameGraph); }
        return this.reflections.enabled;
      },
      reflectionSettings: this.reflections.settings,
      reflectionCache: () => this.cache,
      reflectionCacheCounters: () => this.cache?.counterSnapshot ?? null,
      reflectionCacheProbes: () => this.cache?.probeStates ?? null,
      reflectionCacheDump: () => this.cache?.dump() ?? null,
      reflectionCacheFreeze: (value?: boolean) => {
        if (this.cache && typeof value === 'boolean') this.cache.settings.freezeUpdates = value;
        return this.cache?.settings.freezeUpdates ?? false;
      },
    };
  }
}
