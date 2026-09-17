import type GUI from 'lil-gui';
import * as THREE from 'three/webgpu';
import { positionWorld } from 'three/tsl';
import { AerialPerspective, CloudLayer, CloudShadowMap, DEFAULT_CLOUD_SETTINGS, SkyAtmosphere, SkyEnvironment } from '../../shared/render/sky/index.ts';
import type { FrameGraph } from '../../shared/render/index.ts';
import type { SunControls } from './sun.ts';
import { hook, type SceneHost, type UrlParams } from './host.ts';

export interface SkyBake {
  status(): string;
  rebake(): Promise<void>;
}

const TWILIGHT_ELEVATION_DEG = -12;
const ENVIRONMENT_RECAPTURE_COS = Math.cos(THREE.MathUtils.degToRad(0.25));
const CLOUDY_RECAPTURE_MS = 4000;

type ShadowFilter = (inputs: unknown) => THREE.Node;

export class SkyStage {
  readonly atmosphere: SkyAtmosphere;
  private readonly clearSky: THREE.Node;
  private readonly cloudySky: THREE.Node;
  readonly clouds: CloudLayer;
  readonly cloudShadow: CloudShadowMap;
  readonly aerial: AerialPerspective;
  private frameGraph: FrameGraph | null = null;
  private readonly applyAerial = (beauty: THREE.Node, depth: THREE.Node) => this.aerial.apply(beauty, depth) as THREE.Node;
  private lastCaptureMs = 0;
  private cloudSettingsSeen = '';
  private environment: SkyEnvironment | null = null;
  private readonly capturedSun = new THREE.Vector3(0, -2, 0);
  private environmentStale = true;
  private environmentTexture: THREE.DataTexture | null = null;
  private readonly captureListeners: (() => void)[] = [];

  constructor(renderer: THREE.WebGPURenderer, private readonly host: SceneHost, url: UrlParams) {
    this.atmosphere = new SkyAtmosphere(renderer, {
      ...host.sky,
      altitudeKm: url.num('skyAltitude') ?? host.sky?.altitudeKm ?? 0,
      sunDiscScale: url.num('sunDiscScale') ?? host.sky?.sunDiscScale ?? 1,
      aerialPerspective: url.flag('aerial', host.sky?.aerialPerspective ?? true),
      aerialDistanceScale: url.num('aerialScale') ?? host.sky?.aerialDistanceScale ?? 1,
    });
    this.aerial = new AerialPerspective(renderer, this.atmosphere);
    this.clouds = new CloudLayer(renderer, this.atmosphere, { ...host.clouds, enabled: url.flag('clouds', host.clouds?.enabled ?? true), resolutionDivisor: url.num('cloudRes') ?? host.clouds?.resolutionDivisor ?? 2, coverage: url.num('cloudCoverage') ?? host.clouds?.coverage ?? DEFAULT_CLOUD_SETTINGS.coverage });
    this.cloudShadow = new CloudShadowMap(renderer, this.atmosphere, this.clouds);
    this.shadeSunlightUnderClouds();
    this.clearSky = this.atmosphere.backgroundNode();
    this.cloudySky = this.atmosphere.backgroundNode((sky) => this.clouds.composite(sky));
    this.apply();
  }

  static fromHost(renderer: THREE.WebGPURenderer, host: SceneHost, url: UrlParams): SkyStage | null {
    const wanted = url.flag('sky', host.sky !== undefined);
    return wanted ? new SkyStage(renderer, host, url) : null;
  }

  get enabled(): boolean {
    return this.atmosphere.settings.enabled;
  }

  async lightEnvironment(renderer: THREE.WebGPURenderer, environment: THREE.DataTexture, url: UrlParams): Promise<void> {
    if (!url.flag('skyEnvironment', true)) return;
    this.environment = new SkyEnvironment(renderer, this.atmosphere, environment, this.clouds);
    this.environmentTexture = environment;
    this.update();
    await this.capture();
  }

  attachFrameGraph(frameGraph: FrameGraph): void {
    this.frameGraph = frameGraph;
    this.apply();
  }

