import { Break, If, Loop, exp, float, length, select, vec3 } from 'three/tsl';
import { sphereDistances } from './atmosphereMedium.ts';
import { cloudDensity, type CloudUniforms } from './cloudDensity.ts';
import type { CloudNoiseVolumes } from './cloudNoise.ts';
import { readTransmittance, type LutSource } from './lutMapping.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const SUN_STEP_KM = [0.06, 0.12, 0.24, 0.48, 0.9, 1.6];
const OCTAVE_EXTINCTION = [1, 0.25, 0.05];
const OCTAVE_CONTRIBUTION = [1, 0.7, 0.45];
const OCTAVE_ECCENTRICITY = [1, 0.5, 0.15];
const GROUND_ALBEDO_FOR_BASES = 0.25;
const BACK_LOBE_G = -0.25;
const BACK_LOBE_WEIGHT = 0.2;
const OPAQUE_TRANSMITTANCE = 0.01;
const EMPTY_EXTINCTION = 1e-3;

export interface CloudLightContext {
  volumes: CloudNoiseVolumes;
  clouds: CloudUniforms;
  atmosphere: LutSource;
  sunDirection: N;
  sunIlluminance: N;
  ambient: N;
}

function henyeyGreenstein(cosTheta: N, g: N): N {
  const g2 = g.mul(g);
  return float(1).sub(g2).div(float(1).add(g2).sub(g.mul(cosTheta).mul(2)).max(1e-4).pow(1.5)).mul(1 / (4 * Math.PI));
}

function dualLobe(cosTheta: N, g: N): N {
  return henyeyGreenstein(cosTheta, g).mul(1 - BACK_LOBE_WEIGHT).add(henyeyGreenstein(cosTheta, float(BACK_LOBE_G)).mul(BACK_LOBE_WEIGHT));
}

function opticalDepthToSun(context: CloudLightContext, position: N): N {
  const depth = float(0).toVar();
  let travelled = 0;
  for (const step of SUN_STEP_KM) {
    const at = position.add(context.sunDirection.mul(travelled + step * 0.5));
    depth.addAssign(cloudDensity(context.volumes, context.clouds, at, false).mul(step));
    travelled += step;
  }
  return depth;
}

/* @important Multiple scattering inside the cloud as the octave sum of Wrenninge, Kulla and Lundqvist,
   "Oz: The Great and Volumetric" (SIGGRAPH 2013 talk): each octave lets light through a thinner
   medium, contributes less and scatters less forward. The published halving per octave left a 2 km
   deck at 90/km black underneath at noon, so the later octaves thin the medium faster (1, 1/4, 1/20)
   and keep more of their weight: that is what lets light diffuse into a thick base. */
function sunScattering(context: CloudLightContext, position: N, viewDirection: N): N {
  const depth = opticalDepthToSun(context, position);
  const cosTheta = viewDirection.dot(context.sunDirection);
  let sum: N = float(0);
  OCTAVE_EXTINCTION.forEach((extinctionScale, octave) => {
    const extinction = exp(depth.mul(-extinctionScale));
    const phase = dualLobe(cosTheta, context.clouds.forwardScattering.mul(OCTAVE_ECCENTRICITY[octave]));
    sum = sum.add(extinction.mul(phase).mul(OCTAVE_CONTRIBUTION[octave]));
  });
  return sum.add(diffuseTransmission(depth, context.clouds.forwardScattering));
}

/* @important Light that has scattered many times through a deep cloud, by the two-stream estimate of
   diffuse transmission through a conservative slab, 1 / (1 + 3/4 tau (1 - g)). The octaves above die
   exponentially and leave an overcast deck lit only by the blue sky, which read as a dark blue veil;
   real overcast is grey-white because this term falls off like 1/tau, not e^-tau. It is weighted in
   only where the optical depth is large, so thin edges keep the octave look. */
function diffuseTransmission(depth: N, forward: N): N {
  const slab = float(1).div(depth.mul(float(1).sub(forward)).mul(0.75).add(1));
  const deepOnly = float(1).sub(exp(depth.mul(-0.5)));
  return slab.mul(deepOnly).mul(1 / (4 * Math.PI));
}

function sunAtPosition(context: CloudLightContext, position: N): N {
  const radius = length(position);
  const cosSun = context.sunDirection.dot(position.div(radius));
  const planet = sphereDistances(position, context.sunDirection, context.atmosphere.atmosphere.groundRadius);
  const shadowed = planet.hit.and(planet.far.greaterThan(0));
  const light = readTransmittance(context.atmosphere, radius, cosSun).mul(context.sunIlluminance);
  return select(shadowed, vec3(0), light);
}

function inScattering(context: CloudLightContext, position: N, direction: N): N {
  const heightFraction = length(position).sub(context.clouds.bottomRadius).div(context.clouds.thickness).clamp(0, 1);
  const sun = sunAtPosition(context, position);
  const groundBounce = sun.mul(context.sunDirection.y.max(0)).mul(GROUND_ALBEDO_FOR_BASES / (4 * Math.PI)).mul(heightFraction.oneMinus());
  const ambient = context.ambient.mul(heightFraction.mul(0.6).add(0.4)).add(groundBounce);
  return sun.mul(sunScattering(context, position, direction)).add(ambient);
}

/* @important Two exits keep the march affordable: a sample with no cloud skips the six-step march
   toward the sun entirely (a branch, not a select - a select evaluates both sides on the GPU), and
   the ray stops once 99 % of the background is hidden. Measured at 1600x900, half resolution:
   44.8 fps with every sample lit, against 120 (the vsync cap) with the clouds off. */
export function marchCloudLayer(context: CloudLightContext, ray: { origin: N; direction: N; start: N; end: N; jitter: N; steps: number }): { luminance: N; transmittance: N; depth: N } {
  const luminance = vec3(0).toVar();
  const transmittance = float(1).toVar();
  const weightedDepth = float(0).toVar();
  const segment = ray.end.sub(ray.start).div(ray.steps);
  Loop(ray.steps, ({ i }: { i: N }) => {
    If(transmittance.lessThan(OPAQUE_TRANSMITTANCE), () => { Break(); });
    const t = ray.start.add(float(i).add(ray.jitter).mul(segment));
    const position = ray.origin.add(ray.direction.mul(t));
    const extinction = cloudDensity(context.volumes, context.clouds, position, true).toVar();
    If(extinction.greaterThan(EMPTY_EXTINCTION), () => {
      const segmentTransmittance = exp(extinction.mul(segment).negate());
      luminance.addAssign(inScattering(context, position, ray.direction).mul(float(1).sub(segmentTransmittance)).mul(transmittance));
      weightedDepth.addAssign(t.mul(transmittance.sub(transmittance.mul(segmentTransmittance))));
      transmittance.mulAssign(segmentTransmittance);
    });
  });
  const opacity = float(1).sub(transmittance).max(1e-4);
  return { luminance, transmittance, depth: weightedDepth.div(opacity) };
}
