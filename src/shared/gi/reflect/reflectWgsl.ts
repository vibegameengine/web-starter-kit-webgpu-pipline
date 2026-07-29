// @ts-nocheck -- WGSL string plumbing; the node types describe none of this well.
//
// The specular half of the gather: BRDF-importance-sampled rays against the same two
// acceleration structures the diffuse tier traces, shaded through the same surface data.
//
// Two helpers below are copies rather than imports, and both are copies of things that
// live as module-private consts inside `surfelIntegratePass.ts` — a file this work is
// not allowed to touch and which is under active rewrite. `probeWgsl.ts` made the same
// call for the same reason and said so; the rule is that a copy that drifts is visible
// in review while an import that breaks is a merge conflict at a bad time. Divergence
// from the original is marked where it happens. There is none yet.
import { wgslFn } from 'three/tsl';
import { consts } from '../surfel/wgslConsts.ts';
import {
  probeGridHelpers,
  probeRadiusEpsilon,
  probeSampleEnv,
  probeSurfelCacheRO,
  probeTangentBasis,
} from '../probe/probeWgsl.ts';
import {
  sceneHitStruct,
  traceScene,
  traceSceneOccluded,
} from '../surfel/dynamicBvh.ts';
import { rayStruct } from '../bvh/webgpu/index.js';

/** Copy of `surfelIntegratePass.ts`'s ray-cone mip selection. Unmodified. */
export const reflectDiffuseLod = wgslFn(/* wgsl */ `
  fn reflectDiffuseLod(
    tex: texture_2d_array<f32>,
    footprintRadius: f32,
    dist: f32,
    lodScale: f32
  ) -> f32 {
    let maxLod = f32(max(1u, textureNumLevels(tex)) - 1u);
    let footprint = max(0.0, footprintRadius) + max(0.0, dist);
    return clamp(log2(max(1.0, footprint * max(1e-3, lodScale))), 0.0, maxLod);
  }
`);

/** Copy of `surfelIntegratePass.ts`'s array fetch, dead debug code removed. */
export const reflectSampleDiffuse = wgslFn(/* wgsl */ `
  fn reflectSampleDiffuse(
    tex: texture_2d_array<f32>,
    texSampler: sampler,
    uv: vec2f,
    layerIn: i32,
    lod: f32
  ) -> vec3f {
    let layerCount = textureNumLayers(tex);
    let layer = clamp(layerIn, 0, i32(layerCount) - 1);
    let maxLod = f32(max(1u, textureNumLevels(tex)) - 1u);
    return textureSampleLevel(tex, texSampler, uv, layer, clamp(lod, 0.0, maxLod)).rgb;
  }
`);

/**
 * Heitz's VNDF sampler (JCGT 2018), isotropic.
 *
 * Sampling the *visible* normal distribution rather than the plain NDF is what makes one
 * ray per pixel usable at all: rays are never generated below the horizon, so no sample
 * is thrown away, and the estimator's weight collapses to `F * G2/G1` with the
 * distribution and the 4·(V·H) Jacobian cancelling out exactly. The naive alternative —
 * sample D, divide by the pdf — has an unbounded weight at grazing angles and produces
 * exactly the fireflies a 0.1 temporal blend cannot remove.
 */
export const reflectSampleVndf = wgslFn(/* wgsl */ `
  fn reflectSampleVndf(Ve: vec3f, alpha: f32, u1: f32, u2: f32) -> vec3f {
    let Vh = normalize(vec3f(alpha * Ve.x, alpha * Ve.y, Ve.z));
    let lensq = Vh.x * Vh.x + Vh.y * Vh.y;
    let T1 = select(
      vec3f(1.0, 0.0, 0.0),
      vec3f(-Vh.y, Vh.x, 0.0) * inverseSqrt(max(1e-12, lensq)),
      lensq > 1e-12
    );
    let T2 = cross(Vh, T1);

    let r = sqrt(u1);
    let phi = 6.2831853 * u2;
    let t1 = r * cos(phi);
    var t2 = r * sin(phi);
    let s = 0.5 * (1.0 + Vh.z);
    t2 = (1.0 - s) * sqrt(max(0.0, 1.0 - t1 * t1)) + s * t2;

    let Nh = t1 * T1 + t2 * T2 + sqrt(max(0.0, 1.0 - t1 * t1 - t2 * t2)) * Vh;
    return normalize(vec3f(alpha * Nh.x, alpha * Nh.y, max(0.0, Nh.z)));
  }
`);

