import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  cameraPosition,
  normalize,
  color,
  exp,
  float,
  length,
  max,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalWorld,
  positionWorld,
  smoothstep,
  texture,
  transformNormalToView,
  uniform,
  vec3,
} from 'three/tsl';
import { layeredTerrainSurface, type TerrainLayer } from '../../shared/render/terrain/layeredSurface.ts';
import { SAND_SLICE, sandLayerMaps } from './sandLayerMaps.ts';

export interface SandMaterialUniforms {
  time: ReturnType<typeof uniform>;
  sunColor: ReturnType<typeof uniform>;
  /** Water level in world metres. */
  waterLevel: ReturnType<typeof uniform>;
  /** Unit vector toward the sun; sets the slant of the light path through the water. */
  sunDir: ReturnType<typeof uniform>;
  /** Absorption per metre of the water above the floor (see water/medium.ts). */
  absorb: ReturnType<typeof uniform>;
  /**
   * Wetness written by the water simulation over the slab (R = foam, G = wetness,
   * 0..1), sampled by world xz. Set to the live field once the water exists.
   */
  wetness: ReturnType<typeof texture>;
  slabHalf: ReturnType<typeof uniform>;
}

/**
 * Knobs for looking at the stack: `?sandRipples=`, `?sandLitter=` scale a layer's
 * mask (0 ablates it) and `?sandView=weights` paints what each layer owns —
 * red = ripples, green = wet, blue = litter. Without them a defect in one layer
 * can only be argued about.
 */
