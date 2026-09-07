// @ts-nocheck -- WGSL helper module in the vendored webgiya style: functions refer to
// storage bindings by name and are bound by the dependency list of whatever top-level
// `wgslFn` compiles them.

import { wgsl, wgslFn } from 'three/tsl';
import { rayStruct, constants, bvhIntersectFirstHit } from '../bvh/webgpu/index.js';
import { dynBoundsHit, dynBvhIntersectFirstHit } from './dynamicBvh';
import { consts } from './wgslConsts';
import { MAX_GI_LIGHTS } from './sceneLights';

/**
 * How a ray hit is turned into radiance — in one place, for every tracer in the build.
 *
 * There are three things in this repository that fire a ray into the scene and then have
 * to decide what the surface it landed on is emitting back: the surfel integrator, the
 * screen-probe final gather, and the reflection pass. They agreed on the BVH long ago
 * (`traceScene`), and they did not agree on shading — each carried its own copy of "one
 * directional light, one shadow ray, Lambert over pi". Copies drift, and a reflection
 * that disagrees with the diffuse GI about how bright a wall is looks exactly like a
 * broken reflection.
 *
 * ------------------------------------------------------------------------------
 * INTERFACE — what a consumer has to do to use this
 * ------------------------------------------------------------------------------
 *
 * 1. Add to the dependency list of the top-level `wgslFn`:
 *
 *      giLightConsts, giOccluded, giSampleLight, giShadeHit, giHitEmissive
 *
 *    plus whatever it already needs for `bvhIntersectFirstHit` /
 *    `dynBvhIntersectFirstHit` — this module does not bind the BVHs, it only calls
 *    them, so the consumer's existing `bvh.bvhNode` / `dynBvh.bvhNode` entries are
 *    what make the shadow rays legal.
 *
 * 2. Pass these into the kernel (all exported from './sceneLights'):
 *
 *      lightsTex:  texture_2d<f32>  <- giLightsTexture
 *      lightCount:     u32          <- U_GI_LIGHT_COUNT
 *      lightSamples:   u32          <- U_GI_LIGHT_SAMPLES
 *      emissiveBase:   i32          <- U_GI_EMISSIVE_BASE  (-1: scene has none)
 *      emissiveScale:  f32          <- U_GI_EMISSIVE_SCALE
 *
 *    and call `syncSceneLights(scene)` once per frame on the CPU side.
 *
 * 3. At the hit, call:
 *
 *      let direct = giShadeHit(lightsTex, hitPoint, hitNormal, albedo, eps,
 *                              dynTrace, dynBounds, lightCount, lightSamples, rnd);
 *      let emit   = giHitEmissive(diffuseTex, diffuseSampler, hitUv, matId, hitLod,
 *                                 emissiveBase, emissiveScale);
 *
 *    `direct` is outgoing radiance from a Lambert surface of that albedo, summed over
 *    the light list, shadowed. `emit` is the surface's own emission and is deliberately
 *    NOT multiplied by albedo or by any `giFromDirect` scale — an emissive surface is a
 *    light, and scaling a light by the bounce-strength knob would make it dim when the
 *    user asked for less bouncing.
 *
 *    `rnd` is any decorrelated number in [0,1); the integrator feeds it a blue-noise
 *    channel. It only matters when the light list is longer than `lightSamples`.
 * ------------------------------------------------------------------------------
 */
export const giLightConsts = wgsl(/* wgsl */ `
  const MAX_GI_LIGHTS : u32 = ${MAX_GI_LIGHTS}u;

  const GI_LIGHT_DIRECTIONAL : f32 = 0.0;
  const GI_LIGHT_POINT : f32 = 1.0;
  const GI_LIGHT_SPOT : f32 = 2.0;

  struct GiLightSample {
    // Unit vector from the shading point towards the light.
    dir: vec3f,
    // Incident radiance at the point, after distance and cone falloff, before N.L.
    radiance: vec3f,
    // How far a shadow ray may travel before it is past the light and no longer
    // occluding. INFINITY for a directional light.
    dist: f32,
    valid: bool,
  };
`);

/**
 * "Is anything between here and there", with a `there`.
 *
 * `traceSceneOccluded` in dynamicBvh.ts answers the unbounded version, which is the
 * only question a directional light ever asks. A point light two metres away asks a
 * different one, and answering it with the unbounded test shadows the light with
 * geometry that is *behind* it — which reads as a lamp that does not work.
 *
 * Both traversals are closest-hit anyway, so bounding the query costs one comparison.
 */
