import * as THREE from 'three/webgpu';
import type GUI from 'lil-gui';
import { cameraProjectionMatrixInverse, cameraWorldMatrix, float, getViewPosition, mix, normalize, screenUV, uint, uniform, vec3, vec4 } from 'three/tsl';
import type { SurfelGI } from '../../shared/gi/index.ts';
import type { ReflectionCache } from '../../shared/gi/reflect/cache/index.ts';
import { ContactOcclusionPass, DEFAULT_CONTACT_SETTINGS } from '../../shared/gi/contact/contactOcclusionPass.ts';
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

function bilinearReader(reader: Reader) {
  return (uv: TslNode) => {
    const { width, height } = reader;
    const fx = float((uv as any).x).mul(width).sub(0.5).clamp(0, width - 1);
    const fy = float((uv as any).y).mul(height).sub(0.5).clamp(0, height - 1);
    const x0 = uint(fx.floor()); const y0 = uint(fy.floor());
    const x1 = x0.add(uint(1)).min(uint(width - 1)); const y1 = y0.add(uint(1)).min(uint(height - 1));
    const top = mix(readCell(reader, x0, y0) as any, readCell(reader, x1, y0) as any, fx.fract());
    const bottom = mix(readCell(reader, x0, y1) as any, readCell(reader, x1, y1) as any, fx.fract());
    return mix(top, bottom, fy.fract()) as unknown as TslNode;
  };
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
  readonly contact: ContactOcclusionPass;
  readonly reflections: ReflectionPass;
  readonly contactIntensity: THREE.UniformNode<number>;
  readonly reflectionsIntensity: THREE.UniformNode<number>;
  readonly mode: 'legacy' | 'cached';
  private contactBvh: ContactBVHBundle | null = null;
  private contactReaderBound: unknown = null;
  private reflectionsReaderBound: unknown = null;
  private cache: ReflectionCache | null = null;
  private cachedReader: { sample: (uv: TslNode) => TslNode; intensity: THREE.UniformNode<number> } | null = null;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly gi: SurfelGI,
    host: SceneHost,
    url: UrlParams,
  ) {
    this.contact = new ContactOcclusionPass(renderer, host.camera, gi.blueNoiseTexture, {
      ...host.contact,
      enabled: url.flag('contact', host.contact?.enabled ?? DEFAULT_CONTACT_SETTINGS.enabled),
    });
    const radius = url.num('contactRadius'); if (radius !== null) this.contact.settings.radius = radius;
    const scale = url.num('contactScale'); if (scale !== null) this.contact.settings.resolutionScale = scale;
    const rays = url.num('contactRays'); if (rays !== null) this.contact.settings.rays = rays;
    const contactEvery = url.num('contactEvery'); if (contactEvery !== null) this.contact.settings.traceInterval = contactEvery;
    this.contactIntensity = uniform(this.contact.settings.intensity) as THREE.UniformNode<number>;
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
    return this.contact.enabled || this.reflections.enabled || this.mode === 'cached';
  }

  tree(scene: THREE.Scene): ContactBVHBundle | null {
    if (!this.needsTree) return this.contactBvh;
    return this.buildTree(scene);
  }

  buildTree(scene: THREE.Scene): ContactBVHBundle | null {
    if (!this.contactBvh && this.gi.staticBvh) this.contactBvh = createContactBVH(scene, this.gi.staticBvh.materialIdByUUID);
    return this.contactBvh;
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
    const contactFolder = gui.addFolder('Contact occlusion');
    contactFolder.add(this.contact.settings, 'enabled').name('enabled').onChange((v: boolean) => { this.contact.setEnabled(v); this.syncContact(frameGraph); });
    contactFolder.add(this.contact.settings, 'radius', 0.05, 2, 0.01).name('radius (m)');
    contactFolder.add(this.contact.settings, 'rays', 1, 8, 1).name('rays / frame');
    contactFolder.add(this.contact.settings, 'historyWeight', 0, 0.97, 0.01).name('history');
    contactFolder.add(this.contact.settings, 'intensity', 0, 1, 0.01).name('strength').onChange((v: number) => { this.contactIntensity.value = v; });
    contactFolder.close();
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

  update(scene: THREE.Scene, frameGraph: FrameGraph): void {
    const { width, height } = this.renderer.domElement;
    const tree = this.tree(scene);
    const gi = this.gi;
    const scenePass = frameGraph.scenePass;
    const depth = scenePass.getTexture('depth');
    const normal = scenePass.getTexture('normal');
    this.contact.update(this.contact.enabled ? tree : null, gi.dynamicBvhBundle, depth, normal, width, height, true);
    this.syncContact(frameGraph);
    if (this.cache) {
      this.cache.update(performance.now(), 1, gi.dynamicBvhBundle ? gi.dynamicBvhBundle.enabled.value > 0 : false);
      return;
    }
    this.reflections.update(tree, gi.dynamicBvhBundle, gi.diffuseArrayTexture, depth, normal,
      scenePass.getTexture('velocity'), scenePass.getTexture('albedo'), frameGraph.taa.historyTexture, width, height, 1);
    this.syncReflections(frameGraph);
  }

  private syncContact(frameGraph: FrameGraph): void {
    const reader = this.contact.enabled ? this.contact.reader : null;
    if (reader === this.contactReaderBound) return;
    this.contactReaderBound = reader;
    frameGraph.setContactOcclusion(reader ? { intensity: this.contactIntensity, sample: bilinearReader(reader as unknown as Reader) } : null);
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
      contact: (value?: boolean) => {
        if (typeof value === 'boolean') { this.contact.setEnabled(value); this.syncContact(frameGraph); }
        return this.contact.enabled;
      },
      contactSettings: this.contact.settings,
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
