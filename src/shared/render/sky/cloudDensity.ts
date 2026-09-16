import * as THREE from 'three/webgpu';
import { float, length, max, select, texture3D, uniform, vec3 } from 'three/tsl';
import { sphereDistances } from './atmosphereMedium.ts';
import { remap, type CloudNoiseVolumes } from './cloudNoise.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export interface CloudSettings {
  enabled: boolean;
  coverage: number;
  bottomKm: number;
  thicknessKm: number;
  densityPerKm: number;
  shapeScaleKm: number;
  detailScaleKm: number;
  detailErosion: number;
  windSpeedKmPerMinute: number;
  windHeadingDeg: number;
  forwardScattering: number;
  maxDistanceKm: number;
  historyWeight: number;
  resolutionDivisor: number;
}

export const DEFAULT_CLOUD_SETTINGS: CloudSettings = {
  enabled: true,
  coverage: 0.73,
  bottomKm: 1.5,
  thicknessKm: 2.5,
  densityPerKm: 90,
  shapeScaleKm: 9,
  detailScaleKm: 0.6,
  detailErosion: 0.6,
  windSpeedKmPerMinute: 0.6,
  windHeadingDeg: 30,
  forwardScattering: 0.8,
  maxDistanceKm: 90,
  historyWeight: 0.9,
  resolutionDivisor: 2,
};

const COVERAGE_TO_THRESHOLD = 0.75;

export class CloudUniforms {
  readonly coverage = uniform(0);
  readonly bottomRadius = uniform(0);
  readonly topRadius = uniform(0);
  readonly thickness = uniform(1);
  readonly density = uniform(0);
  readonly shapeFrequency = uniform(0);
  readonly detailFrequency = uniform(0);
  readonly detailErosion = uniform(0);
  readonly offset = uniform(new THREE.Vector3());
  readonly forwardScattering = uniform(0);
  readonly maxDistance = uniform(0);
  readonly historyWeight = uniform(0);

  write(settings: CloudSettings, groundRadiusKm: number): void {
    this.coverage.value = settings.coverage;
    this.bottomRadius.value = groundRadiusKm + settings.bottomKm;
    this.topRadius.value = groundRadiusKm + settings.bottomKm + settings.thicknessKm;
    this.thickness.value = settings.thicknessKm;
    this.density.value = settings.densityPerKm;
    this.shapeFrequency.value = 1 / settings.shapeScaleKm;
    this.detailFrequency.value = 1 / settings.detailScaleKm;
    this.detailErosion.value = settings.detailErosion;
    this.forwardScattering.value = settings.forwardScattering;
    this.maxDistance.value = settings.maxDistanceKm;
    this.historyWeight.value = settings.historyWeight;
  }
}

/* @important Stratocumulus-to-cumulus profile: density ramps in over the bottom tenth of the layer so
   bases are flat and dark, and fades over the top half so tops round off, the vertical shape Schneider
   describes for the Nubis cumulus gradient. Coverage lowers the erosion threshold, so more sky fills
   in from the densest puffs outward instead of every cloud swelling uniformly. */
function heightProfile(fraction: N): N {
  const base = fraction.div(0.1).clamp(0, 1);
  const top = float(1).sub(fraction).div(0.5).clamp(0, 1);
  return base.mul(top);
}

export function cloudDensity(volumes: CloudNoiseVolumes, clouds: CloudUniforms, position: N, withDetail: boolean): N {
  const radius = length(position);
  const fraction = radius.sub(clouds.bottomRadius).div(clouds.thickness);
  const sample = vec3(position.x, radius, position.z).add(clouds.offset);
  const shape = texture3D(volumes.shape, sample.mul(clouds.shapeFrequency)).level(float(0));
  const weather = texture3D(volumes.shape, vec3(sample.x, 0, sample.z).mul(clouds.shapeFrequency.mul(0.23))).level(float(0)).b;
  const regions = remap(weather, float(0.3), float(0.7));
  const coverage = clouds.coverage.mul(regions.mul(0.7).add(0.5)).clamp(0, 1);
  const billow = remap(shape.r, shape.g.oneMinus().mul(0.6), float(1));
  const body = remap(billow.mul(heightProfile(fraction.clamp(0, 1))), float(1).sub(coverage.mul(COVERAGE_TO_THRESHOLD)), float(1));
  if (!withDetail) return body.mul(clouds.density);
  const detail = texture3D(volumes.detail, sample.mul(clouds.detailFrequency)).level(float(0)).r;
  const erosion = detail.mul(clouds.detailErosion).mul(fraction.mul(0.6).add(0.4));
  return remap(body, erosion, float(1)).mul(clouds.density);
}

export function layerSegment(clouds: CloudUniforms, origin: N, direction: N, groundRadius: N): { start: N; end: N; valid: N } {
  const radius = length(origin);
  const bottom = sphereDistances(origin, direction, clouds.bottomRadius);
  const top = sphereDistances(origin, direction, clouds.topRadius);
  const ground = sphereDistances(origin, direction, groundRadius);
  const hitsGround = ground.hit.and(ground.near.greaterThan(0));
  const below = radius.lessThan(clouds.bottomRadius);
  const above = radius.greaterThan(clouds.topRadius);
  const bottomAhead = bottom.hit.and(bottom.near.greaterThan(0));
  const start = select(below, bottom.far, select(above, max(top.near, 0), float(0)));
  const exitDown = select(bottomAhead, bottom.near, top.far);
  const end = select(below, top.far, exitDown).min(start.add(clouds.maxDistance));
  const valid = select(below, hitsGround.not(), select(above, top.hit.and(top.near.greaterThan(0)), float(1).greaterThan(0)));
  return { start, end, valid: valid.and(end.greaterThan(start)) };
}