function sandOption(name: string, fallback: number): number {
  const raw = new URLSearchParams(window.location.search).get(name);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Average of the dry albedo below; what the ray tracer reads for bounce colour. */
export const SAND_AVERAGE_COLOR = new THREE.Color(0.80, 0.68, 0.49);

type F1 = Node;
type V3 = Node;

/**
 * How wet this point is: the swash field the water simulation writes, floored by
 * the static waterline so the sand under the sheet is never dry.
 */
function wetnessAt(u: SandMaterialUniforms, aboveWater: F1): { wet: F1; foam: F1; swash: F1 } {
  const fieldUv = positionWorld.xz.div(vec3(u.slabHalf).x.mul(2.0)).add(0.5);
  const field = u.wetness.sample(fieldUv as unknown as V3);
  const wet = max(smoothstep(0.08, 0.0, aboveWater), smoothstep(0.02, 0.7, field.g)) as F1;
  // Lace, not paint: the residue the swash left on DRY sand (channel A), broken by
  // a fractal mask. The foam riding the live sheet is the sheet's own to draw.
  const lace = mx_fractal_noise_float(positionWorld.mul(14.0).add(vec3(u.time.mul(0.15), 0, 0)), 3, 2.2, 0.55);
  const foam = smoothstep(0.45, 0.75, field.a.mul(0.9).add(lace.mul(0.55)))
    .mul(wet)
    .mul(smoothstep(-0.02, 0.01, aboveWater))
    .mul(smoothstep(0.03, 0.12, field.a)) as F1;
  return { wet, foam, swash: field.g as F1 };
}

/**
 * The beach as a layer stack: loose grain everywhere, the wind's ripples on the
 * dry sand above the swash, packed wet sand as a lid where the water has been,
 * and shell litter lying over all three, thickest along the strand line.
 */
function sandLayers(wet: F1, aboveWater: F1): TerrainLayer[] {
  const dry = smoothstep(0.01, 0.12, aboveWater).mul(float(1).sub(wet)) as F1;
  // Where the wind has had a clear run: ripples come in fields metres across,
  // not everywhere at once.
  const rippleField = smoothstep(0.22, 0.58, mx_fractal_noise_float(positionWorld.xz.mul(0.16), 3, 2.0, 0.55).add(0.5)) as F1;
  // Litter piles up where the swash gives up its load — a band just above the
  // waterline — and lies thinly everywhere else.
  const strand = smoothstep(0.02, 0.12, aboveWater).mul(smoothstep(0.40, 0.16, aboveWater)) as F1;
  // Sparse, and in drifts. Litter spread evenly over a beach is not a beach, it is
  // gravel: at 8 % coverage everywhere the sand read as a car park.
  const clump = smoothstep(0.55, 0.85, mx_fractal_noise_float(positionWorld.xz.mul(0.55), 3, 2.0, 0.5).add(0.5)) as F1;
  return [
    { name: 'dry grain', slice: SAND_SLICE.dryGrain, tileMeters: 0.85, blend: 'base', roughness: 0.94, normalStrength: sandOption('sandGrainN', 1) },
    {
      name: 'wind ripples', slice: SAND_SLICE.ripples, tileMeters: 1.7, blend: 'height',
      mask: dry.mul(rippleField).mul(sandOption('sandRipples', 1)) as F1, heightBias: 0.06, parallaxMeters: 0.012,
      contactShadow: 0.35, normalStrength: sandOption('sandRippleN', 1), roughness: 0.93, tiling: 'plain',
    },
    {
      name: 'wet packed', slice: SAND_SLICE.wetPacked, tileMeters: 1.6, blend: 'alpha',
      mask: wet, roughness: 0.28, normalStrength: 0.45,
    },
    {
      name: 'shell litter', slice: SAND_SLICE.litter, tileMeters: 1.15, blend: 'overlay',
      mask: mix(0.05, 1.0, strand).mul(clump).mul(sandOption('sandLitter', 1)) as F1, density: sandOption('sandLitterDensity', 0.05), parallaxMeters: 0.02,
      contactShadow: 0.8, normalStrength: 1.0, roughness: 0.5,
    },
  ];
}

/**
 * Quartz and shell facets catching the sun. It is the one thing that says SAND
 * rather than beige cloth from close up, and it has to die with distance: a
 * glint smaller than a pixel is not a highlight, it is noise.
 */
function sparkleRoughness(base: F1, wet: F1): F1 {
  const near = smoothstep(4.0, 0.8, length(cameraPosition.sub(positionWorld))) as F1;
  const facet = smoothstep(0.62, 0.78, mx_noise_float(positionWorld.mul(320.0)).add(0.5)) as F1;
  return mix(base, float(0.16), facet.mul(near).mul(float(1).sub(wet)).mul(0.75)) as F1;
}

/**
 * Coral-sand beach.
 *
 * Everything is a function of world position so the bake, the raster and the
 * water shader agree on where the shoreline is. Below the waterline the sun
 * arrives through the water, with the same absorption the tracer and the water
 * surface use; the caustics on that floor are drawn by the water pass, not here.
 */
export function createSandMaterial(u: SandMaterialUniforms): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  material.color = SAND_AVERAGE_COLOR.clone();
  material.roughness = 0.9;
  material.metalness = 0;
  material.name = 'sand';
  material.userData.lightmapAlbedo = true;

  const aboveWater = positionWorld.y.sub(u.waterLevel) as F1;
  const { wet, foam, swash } = wetnessAt(u, aboveWater);
  const surface = layeredTerrainSurface(sandLayerMaps(), sandLayers(wet, aboveWater), {
    sunDir: vec3(u.sunDir) as V3,
    geometryNormal: normalWorld as V3,
  });

  const foamed = mix(surface.albedo, color(0.93, 0.95, 0.96), foam.mul(0.5)) as V3;
  const sunPath = u.waterLevel.sub(positionWorld.y).max(0.0).div(vec3(u.sunDir).y.max(0.08));
  const litThroughWater = exp(vec3(u.absorb).mul(sunPath).negate());
  const shaded = foamed.mul(surface.shade).mul(litThroughWater) as V3;
  const view = new URLSearchParams(window.location.search).get('sandView');
  material.colorNode = shaded;
  // Emissive, not albedo: a debug view multiplied by the sun and the palms'
  // shadows says as much about the shadows as about the layer being looked at.
  const debugViews: Record<string, V3> = {
    weights: vec3(surface.weights[1], surface.weights[2], surface.weights[3]),
    wet: vec3(wet, swash, aboveWater.mul(2)),
    normal: surface.normal.mul(0.5).add(0.5),
    shade: vec3(surface.shade, surface.shade, surface.shade),
    albedo: surface.albedo,
    // The ripple layer alone: how far its own normal tilts (red, green) and how
    // much of the pixel it holds (blue).
    ripple: vec3(
      surface.looks[1].normal.x.abs().mul(2),
      surface.looks[1].normal.y.abs().mul(2),
      surface.weights[1],
    ),
  };
  if (view && debugViews[view]) {
    material.colorNode = vec3(0, 0, 0);
    material.emissiveNode = debugViews[view];
  }
  material.roughnessNode = sparkleRoughness(mix(surface.roughness, float(0.30), foam.mul(0.4)) as F1, wet);
  // `?sandTilt=0.6` tilts the whole sand normal by a constant, to prove the
  // material's normal reaches the lighting at all before any layer is blamed.
  const tilt = sandOption('sandTilt', 0);
  material.normalNode = transformNormalToView(
    tilt === 0 ? surface.normal : normalize(vec3(tilt, 1, 0)),
  );

  return material;
}
