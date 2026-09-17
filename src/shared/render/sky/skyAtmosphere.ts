import * as THREE from 'three/webgpu';
import { acos, clamp, float, max, min, normalize, positionWorldDirection, pow, select, sqrt, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { AtmosphereUniforms, earthAtmosphere, type AtmosphereParameters } from './atmosphereParameters.ts';
import { AtmosphereLuts } from './atmosphereLuts.ts';
import { readTransmittance, skyViewUnit, texelCentreUv } from './lutMapping.ts';
import { sunTransmittance } from './sunTransmittance.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const METRES_PER_KM = 1000;
const MIN_ALTITUDE_KM = 0.0005;
const SUN_ANGULAR_DIAMETER_DEG = 0.533;
const RADIUS_RECOMPUTE_EPSILON_KM = 1e-3;
const SUN_RECOMPUTE_EPSILON = 1e-5;
/* @important Power-law limb darkening I(mu)/I(1) = mu^alpha, per channel for roughly the sRGB
   primaries' wavelengths, from the solar limb measurements fitted by Hestroffer and Magnan,
   "Wavelength dependency of the Solar limb darkening", A&A 333 (1998). The disc carries it, but
   whether it reaches the screen depends on exposure: under auto exposure at sunset the output
   transform still washes the disc toward white (harsh-critic run, 2026-09-17). */
const LIMB_DARKENING_ALPHA = new THREE.Vector3(0.397, 0.503, 0.652);

export interface SkyAtmosphereSettings {
  enabled: boolean;
  altitudeKm: number;
  sunDiscScale: number;
  discPeak: number;
  tintSunLight: boolean;
  aerialPerspective: boolean;
  aerialDistanceScale: number;
}

export const DEFAULT_SKY_SETTINGS: SkyAtmosphereSettings = {
  enabled: true,
  altitudeKm: 0,
  sunDiscScale: 1,
  discPeak: 0.6,
  tintSunLight: true,
  aerialPerspective: true,
  aerialDistanceScale: 1,
};

export class SkyAtmosphere {
  readonly parameters: AtmosphereParameters;
  readonly settings: SkyAtmosphereSettings;
  readonly luts: AtmosphereLuts;
  readonly sunDirection = uniform(new THREE.Vector3(0, 1, 0));
  readonly sunIlluminance = uniform(1);
  readonly discCosHalfAngle = uniform(1);
  readonly discSolidAngle = uniform(1);
  readonly discPeak = uniform(1);
  readonly sunLightTransmittance = new THREE.Vector3(1, 1, 1);
  private readonly uniforms = new AtmosphereUniforms();
  private atmosphereDirty = true;
  private computedRadius = -1;
  private computedSunCos = -2;

  constructor(renderer: THREE.WebGPURenderer, settings: Partial<SkyAtmosphereSettings> = {}, parameters = earthAtmosphere()) {
    this.parameters = parameters;
    this.settings = { ...DEFAULT_SKY_SETTINGS, ...settings };
    this.uniforms.write(parameters);
    this.luts = new AtmosphereLuts(renderer, this.uniforms);
  }

  invalidateAtmosphere(): void {
    this.uniforms.write(this.parameters);
    this.atmosphereDirty = true;
  }

  viewRadiusKm(camera: THREE.Camera): number {
    const altitude = this.settings.altitudeKm + camera.position.y / METRES_PER_KM;
    return this.parameters.groundRadiusKm + Math.max(MIN_ALTITUDE_KM, altitude);
  }

  update(camera: THREE.Camera, sun: THREE.DirectionalLight): void {
    const direction = sun.position.clone().sub(sun.target.position).normalize();
    this.sunDirection.value.copy(direction);
    this.sunIlluminance.value = sun.intensity;
    this.syncDisc();
    const radius = this.viewRadiusKm(camera);
    this.recompute(radius, direction.y);
    sunTransmittance(this.parameters, radius, direction.y, this.sunLightTransmittance);
    if (this.settings.tintSunLight) sun.color.setRGB(this.sunLightTransmittance.x, this.sunLightTransmittance.y, this.sunLightTransmittance.z, THREE.LinearSRGBColorSpace);
  }

  skyLuminance(direction: N): N {
    const toSun = vec3(this.sunDirection);
    const horizontalView = vec2(direction.x, direction.z);
    const horizontalSun = vec2(toSun.x, toSun.z);
    const cosAzimuth = horizontalView.dot(horizontalSun).div(max(horizontalView.length().mul(horizontalSun.length()), 1e-6));
    const unit = skyViewUnit(this.uniforms, this.luts.viewRadius, direction.y, acos(clamp(cosAzimuth, -1, 1)));
    return texture(this.luts.skyView, texelCentreUv(unit, this.luts.skyViewSize)).level(float(0)).rgb.mul(this.sunIlluminance);
  }

  backgroundNode(overlay?: (sky: N) => N): N {
    const direction = normalize(positionWorldDirection);
    const sky = this.skyLuminance(direction).add(this.sunDisc(direction, this.luts.viewRadius));
    return vec4(overlay ? overlay(sky) : sky, 1);
  }

  private sunDisc(direction: N, radius: N): N {
    const cosAngle = direction.dot(this.sunDirection);
    const halfAngleSquared = float(1).sub(this.discCosHalfAngle).mul(2);
    const angleSquared = max(float(1).sub(cosAngle).mul(2), 0);
    const radial = sqrt(max(float(1).sub(angleSquared.div(halfAngleSquared)), 0));
    const alpha = vec3(LIMB_DARKENING_ALPHA);
    const limb = pow(vec3(radial), alpha).mul(alpha.add(2).div(2));
    const edge = clamp(radial.mul(4), 0, 1);
    const transmittance = readTransmittance(this.luts.transmittanceSource, radius, direction.y);
    const luminance = limb.mul(transmittance).mul(this.sunIlluminance.div(this.discSolidAngle)).mul(edge);
    const aboveGround = direction.y.greaterThan(sqrt(max(radius.mul(radius).sub(this.uniforms.groundRadius.mul(this.uniforms.groundRadius)), 0)).div(radius).negate());
    return select(cosAngle.greaterThan(this.discCosHalfAngle).and(aboveGround), this.limitDisc(luminance), vec3(0));
  }

  /* @important The disc is 1/solid-angle = 147 000 times brighter than the illuminance it carries, and
     a per-channel clamp flattened every channel to the same ceiling: the disc drew white at sunset
     and its limb darkening never reached the screen (harsh-critic run, 2026-09-17). The ceiling now
     scales the colour as a whole, and sits at `discPeak` times the sun's illuminance - bright enough
     to dominate the sky, low enough that exposure and the output transform keep its colour and rim.
     The lighting never reads this value; the sun still lights the scene at full strength. */
  private limitDisc(luminance: N): N {
    const peak = max(luminance.x, max(luminance.y, luminance.z));
    const ceiling = this.sunIlluminance.mul(this.discPeak);
    return luminance.mul(min(float(1), ceiling.div(max(peak, 1e-6))));
  }

  private syncDisc(): void {
    const halfAngle = THREE.MathUtils.degToRad(SUN_ANGULAR_DIAMETER_DEG * this.settings.sunDiscScale) / 2;
    this.discCosHalfAngle.value = Math.cos(halfAngle);
    this.discSolidAngle.value = 2 * Math.PI * (1 - Math.cos(halfAngle));
    this.discPeak.value = this.settings.discPeak;
  }

  private recompute(radiusKm: number, sunCosZenith: number): void {
    if (this.atmosphereDirty) {
      this.luts.computeAtmosphere();
      this.atmosphereDirty = false;
      this.computedRadius = -1;
    }
    const moved = Math.abs(radiusKm - this.computedRadius) > RADIUS_RECOMPUTE_EPSILON_KM || Math.abs(sunCosZenith - this.computedSunCos) > SUN_RECOMPUTE_EPSILON;
    if (!moved) return;
    this.luts.computeSkyView(radiusKm, sunCosZenith);
    this.computedRadius = radiusKm;
    this.computedSunCos = sunCosZenith;
  }
}