/**
 * Height-correlated Smith masking-shadowing, divided by the masking term the VNDF
 * sampler already accounted for. This is the whole of the estimator's weight besides
 * Fresnel — no pdf, no 1/(4 NoV NoL), because VNDF sampling cancelled them.
 */
export const reflectG2overG1 = wgslFn(/* wgsl */ `
  fn reflectG2overG1(NoV: f32, NoL: f32, alpha: f32) -> f32 {
    let a2 = alpha * alpha;
    let bV = sqrt(a2 + (1.0 - a2) * NoV * NoV);
    let bL = sqrt(a2 + (1.0 - a2) * NoL * NoL);
    let denom = NoV * bL + NoL * bV;
    if (denom <= 1e-8) { return 0.0; }
    return NoL * (NoV + bV) / denom;
  }
`);

/**
 * Radiance leaving a traced hit, towards the ray that found it.
 *
 * THIS IS THE SEAM. Everything the reflection tier knows about how a surface is lit is
 * in this one function, and it is deliberately the same recipe the probe trace and the
 * surfel integrator use: albedo out of the shared diffuse array by `uv.xy + matId`, one
 * shadow ray against both structures for the sun, plus the world-space cache for
 * everything that is not the sun.
 *
 * That last clause is the part that is about to be wrong. The sun is currently the only
 * analytic light in the frame, so "direct" and "the sun" are the same sentence here —
 * and a second agent is landing multiple lights and emissive materials, which will make
 * them different sentences everywhere at once. When that work exposes shared WGSL hit
 * shading, the body of this function is what should be deleted and replaced by a call to
 * it; the signature already carries everything such a call would need except the light
 * list itself. Nothing else in this module shades anything, so there is exactly one
 * place to change and no sun-only path hiding behind it.
 *
 * `dist > range` is the cheap tier: the cache alone, no shadow ray, no direct term. That
 * loses the sun on a distant reflected surface, which is the reason `range` defaults to
 * a value that covers this scene whole rather than to something clever.
 */
export const reflectShadeHit = wgslFn(
  /* wgsl */ `
  fn reflectShadeHit(
    hit: SceneHit,
    hitPoint: vec3f,
    hitNormal: vec3f,
    footprint: f32,
    eps: f32,
    range: f32,
    diffuseTex: texture_2d_array<f32>,
    diffuseTexSampler: sampler,
    lodScale: f32,
    albedoBoost: f32,
    lightDir: vec3f,
    lightColor: vec3f,
    camPos: vec3f,
    gridOrigin: vec3f,
    momentsRead: u32,
    occParams: vec4f,
    dynTrace: f32,
    dynBounds: vec4f
  ) -> vec3f {
    let matId = i32(round(hit.attrib.z));
    let lod = reflectDiffuseLod(diffuseTex, footprint, hit.dist, lodScale);
    var alb = reflectSampleDiffuse(diffuseTex, diffuseTexSampler, hit.attrib.xy, matId, lod);
    let y = max(1e-4, dot(alb, vec3f(0.2126, 0.7152, 0.0722)));
    let y2 = 1.0 - pow(1.0 - y, max(0.0, albedoBoost));
    alb = clamp(alb * (y2 / y), vec3f(0.0), vec3f(1.0));

    var Lo = vec3f(0.0);

    if (hit.dist <= range) {
      var shadowRay: Ray;
      shadowRay.origin = hitPoint + hitNormal * eps;
      shadowRay.direction = lightDir;
      if (!traceSceneOccluded(shadowRay, dynTrace, dynBounds)) {
        Lo += lightColor * alb * max(0.0, dot(hitNormal, lightDir)) * (1.0 / PI);
      }
    }

    let bounce = probeSurfelCacheRO(
      hitPoint, hitNormal, camPos, gridOrigin, momentsRead, occParams
    );
    Lo += bounce.colour * alb;
    return Lo;
  }
`,
  [
    consts,
    rayStruct,
    sceneHitStruct,
    traceSceneOccluded,
    reflectDiffuseLod,
    reflectSampleDiffuse,
    probeSurfelCacheRO,
    probeGridHelpers,
    probeRadiusEpsilon,
  ],
);

export {
  probeGridHelpers,
  probeRadiusEpsilon,
  probeSampleEnv,
  probeSurfelCacheRO,
  probeTangentBasis,
  traceScene,
  traceSceneOccluded,
};
