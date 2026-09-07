import * as THREE from 'three/webgpu';
import {
  Fn,
  color,
  exp,
  float,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  mx_worley_noise_vec2,
  normalWorld,
  normalize,
  positionWorld,
  smoothstep,
  step,
  transformNormalToView,
  uniform,
  vec3,
} from 'three/tsl';

export interface SandMaterialUniforms {
  time: ReturnType<typeof uniform>;
  sunColor: ReturnType<typeof uniform>;
  /** Water level in world metres. */
  waterLevel: ReturnType<typeof uniform>;
  /** Unit vector toward the sun; sets the slant of the light path through the water. */
  sunDir: ReturnType<typeof uniform>;
  /** Absorption per metre of the water above the floor (see water/medium.ts). */
  absorb: ReturnType<typeof uniform>;
}

/** Average of the dry albedo below; what the ray tracer reads for bounce colour. */
export const SAND_AVERAGE_COLOR = new THREE.Color(0.80, 0.68, 0.49);

/**
 * Coral-sand beach.
 *
 * Dry sand is a pale warm cream with a fine grain and a faint large-scale mottle; the
 * band along the water darkens and goes glossy (wet), and under the surface the sun
 * writes moving caustic lines onto it. Everything here is a function of world position
 * so the bake, the raster and the water shader agree on where the shoreline is.
 *
 * Caustics are emissive: a modulation of direct sunlight that the shadow map cannot
 * see, added as radiance rather than folded into albedo so the baked indirect term
 * does not inherit a moving pattern.
 */
export function createSandMaterial(u: SandMaterialUniforms): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  material.color = SAND_AVERAGE_COLOR.clone();
  material.roughness = 0.9;
  material.metalness = 0;
  material.name = 'sand';
  material.userData.lightmapAlbedo = true;

  const p = positionWorld;
  const grainFine = mx_noise_float(p.mul(220.0));
  const grainCoarse = mx_noise_float(p.mul(48.0).add(vec3(7.0, 0.0, 3.0)));
  const mottle = mx_fractal_noise_float(p.xz.mul(0.45), 3, 2.0, 0.55);
  const streaks = mx_fractal_noise_float(vec3(p.x.mul(0.9), p.z.mul(4.5), 2.0), 2, 2.0, 0.5);

  // Wet band: fully wet below the water line, dry a third of a metre up the beach.
  const aboveWater = p.y.sub(u.waterLevel);
  const wet = smoothstep(0.34, 0.03, aboveWater);
  const submerged = smoothstep(0.02, -0.06, aboveWater);

  const dry = color(0.86, 0.71, 0.48);
  const wetTint = color(0.50, 0.42, 0.30);
  const dark = grainCoarse.mul(0.07).add(grainFine.mul(0.05)).add(mottle.mul(0.06)).add(streaks.mul(0.03));
  // Shell fragments and dark grains, sparse.
  const speck = step(0.78, mx_noise_float(p.mul(160.0).add(vec3(0.0, 13.0, 0.0))));
  const albedoBase = mix(dry, wetTint, wet).mul(float(1.0).add(dark));
  const albedo = mix(albedoBase, albedoBase.mul(0.55), speck.mul(0.6));
  // Below the water line the sun arrives through the water: the floor is lit by what
  // the medium let through, same absorption the tracer and the water surface use.
  const sunPath = u.waterLevel.sub(p.y).max(0.0).div(vec3(u.sunDir).y.max(0.08));
  const litThroughWater = exp(vec3(u.absorb).mul(sunPath).negate());
  material.colorNode = albedo.mul(litThroughWater);

  material.roughnessNode = mix(float(0.92), float(0.30), wet);

  // Grain-scale bump: a gradient of the same noise, in world space, tilted into view space.
  const bump = Fn(() => {
    const e = float(0.02);
    const s = float(0.35);
    const q = p.mul(90.0);
    const h0 = mx_noise_float(q);
    const hx = mx_noise_float(q.add(vec3(e, 0.0, 0.0)));
    const hz = mx_noise_float(q.add(vec3(0.0, 0.0, e)));
    const dx = hx.sub(h0).div(e).mul(s).mul(mix(1.0, 0.35, wet));
    const dz = hz.sub(h0).div(e).mul(s).mul(mix(1.0, 0.35, wet));
    const n = normalize(normalWorld.sub(vec3(dx, 0.0, dz).mul(0.02)));
    return transformNormalToView(n);
  });
  material.normalNode = bump();

  // Caustics: two drifting Worley layers; cell edges are the bright filaments.
  const caustic = Fn(() => {
    const t = u.time;
    const depth = u.waterLevel.sub(p.y);
    const q1 = vec3(p.x.mul(3.0).add(t.mul(0.12)), p.z.mul(3.0).sub(t.mul(0.09)), t.mul(0.30));
    const q2 = vec3(p.x.mul(4.2).sub(t.mul(0.08)), p.z.mul(4.2).add(t.mul(0.13)), t.mul(0.24).add(5.0));
    const w1 = mx_worley_noise_vec2(q1, 1.0);
    const w2 = mx_worley_noise_vec2(q2, 1.0);
    const line1 = smoothstep(0.12, 0.0, w1.y.sub(w1.x));
    const line2 = smoothstep(0.12, 0.0, w2.y.sub(w2.x));
    const filaments = line1.mul(0.7).add(line2.mul(0.7)).add(line1.mul(line2).mul(1.6));
    // Fade in just below the surface, decay with depth (light spreads and absorbs).
    const fade = smoothstep(0.0, 0.06, depth).mul(exp(depth.mul(-1.4)));
    return filaments.mul(fade).mul(submerged);
  });
  material.emissiveNode = albedo.mul(vec3(u.sunColor)).mul(caustic()).mul(0.55);

  return material;
}