export const giOccluded = wgslFn(
  /* wgsl */ `
  fn giOccluded( ray: Ray, maxDist: f32, dynEnabled: f32, dynBounds: vec4f ) -> bool {
    let s = bvhIntersectFirstHit( ray );
    if ( s.didHit && s.dist < maxDist ) { return true; }

    if ( dynEnabled > 0.5 && dynBoundsHit( ray, dynBounds ) ) {
      let d = dynBvhIntersectFirstHit( ray );
      if ( d.didHit && d.dist < maxDist ) { return true; }
    }
    return false;
  }
`,
  [bvhIntersectFirstHit, dynBvhIntersectFirstHit, dynBoundsHit, rayStruct, constants],
);

/**
 * One light, evaluated at one point.
 *
 * Falloff mirrors three.js `getDistanceAttenuation` / `getSpotAttenuation` rather than
 * inventing a curve, because the raster pass and this tracer have to agree about how
 * bright a lamp is at two metres. They disagree about everything else already (one is
 * a PBR shader, the other is Lambert over pi); making them also disagree about
 * *distance* would put the indirect term permanently out of step with the direct one
 * and there would be no single knob to bring it back.
 */
export const giSampleLight = wgslFn(
  /* wgsl */ `
  fn giSampleLight( lightsTex: texture_2d<f32>, index: u32, p: vec3f ) -> GiLightSample {
    var out: GiLightSample;
    out.valid = false;
    out.dir = vec3f(0.0, 1.0, 0.0);
    out.radiance = vec3f(0.0);
    out.dist = INFINITY;

    // One row per light, one texel per vec4. textureLoad, never a sample: a filtered
    // read of a light table interpolates between two lights and returns one that is
    // not in the scene.
    let v0 = textureLoad( lightsTex, vec2u( 0u, index ), 0 );
    let v1 = textureLoad( lightsTex, vec2u( 1u, index ), 0 );
    let v2 = textureLoad( lightsTex, vec2u( 2u, index ), 0 );
    let v3 = textureLoad( lightsTex, vec2u( 3u, index ), 0 );

    let kind = v0.w;
    let colour = v1.xyz;
    if ( dot( colour, vec3f(1.0) ) <= 0.0 ) { return out; }

    if ( kind < 0.5 ) {
      // Directional: v2.xyz already points at the light.
      out.dir = normalize( v2.xyz );
      out.radiance = colour;
      out.dist = INFINITY;
      out.valid = true;
      return out;
    }

    let toLight = v0.xyz - p;
    let dist = length( toLight );
    if ( dist <= 1e-5 ) { return out; }
    let L = toLight / dist;

    // three.js getDistanceAttenuation: inverse-power falloff, windowed by range.
    let decay = max( 0.0, v3.y );
    var atten = 1.0 / max( pow( dist, decay ), 0.01 );
    let range = v1.w;
    if ( range > 0.0 ) {
      let t = clamp( 1.0 - pow( dist / range, 4.0 ), 0.0, 1.0 );
      atten = atten * t * t;
    }
    if ( atten <= 1e-6 ) { return out; }

    if ( kind > 1.5 ) {
      // Spot: v2.xyz is the cone axis, pointing away from the light.
      let cosAngle = dot( normalize( v2.xyz ), -L );
      let cosOuter = v2.w;
      let cosInner = v3.x;
      let cone = smoothstep( cosOuter, max( cosInner, cosOuter + 1e-4 ), cosAngle );
      if ( cone <= 0.0 ) { return out; }
      atten = atten * cone;
    }

    out.dir = L;
    out.radiance = colour * atten;
    out.dist = dist;
    out.valid = true;
    return out;
  }
`,
  [giLightConsts, constants],
);

/**
 * Direct lighting at a ray hit, over the whole light list, with shadow rays.
 *
 * The estimator: when the list is short every light is evaluated, which is exact. When
 * it is long, `samples` lights are drawn by stratified selection over a random offset
 * and the sum is scaled by `count / samples`. That keeps the expectation right and the
 * ray budget flat — the alternative, a shadow ray per light per sample, makes the cost
 * of a frame a function of how many torches the level designer placed rather than of
 * how much light any of them delivers.
 *
 * It is deliberately *uniform* selection rather than importance by intensity. Power
 * sampling wins on a list where one light dominates and loses badly on the case this
 * scene is aimed at — a handful of comparable lamps in one room — because it starves
 * the ones it decides are dim and their bounce disappears. When the list gets long
 * enough for that trade to matter, the right answer is a light BVH, not a better
 * weighting.
 */
