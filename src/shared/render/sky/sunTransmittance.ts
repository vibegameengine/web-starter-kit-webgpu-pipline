import * as THREE from 'three/webgpu';
import type { AtmosphereParameters } from './atmosphereParameters.ts';

const STEPS = 64;

function extinctionAt(parameters: AtmosphereParameters, heightKm: number, out: THREE.Vector3): THREE.Vector3 {
  const height = Math.max(0, heightKm);
  const rayleigh = Math.exp(-height / parameters.rayleighScaleHeightKm);
  const mie = Math.exp(-height / parameters.mieScaleHeightKm) * (parameters.mieScattering + parameters.mieAbsorption);
  const ozone = Math.max(0, 1 - Math.abs(height - parameters.ozoneCentreKm) / parameters.ozoneHalfWidthKm);
  return out.copy(parameters.rayleighScattering).multiplyScalar(rayleigh)
    .addScalar(mie)
    .addScaledVector(parameters.ozoneAbsorption, ozone);
}

function hitsGround(parameters: AtmosphereParameters, radiusKm: number, cosZenith: number): boolean {
  if (cosZenith >= 0) return false;
  const ground = parameters.groundRadiusKm;
  return radiusKm * radiusKm * (cosZenith * cosZenith - 1) + ground * ground >= 0;
}

export function sunTransmittance(parameters: AtmosphereParameters, radiusKm: number, cosZenith: number, out = new THREE.Vector3()): THREE.Vector3 {
  if (hitsGround(parameters, radiusKm, cosZenith)) return out.set(0, 0, 0);
  const top = parameters.topRadiusKm;
  const distance = -radiusKm * cosZenith + Math.sqrt(Math.max(0, radiusKm * radiusKm * (cosZenith * cosZenith - 1) + top * top));
  const segment = distance / STEPS;
  const sinZenith = Math.sqrt(Math.max(0, 1 - cosZenith * cosZenith));
  const depth = new THREE.Vector3();
  const extinction = new THREE.Vector3();
  for (let step = 0; step < STEPS; step++) {
    const t = (step + 0.5) * segment;
    const x = sinZenith * t;
    const y = radiusKm + cosZenith * t;
    depth.addScaledVector(extinctionAt(parameters, Math.hypot(x, y) - parameters.groundRadiusKm, extinction), segment);
  }
  return out.set(Math.exp(-depth.x), Math.exp(-depth.y), Math.exp(-depth.z));
}
