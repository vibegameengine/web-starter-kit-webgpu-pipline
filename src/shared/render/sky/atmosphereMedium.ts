import { abs, exp, float, max, sqrt, vec3 } from 'three/tsl';
import type { AtmosphereUniforms } from './atmosphereParameters.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const FOUR_PI = 4 * Math.PI;

export interface MediumSample {
  scattering: N;
  rayleighScattering: N;
  mieScattering: N;
  extinction: N;
}

export function sampleMedium(atmosphere: AtmosphereUniforms, radius: N): MediumSample {
  const height = max(radius.sub(atmosphere.groundRadius), 0);
  const rayleighDensity = exp(height.mul(atmosphere.rayleighDensityScale));
  const mieDensity = exp(height.mul(atmosphere.mieDensityScale));
  const ozoneDensity = max(float(1).sub(abs(height.sub(atmosphere.ozoneCentre)).div(atmosphere.ozoneHalfWidth)), 0);
  const rayleighScattering = vec3(atmosphere.rayleighScattering).mul(rayleighDensity);
  const mieScattering = vec3(atmosphere.mieScattering.mul(mieDensity));
  const extinction = rayleighScattering
    .add(vec3(atmosphere.mieExtinction.mul(mieDensity)))
    .add(vec3(atmosphere.ozoneAbsorption).mul(ozoneDensity));
  return { scattering: rayleighScattering.add(mieScattering), rayleighScattering, mieScattering, extinction };
}

export function rayleighPhase(cosTheta: N): N {
  return float(3 / (16 * Math.PI)).mul(float(1).add(cosTheta.mul(cosTheta)));
}

/* @important Cornette-Shanks rather than plain Henyey-Greenstein for the aerosols: it carries the
   (1 + cos^2) polarisation term, which puts back the faint brightening opposite the sun that
   Henyey-Greenstein loses, at the cost of one multiply. */
export function miePhase(cosTheta: N, g: N): N {
  const g2 = g.mul(g);
  const numerator = float(1).sub(g2).mul(float(1).add(cosTheta.mul(cosTheta)));
  const denominator = float(2).add(g2).mul(float(1).add(g2).sub(g.mul(cosTheta).mul(2)).pow(1.5));
  return float(3 / (8 * Math.PI)).mul(numerator).div(denominator);
}

export const ISOTROPIC_PHASE = 1 / FOUR_PI;

export function sphereDistances(origin: N, direction: N, radius: N): { near: N; far: N; hit: N } {
  const b = origin.dot(direction);
  const discriminant = b.mul(b).sub(origin.dot(origin)).add(radius.mul(radius));
  const root = sqrt(max(discriminant, 0));
  return { near: b.negate().sub(root), far: b.negate().add(root), hit: discriminant.greaterThanEqual(0) };
}
