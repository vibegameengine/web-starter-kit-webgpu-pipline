import type GUI from 'lil-gui';
import * as THREE from 'three/webgpu';
import { SkyAtmosphere, SkyEnvironment } from '../../shared/render/sky/index.ts';
import type { SunControls } from './sun.ts';
import { hook, type SceneHost, type UrlParams } from './host.ts';

const TWILIGHT_ELEVATION_DEG = -12;
const ENVIRONMENT_RECAPTURE_COS = Math.cos(THREE.MathUtils.degToRad(0.25));

export class SkyStage {
  readonly atmosphere: SkyAtmosphere;
  private readonly background: THREE.Node;
  private environment: SkyEnvironment | null = null;
  private readonly capturedSun = new THREE.Vector3(0, -2, 0);
  private environmentStale = true;
  private environmentTexture: THREE.DataTexture | null = null;

  constructor(renderer: THREE.WebGPURenderer, private readonly host: SceneHost, url: UrlParams) {
    this.atmosphere = new SkyAtmosphere(renderer, {
      ...host.sky,
      altitudeKm: url.num('skyAltitude') ?? host.sky?.altitudeKm ?? 0,
      sunDiscScale: url.num('sunDiscScale') ?? host.sky?.sunDiscScale ?? 1,
    });
    this.background = this.atmosphere.backgroundNode();
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
    this.environment = new SkyEnvironment(renderer, this.atmosphere, environment);
    this.environmentTexture = environment;
    this.update();
    await this.environment.capture();
  }

  update(): void {
    if (!this.enabled) return;
    this.atmosphere.update(this.host.camera, this.host.sun);
    this.recaptureWhenSunMoved();
  }

  private recaptureWhenSunMoved(): void {
    const environment = this.environment;
    if (!environment || environment.busy) return;
    const sun = this.atmosphere.sunDirection.value;
    if (!this.environmentStale && sun.dot(this.capturedSun) > ENVIRONMENT_RECAPTURE_COS) return;
    this.capturedSun.copy(sun);
    this.environmentStale = false;
    void environment.capture();
  }

  bindGui(gui: GUI, sun: SunControls): void {
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
    folder.add(parameters, 'mieScattering', 0, 0.05, 0.0005).name('haze (Mie, 1/km)').onChange(rebuild);
    folder.add(parameters, 'mieScaleHeightKm', 0.2, 5, 0.05).name('haze height (km)').onChange(rebuild);
    folder.add(parameters, 'mieAnisotropy', 0, 0.95, 0.01).name('haze forward glow').onChange(rebuild);
    folder.add(parameters, 'rayleighScaleHeightKm', 2, 16, 0.1).name('air height (km)').onChange(rebuild);
    folder.add(parameters.groundAlbedo, 'x', 0, 1, 0.01).name('planet albedo').onChange((v: number) => { parameters.groundAlbedo.set(v, v, v); rebuild(); });
    folder.add(parameters, 'multiScattering', 0, 2, 0.01).name('multiple scattering').onChange(rebuild);
    folder.open();
    hook('__sky', { settings, parameters, rebuild, sunLight: () => this.atmosphere.sunLightTransmittance.toArray(), environment: () => this.environment?.summary() ?? null, environmentTexture: () => this.environmentTexture });
  }

  private apply(): void {
    this.host.scene.backgroundNode = this.enabled ? this.background : null;
  }
}
