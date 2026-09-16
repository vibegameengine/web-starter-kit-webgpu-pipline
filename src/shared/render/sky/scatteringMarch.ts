import { Loop, clamp, exp, float, length, max, select, texture, vec2, vec3 } from 'three/tsl';
import type * as THREE from 'three/webgpu';
import { ISOTROPIC_PHASE, miePhase, rayleighPhase, sampleMedium, sphereDistances } from './atmosphereMedium.ts';
import { readTransmittance, texelCentreUv, type LutSource } from './lutMapping.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const SAMPLE_OFFSET_IN_SEGMENT = 0.3;

export interface MarchRay {
  origin: N;
  direction: N;
  sunDirection: N;
  steps: number;
  phase: 'directional' | 'isotropic';
  multiScattering: THREE.Texture | null;
  multiScatteringSize: [number, number];
}

export function readMultiScattering(lut: LutSource, multi: { texture: THREE.Texture; size: [number, number] }, radius: N, cosSunZenith: N): N {
  const { groundRadius, topRadius } = lut.atmosphere;
  const unit = vec2(cosSunZenith.mul(0.5).add(0.5), radius.sub(groundRadius).div(topRadius.sub(groundRadius))).clamp(0, 1);
  return texture(multi.texture, texelCentreUv(unit, multi.size)).level(float(0)).rgb;
}

function traceLimit(lut: LutSource, ray: MarchRay): { distance: N; hitsGround: N } {
  const ground = sphereDistances(ray.origin, ray.direction, lut.atmosphere.groundRadius);
  const top = sphereDistances(ray.origin, ray.direction, lut.atmosphere.topRadius);
  const hitsGround = ground.hit.and(ground.near.greaterThan(0));
  return { distance: select(hitsGround, ground.near, max(top.far, 0)), hitsGround };
}

function phaseScattering(lut: LutSource, ray: MarchRay, medium: ReturnType<typeof sampleMedium>): N {
  if (ray.phase === 'isotropic') return medium.scattering.mul(ISOTROPIC_PHASE);
  const cosTheta = ray.direction.dot(ray.sunDirection);
  return medium.rayleighScattering.mul(rayleighPhase(cosTheta))
    .add(medium.mieScattering.mul(miePhase(cosTheta, lut.atmosphere.mieAnisotropy)));
}

function sunVisibility(lut: LutSource, position: N, sunDirection: N): N {
  const planet = sphereDistances(position, sunDirection, lut.atmosphere.groundRadius.mul(0.99999));
  return select(planet.hit.and(planet.far.greaterThan(0)), float(0), float(1));
}

/* @important The in-segment integral is analytic, (S - S e^{-sigma dt}) / sigma, as in Hillaire 2015
   "Physically Based and Unified Volumetric Rendering in Frostbite", slide 28, so a thick segment
   near the ground does not overshoot the light it can carry. `transfer` is the fraction of light
   one isotropic bounce keeps along the path; averaged over the sphere it is the ratio of the
   geometric series the multi-scattering texture sums. */
export function marchScattering(lut: LutSource, ray: MarchRay): { luminance: N; transfer: N; throughput: N; limit: N; hitsGround: N } {
  const { distance, hitsGround } = traceLimit(lut, ray);
  const luminance = vec3(0).toVar();
  const transfer = vec3(0).toVar();
  const throughput = vec3(1).toVar();
  const steps = float(ray.steps);
  Loop(ray.steps, ({ i }: { i: N }) => {
    const start = distance.mul(float(i).div(steps).pow(2));
    const end = distance.mul(float(i).add(1).div(steps).pow(2));
    const segment = end.sub(start);
    const position = ray.origin.add(ray.direction.mul(start.add(segment.mul(SAMPLE_OFFSET_IN_SEGMENT))));
    const radius = length(position);
    const cosSun = ray.sunDirection.dot(position.div(radius));
    const medium = sampleMedium(lut.atmosphere, radius);
    const direct = readTransmittance(lut, radius, cosSun).mul(sunVisibility(lut, position, ray.sunDirection)).mul(phaseScattering(lut, ray, medium));
    const multiple = ray.multiScattering
      ? readMultiScattering(lut, { texture: ray.multiScattering, size: ray.multiScatteringSize }, radius, cosSun).mul(medium.scattering)
      : vec3(0);
    const source = direct.add(multiple);
    const extinction = max(medium.extinction, vec3(1e-9));
    const segmentTransmittance = exp(extinction.mul(segment).negate());
    luminance.addAssign(throughput.mul(source.sub(source.mul(segmentTransmittance)).div(extinction)));
    transfer.addAssign(throughput.mul(medium.scattering).mul(segment));
    throughput.mulAssign(segmentTransmittance);
  });
  return { luminance, transfer, throughput, limit: distance, hitsGround };
}

export function groundBounce(lut: LutSource, ray: MarchRay, march: ReturnType<typeof marchScattering>): N {
  const point = ray.origin.add(ray.direction.mul(march.limit));
  const up = point.div(length(point));
  const cosSun = up.dot(ray.sunDirection);
  const lit = readTransmittance(lut, lut.atmosphere.groundRadius, cosSun).mul(clamp(cosSun, 0, 1));
  const bounce = lit.mul(march.throughput).mul(lut.atmosphere.groundAlbedo).div(Math.PI);
  return select(march.hitsGround, bounce, vec3(0));
}