export const giShadeHit = wgslFn(
  /* wgsl */ `
  fn giShadeHit(
    lightsTex: texture_2d<f32>,
    p: vec3f,
    n: vec3f,
    albedo: vec3f,
    eps: f32,
    dynEnabled: f32,
    dynBounds: vec4f,
    lightCount: u32,
    lightSamples: u32,
    rnd: f32,
    medium: vec4f,
  ) -> vec3f {
    let count = min( lightCount, MAX_GI_LIGHTS );
    if ( count == 0u ) { return vec3f(0.0); }

    let wanted = max( 1u, lightSamples );
    let taken = min( wanted, count );
    // Exact when every light is visited; the reciprocal of the selection probability
    // otherwise. Both branches fall out of the same expression.
    let weight = f32( count ) / f32( taken );

    let offset = u32( clamp( rnd, 0.0, 0.999999 ) * f32( count ) );

    var sum = vec3f(0.0);
    var ray: Ray;
    ray.origin = p + n * eps;

    for ( var k: u32 = 0u; k < taken; k = k + 1u ) {
      // Stratified: one draw per equal slice of the list, so a 16-light room never
      // spends both of its samples on two lights that happen to sit next to each other
      // in the buffer.
      let idx = ( offset + ( k * count ) / taken ) % count;

      let s = giSampleLight( lightsTex, idx, p );
      if ( !s.valid ) { continue; }

      let NdotL = dot( n, s.dir );
      if ( NdotL <= 0.0 ) { continue; }

      ray.direction = s.dir;
      // Pull the far end in by eps as well: a light sitting *on* a surface (an emissive
      // panel with a point light inside it) otherwise shadows itself with the panel.
      let reach = select( s.dist - eps, INFINITY, s.dist >= INFINITY );
      if ( reach <= 0.0 ) { continue; }
      if ( giOccluded( ray, reach, dynEnabled, dynBounds ) ) { continue; }

      var radiance = s.radiance;
      // Below the water line the light has crossed the medium on a slanted path; the
      // shadow ray above already answered "is it blocked", this answers "what colour".
      if ( p.y < medium.x ) {
        let path = ( medium.x - p.y ) / max( 0.08, s.dir.y );
        radiance *= exp( -medium.yzw * path );
      }
      sum += radiance * albedo * NdotL * ( 1.0 / PI );
    }

    return sum * weight;
  }
`,
  [giLightConsts, giSampleLight, giOccluded, rayStruct, consts, constants],
);

/**
 * A hit's own emission, read out of the upper half of the diffuse array.
 *
 * Emissive lives in the same `texture_2d_array` as albedo rather than in a texture of
 * its own — layer `emissiveBase + matId` against layer `matId` — for the reason the
 * scale report gives about that array in the first place: a second array is a second
 * binding, a second mip chain and a second thing to keep the material ids in step with,
 * and the ids are the fragile part. One array means a material can only ever have one
 * id and the two channels cannot drift apart.
 *
 * `emissiveBase < 0` is a scene with nothing emissive in it, and costs one compare.
 */
export const giHitEmissive = wgslFn(
  /* wgsl */ `
  fn giHitEmissive(
    tex: texture_2d_array<f32>,
    texSampler: sampler,
    uv: vec2f,
    matId: i32,
    lod: f32,
    emissiveBase: i32,
    emissiveScale: f32,
  ) -> vec3f {
    if ( emissiveBase < 0 || emissiveScale <= 0.0 ) { return vec3f(0.0); }

    let layerCount = i32( textureNumLayers( tex ) );
    let layer = emissiveBase + matId;
    if ( layer < 0 || layer >= layerCount ) { return vec3f(0.0); }

    let maxLod = f32( max( 1u, textureNumLevels( tex ) ) - 1u );
    let c = textureSampleLevel( tex, texSampler, uv, layer, clamp( lod, 0.0, maxLod ) );
    return c.rgb * emissiveScale;
  }
`,
  [],
);