  onEnvironmentCaptured(listener: () => void): void {
    this.captureListeners.push(listener);
  }

  async captureNow(): Promise<void> {
    await this.capture();
    await this.capture();
  }

  private async capture(): Promise<void> {
    if (!this.environment) return;
    try {
      await this.environment.capture();
      for (const listener of this.captureListeners) listener();
    } catch (error) {
      console.warn(`[sky] environment capture failed, the lighting keeps the previous sky: ${error}`);
    }
  }

  update(): void {
    if (!this.enabled) return;
    this.atmosphere.update(this.host.camera, this.host.sun);
    const cloudy = this.clouds.settings.enabled;
    if (cloudy) this.clouds.update(this.host.camera, performance.now() / 1000);
    this.cloudShadow.update(this.host.camera, cloudy);
    if (this.atmosphere.settings.aerialPerspective) this.aerial.update(this.host.camera, this.atmosphere.settings.aerialDistanceScale);
    if (this.environment) this.environment.cloudPresence.value = cloudy ? 1 : 0;
    this.recaptureWhenSunMoved();
  }

  private recaptureWhenSunMoved(): void {
    const environment = this.environment;
    if (!environment || environment.busy) return;
    const sun = this.atmosphere.sunDirection.value;
    const cloudSettings = this.clouds.settings.enabled ? JSON.stringify(this.clouds.settings) : 'clear';
    const windMoved = this.clouds.settings.enabled && performance.now() - this.lastCaptureMs > CLOUDY_RECAPTURE_MS;
    const cloudsChanged = cloudSettings !== this.cloudSettingsSeen;
    if (!this.environmentStale && !windMoved && !cloudsChanged && sun.dot(this.capturedSun) > ENVIRONMENT_RECAPTURE_COS) return;
    this.capturedSun.copy(sun);
    this.cloudSettingsSeen = cloudSettings;
    this.lastCaptureMs = performance.now();
    this.environmentStale = false;
    void this.capture();
  }

  bindGui(gui: GUI, sun: SunControls, bake: SkyBake): void {
    const folder = gui.addFolder('Sky');
    const settings = this.atmosphere.settings;
    const parameters = this.atmosphere.parameters;
    const rebuild = () => { this.atmosphere.invalidateAtmosphere(); this.environmentStale = true; };
    folder.add(settings, 'enabled').name('physical sky').onChange(() => this.apply());
    folder.add(sun.lightCfg, 'elevationDeg', TWILIGHT_ELEVATION_DEG, 90, 0.1).name('sun elevation').listen().onChange(() => sun.updateLightFromAngles());
    folder.add(sun.lightCfg, 'azimuthDeg', -180, 180, 0.1).name('sun azimuth').listen().onChange(() => sun.updateLightFromAngles());
    folder.add(sun.lightCfg, 'intensity', 0, 40, 0.1).name('sun above atmosphere').listen().onChange(() => sun.updateLightFromAngles());
    folder.add(settings, 'altitudeKm', 0, 60, 0.1).name('viewer altitude (km)');
    folder.add(settings, 'sunDiscScale', 0.5, 8, 0.1).name('sun disc size');
    folder.add(settings, 'tintSunLight').name('sun light through air');
    folder.add(settings, 'discPeak', 0.2, 20, 0.1).name('sun disc brightness');
    folder.add(settings, 'aerialPerspective').name('aerial perspective').onChange(() => this.apply());
    folder.add(settings, 'aerialDistanceScale', 1, 500, 1).name('aerial distance scale');
    this.bindBakeStatus(folder, bake);
    folder.add(parameters, 'mieScattering', 0, 0.05, 0.0005).name('haze (Mie, 1/km)').onChange(rebuild);
    folder.add(parameters, 'mieScaleHeightKm', 0.2, 5, 0.05).name('haze height (km)').onChange(rebuild);
    folder.add(parameters, 'mieAnisotropy', 0, 0.95, 0.01).name('haze forward glow').onChange(rebuild);
    folder.add(parameters, 'rayleighScaleHeightKm', 2, 16, 0.1).name('air height (km)').onChange(rebuild);
    folder.add(parameters.groundAlbedo, 'x', 0, 1, 0.01).name('planet albedo').onChange((v: number) => { parameters.groundAlbedo.set(v, v, v); rebuild(); });
    folder.add(parameters, 'multiScattering', 0, 2, 0.01).name('multiple scattering').onChange(rebuild);
    folder.open();
    this.bindCloudGui(gui);
    hook('__sky', { settings, parameters, rebuild, sunLight: () => this.atmosphere.sunLightTransmittance.toArray(), environment: () => this.environment?.summary() ?? null, environmentTexture: () => this.environmentTexture, clouds: this.clouds.settings });
  }

