import * as THREE from 'three/webgpu';
import type GUI from 'lil-gui';
import { uniform } from 'three/tsl';
import { VolumetricFog, type Antialiasing, type FogView, type FrameGraph, SplitView } from '../../shared/render/index.ts';
import { AutoExposure } from '../../shared/render/exposure.ts';
import { DEFAULT_MOTION_BLUR, MotionBlur, type MotionBlurGaze } from '../../shared/render/motionBlur.ts';
import { readFloatTexture } from '../../shared/render/gpuReadback.ts';
import type { SceneHost, UrlParams } from './host.ts';

const DEFAULT_GLARE = { strength: 0.22, radius: 0.5 };
const DEFAULT_GRAIN = 0.015;

function fogView(url: UrlParams): FogView {
  const view = url.get('fogView');
  return view === 'inscatter' || view === 'transmittance' ? view : 'fogged';
}

export class PostStages {
  readonly fog: VolumetricFog;
  readonly glare: { enabled: boolean; strength: number; radius: number };
  readonly autoExposure: AutoExposure;
  readonly grainStrength: THREE.UniformNode<number>;
  readonly grainState: { enabled: boolean };
  readonly motionBlur: MotionBlur;
  readonly aaParams: { mode: Antialiasing };
  still: boolean;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    host: SceneHost,
    env: THREE.DataTexture,
    private readonly frameGraph: FrameGraph,
    url: UrlParams,
  ) {
    this.fog = new VolumetricFog(renderer, host.camera, host.sun, env, {
      settings: { ...host.atmosphere, enabled: url.flag('fog', host.atmosphere?.enabled ?? host.atmosphere !== undefined) },
    });
    const density = url.num('fogDensity'); if (density !== null) this.fog.settings.density = density;
    const sun = url.num('fogSun'); if (sun !== null) this.fog.settings.sunIntensity = sun;
    const sky = url.num('fogSky'); if (sky !== null) this.fog.settings.ambientIntensity = sky;
    const noise = url.num('fogNoise'); if (noise !== null) this.fog.settings.noiseStrength = noise;
    const view = fogView(url);
    this.applyFog = (beauty, depth) => this.fog.apply(beauty, depth, view) as THREE.Node;
    this.glare = {
      enabled: url.flag('glare', host.glare !== undefined),
      strength: url.num('glareStrength') ?? host.glare?.strength ?? DEFAULT_GLARE.strength,
      radius: url.num('glareRadius') ?? host.glare?.radius ?? DEFAULT_GLARE.radius,
    };
    const exposure = url.num('exposure');
    this.autoExposure = new AutoExposure(renderer, exposure !== null ? { auto: false, manual: exposure } : {});
    this.grainStrength = uniform(url.num("grain") ?? DEFAULT_GRAIN) as THREE.UniformNode<number>;
    this.grainState = { enabled: url.flag('grain', true) };
    this.motionBlur = new MotionBlur({ ...host.motionBlur, enabled: url.flag('motionBlur', host.motionBlur?.enabled ?? DEFAULT_MOTION_BLUR.enabled) });
    const shutter = url.num('shutter'); if (shutter !== null) this.motionBlur.settings.shutter = shutter;
    const integration = url.num('integration'); if (integration !== null) this.motionBlur.settings.integrationMs = integration;
    const gaze = url.get('gaze') as MotionBlurGaze | null;
    if (gaze === 'centre' || gaze === 'camera') this.motionBlur.settings.gaze = gaze;
    this.aaParams = { mode: frameGraph.antialiasingMode };
    this.still = url.get('still') === '1';
    this.applyTaaOverrides(url);
    this.syncAll();
  }

  private readonly applyFog: (beauty: THREE.Node, depth: THREE.Node) => THREE.Node;

  private applyTaaOverrides(url: UrlParams): void {
    const taa = this.frameGraph.taa;
    const unjitter = url.num('taaUnjitter'); if (unjitter !== null) taa.unjitterSign.value = unjitter;
    const clip = url.num('taaClip'); if (clip !== null) taa.clipGamma.value = clip;
    const copy = url.num('taaCopy'); if (copy !== null) taa.copyMode = copy;
    const history = url.num('taaHistory'); if (history !== null) taa.historyWeight.value = history;
    const stencil = url.num('taaStencil'); if (stencil !== null) taa.setStencil(stencil > 0);
  }

  syncAll(): void {
    this.syncFog(); this.syncGlare(); this.syncGrain(); this.syncMotionBlur();
    this.frameGraph.setExposure(this.autoExposure.node);
  }

  syncFog(): void { this.frameGraph.setAtmosphere(this.fog.enabled ? this.applyFog : null); }
  syncGlare(): void { this.frameGraph.setGlare(this.glare.enabled ? { strength: this.glare.strength, radius: this.glare.radius } : null); }
  syncGrain(): void { this.frameGraph.setGrain(this.grainState.enabled ? this.grainStrength : null); }
  syncMotionBlur(): void { this.frameGraph.setMotionBlur(this.motionBlur.enabled ? this.motionBlur : null); }

  bindGui(gui: GUI): void {
    this.bindFogGui(gui);
    this.bindExposureGui(gui);
    this.bindPostGui(gui);
  }

  private bindFogGui(gui: GUI): void {
    const folder = gui.addFolder('Atmosphere');
    const s = this.fog.settings;
    folder.add(s, 'enabled').name('volumetric fog').onChange((v: boolean) => { this.fog.setEnabled(v); this.syncFog(); });
    folder.add(s, 'density', 0, 0.12, 0.001).name('density (1/m)');
    folder.add(s, 'heightFalloff', 0, 2, 0.01).name('height falloff (1/m)');
    folder.add(s, 'baseHeight', -5, 10, 0.05).name('base height (m)');
    folder.add(s, 'sunIntensity', 0, 12, 0.05).name('sun scatter');
    folder.add(s, 'anisotropy', -0.9, 0.9, 0.01).name('anisotropy g');
    folder.add(s, 'ambientIntensity', 0, 3, 0.01).name('sky scatter');
    folder.add(s, 'noiseStrength', 0, 1, 0.01).name('noise');
    folder.add(s, 'noiseScale', 0.02, 1, 0.01).name('noise scale (1/m)');
    folder.add(s, 'windSpeed', 0, 5, 0.05).name('wind (m/s)');
    folder.add(s, 'temporalBlend', 0, 0.97, 0.01).name('temporal blend');
    folder.close();
  }

  private bindExposureGui(gui: GUI): void {
    const folder = gui.addFolder('Exposure');
    const s = this.autoExposure.settings;
    folder.add(s, 'auto').name('auto (meter)');
    folder.add(s, 'manual', 0.05, 8, 0.01).name('manual');
    folder.add(s, 'key', 0.05, 0.5, 0.01).name('middle grey');
    folder.add(s, 'minEV', -6, 0, 0.1).name('min EV');
    folder.add(s, 'maxEV', 0, 6, 0.1).name('max EV');
    folder.add(s, 'speedUp', 0.1, 10, 0.1).name('speed up (1/s)');
    folder.add(s, 'speedDown', 0.1, 10, 0.1).name('speed down (1/s)');
    folder.add(this.grainState, 'enabled').name('film grain').onChange(() => this.syncGrain());
    folder.add(this.grainStrength, 'value', 0, 0.15, 0.005).name('grain strength');
    folder.close();
  }

  private bindPostGui(gui: GUI): void {
    const folder = gui.addFolder('Post');
    const taa = this.frameGraph.taa;
    const blur = this.motionBlur.settings;
    folder.add(this.aaParams, 'mode', ['taa', 'fxaa', 'none']).name('anti-aliasing').onChange((m: Antialiasing) => this.frameGraph.setAntialiasing(m));
    folder.add(taa.historyWeight, 'value', 0, 0.97, 0.01).name('taa history');
    folder.add(taa.clipGamma, 'value', 0.5, 2, 0.05).name('taa clip gamma');
    folder.add({ stencil: taa.stencil.active }, 'stencil').name('taa motion stencil').onChange((v: boolean) => taa.setStencil(v));
    folder.add(taa.stencil.weight, 'value', 0, 0.9, 0.05).name('stencil history');
    folder.add(this.glare, 'enabled').name('veiling glare').onChange(() => this.syncGlare());
    folder.add(this.glare, 'strength', 0, 0.5, 0.005).name('glare strength').onChange(() => this.syncGlare());
    folder.add(this.glare, 'radius', 0, 1, 0.01).name('glare radius').onChange(() => this.syncGlare());
    folder.add(blur, 'enabled').name('motion blur').onChange(() => this.syncMotionBlur());
    folder.add(blur, 'gaze', ['centre', 'camera']).name('blur relative to');
    folder.add(blur, 'integrationMs', 5, 100, 1).name('eye integration (ms)');
    folder.add(blur, 'pursuitGain', 0, 1, 0.01).name('pursuit gain');
    folder.add(blur, 'pursuitLagMs', 20, 400, 5).name('pursuit lag (ms)');
    folder.add(blur, 'shutter', 0, 1, 0.01).name('camera shutter');
    folder.add(blur, 'samples', 4, 24, 1).name('blur samples');
    folder.add(blur, 'depthExtent', 0.01, 1, 0.01).name('blur depth extent (m)');
    folder.close();
  }

  beforeRender(now: number, dt: number): void {
    this.fog.update(now);
    const { width, height } = this.renderer.domElement;
    this.autoExposure.update(this.frameGraph.taa.historyTexture, width, height, dt);
  }

  hooks() {
    const frameGraph = this.frameGraph;
    const renderer = this.renderer;
    return {
      enabled: (value?: boolean) => { if (typeof value === 'boolean') { this.fog.setEnabled(value); this.syncFog(); } return this.fog.enabled; },
      settings: this.fog.settings,
      grid: [this.fog.width, this.fog.height, this.fog.depth],
      invalidate: () => this.fog.invalidateHistory(),
      glare: (value?: boolean) => { if (typeof value === 'boolean') { this.glare.enabled = value; this.syncGlare(); } return this.glare.enabled; },
      split: (view: SplitView, at = 0.5) => { frameGraph.splitPosition = at; frameGraph.setSplitView(view); frameGraph.forceRebuild(); },
      exposureSettings: this.autoExposure.settings,
      exposure: () => this.autoExposure.read(),
      taaFrame: () => readFloatTexture(renderer, frameGraph.taa.resolvedTexture),
      taaState: () => frameGraph.taa.state,
      velocityFrame: () => readFloatTexture(renderer, frameGraph.scenePass.getTexture('velocity')),
      sceneFrame: () => readFloatTexture(renderer, frameGraph.scenePass.getTexture('output')),
      taaInputFrame: () => readFloatTexture(renderer, frameGraph.taa.inputTexture!),
      grain: (value?: boolean) => { if (typeof value === 'boolean') { this.grainState.enabled = value; this.syncGrain(); } return this.grainState.enabled; },
      motionBlur: (value?: boolean) => { if (typeof value === 'boolean') { this.motionBlur.settings.enabled = value; this.syncMotionBlur(); } return this.motionBlur.enabled; },
      motionBlurSettings: this.motionBlur.settings,
      motionBlurGaze: () => this.motionBlur.readGaze(renderer),
      still: (value?: boolean) => { if (typeof value === 'boolean') this.still = value; return this.still; },
      computeCalls: () => renderer.info.compute.frameCalls,
      frameGraph: () => frameGraph,
      memory: () => ({ ...renderer.info.memory }),
      aa: (mode?: Antialiasing) => { if (mode) { this.aaParams.mode = mode; frameGraph.setAntialiasing(mode); } return frameGraph.antialiasingMode; },
    };
  }
}
