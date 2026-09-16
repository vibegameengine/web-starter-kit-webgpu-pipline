import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

export interface AtmosphereParameters {
  groundRadiusKm: number;
  topRadiusKm: number;
  rayleighScattering: THREE.Vector3;
  rayleighScaleHeightKm: number;
  mieScattering: number;
  mieAbsorption: number;
  mieScaleHeightKm: number;
  mieAnisotropy: number;
  ozoneAbsorption: THREE.Vector3;
  ozoneCentreKm: number;
  ozoneHalfWidthKm: number;
  groundAlbedo: THREE.Vector3;
  multiScattering: number;
}

/* @important Earth's clear-sky coefficients, per kilometre, as published by Hillaire, "A Scalable
   and Production Ready Sky and Atmosphere Rendering Technique", EGSR 2020, table 1: Rayleigh
   scattering 5.802/13.558/33.1 e-6 per metre with an 8 km scale height, Mie scattering 3.996e-6
   and absorption 0.444e-6 with 1.2 km, ozone absorption 0.650/1.881/0.085 e-6 in a tent layer
   centred at 25 km. Physical measurements, not anybody's code. */
export function earthAtmosphere(): AtmosphereParameters {
  return {
    groundRadiusKm: 6360,
    topRadiusKm: 6460,
    rayleighScattering: new THREE.Vector3(5.802e-3, 13.558e-3, 33.1e-3),
    rayleighScaleHeightKm: 8,
    mieScattering: 3.996e-3,
    mieAbsorption: 0.444e-3,
    mieScaleHeightKm: 1.2,
    mieAnisotropy: 0.8,
    ozoneAbsorption: new THREE.Vector3(0.65e-3, 1.881e-3, 0.085e-3),
    ozoneCentreKm: 25,
    ozoneHalfWidthKm: 15,
    groundAlbedo: new THREE.Vector3(0.3, 0.3, 0.3),
    multiScattering: 1,
  };
}

export class AtmosphereUniforms {
  readonly groundRadius = uniform(0);
  readonly topRadius = uniform(0);
  readonly rayleighScattering = uniform(new THREE.Vector3());
  readonly rayleighDensityScale = uniform(0);
  readonly mieScattering = uniform(0);
  readonly mieExtinction = uniform(0);
  readonly mieDensityScale = uniform(0);
  readonly mieAnisotropy = uniform(0);
  readonly ozoneAbsorption = uniform(new THREE.Vector3());
  readonly ozoneCentre = uniform(0);
  readonly ozoneHalfWidth = uniform(0);
  readonly groundAlbedo = uniform(new THREE.Vector3());
  readonly multiScattering = uniform(0);

  write(parameters: AtmosphereParameters): void {
    this.groundRadius.value = parameters.groundRadiusKm;
    this.topRadius.value = parameters.topRadiusKm;
    this.rayleighScattering.value.copy(parameters.rayleighScattering);
    this.rayleighDensityScale.value = -1 / parameters.rayleighScaleHeightKm;
    this.mieScattering.value = parameters.mieScattering;
    this.mieExtinction.value = parameters.mieScattering + parameters.mieAbsorption;
    this.mieDensityScale.value = -1 / parameters.mieScaleHeightKm;
    this.mieAnisotropy.value = parameters.mieAnisotropy;
    this.ozoneAbsorption.value.copy(parameters.ozoneAbsorption);
    this.ozoneCentre.value = parameters.ozoneCentreKm;
    this.ozoneHalfWidth.value = parameters.ozoneHalfWidthKm;
    this.groundAlbedo.value.copy(parameters.groundAlbedo);
    this.multiScattering.value = parameters.multiScattering;
  }
}