  private bindCloudGui(gui: GUI): void {
    const folder = gui.addFolder('Clouds');
    const settings = this.clouds.settings;
    folder.add(settings, 'enabled').name('volumetric clouds').onChange(() => this.apply());
    folder.add(settings, 'coverage', 0, 1, 0.01).name('coverage');
    folder.add(settings, 'bottomKm', 0.2, 6, 0.05).name('base altitude (km)');
    folder.add(settings, 'thicknessKm', 0.2, 8, 0.05).name('thickness (km)');
    folder.add(settings, 'densityPerKm', 1, 200, 1).name('density (1/km)');
    folder.add(settings, 'shapeScaleKm', 1, 40, 0.1).name('shape size (km)');
    folder.add(settings, 'detailScaleKm', 0.1, 4, 0.05).name('detail size (km)');
    folder.add(settings, 'detailErosion', 0, 1, 0.01).name('edge erosion');
    folder.add(settings, 'forwardScattering', 0, 0.95, 0.01).name('silver lining (g)');
    folder.add(settings, 'windSpeedKmPerMinute', 0, 10, 0.1).name('wind (km/min)');
    folder.add(settings, 'windHeadingDeg', -180, 180, 1).name('wind heading');
    folder.add(settings, 'historyWeight', 0, 0.97, 0.01).name('temporal history');
    folder.open();
  }

  /* @important Moving the sun re-captures the panorama at once, but the atlas and the probes stay as they
     were baked: nothing in this project re-bakes on its own. The folder therefore says when the baked
     light no longer matches the sky, and offers the bake that waits for the capture first - a bake
     started while the capture is still reading back would light the scene with the previous sky. */
  private bindBakeStatus(folder: GUI, bake: SkyBake): void {
    const state = { baked: bake.status() };
    folder.add(state, 'baked').name('baked light').listen().disable();
    setInterval(() => { state.baked = bake.status(); }, 500);
    const bakeFromSky = () => this.captureNow().then(bake.rebake);
    folder.add({ rebake: () => { void bakeFromSky(); } }, 'rebake').name('bake light from this sky');
    hook('__skyBake', { status: bake.status, bakeFromSky });
  }

  /* @important Cloud shadows ride inside the sun's own shadow filter rather than in any material, so
     every surface that already receives the sun darkens under a cloud, and a scene that installs no
     filter (the renderer's built-in PCF) is left untouched and says so in the console. */
  private shadeSunlightUnderClouds(): void {
    const shadow = this.host.sun.shadow as THREE.DirectionalLightShadow & { filterNode?: ShadowFilter };
    const filter = shadow.filterNode;
    if (!filter) { console.warn('[sky] the sun has no custom shadow filter; clouds cast no shadow'); return; }
    shadow.filterNode = (inputs) => (filter(inputs) as unknown as { mul(node: THREE.Node): THREE.Node }).mul(this.cloudShadow.sample(positionWorld));
  }

  private apply(): void {
    this.host.scene.backgroundNode = this.enabled ? (this.clouds.settings.enabled ? this.cloudySky : this.clearSky) : null;
    if (!this.enabled) this.host.sun.color.setRGB(1, 1, 1);
    this.frameGraph?.setAerialPerspective(this.enabled && this.atmosphere.settings.aerialPerspective ? this.applyAerial : null);
  }
}
