// @ts-nocheck -- WGSL string plumbing; the node types are not worth fighting.
//
// Helpers for the screen-probe trace.
//
// Several of these are line-for-line the same maths as `surfelIntegratePass.ts`
// (tangent basis, equirect env sampling, the diffuse array fetch, the grid hash
// helpers, the cache lookup). They are copied rather than imported because those
// live as module-private consts inside upstream's pass, and because that file is
// vendored and under active rewrite for dynamic geometry — a copy that drifts is
// visible in review, an import that breaks is a merge conflict at a bad time.
// Any behavioural divergence from upstream is marked at the point it happens.
import { wgsl, wgslFn } from 'three/tsl';
import { rayStruct } from '../bvh/webgpu/index.js';
import { sceneHitStruct, traceSceneOccluded } from '../surfel/dynamicBvh.ts';
import { consts, hemiOctSquareDecode, hemiOctSquareEncode } from '../surfel/wgslConsts.ts';
import {
  compute_surfel_depth_weight,
  linear_sample_radial_depth,
  point_sample_radial_depth,
} from '../surfel/surfelRadialDepth.ts';
import {
  PROBE_ADAPTIVE_PER_TILE,
  PROBE_OCT,
  PROBE_TEXELS,
  PROBE_TILE,
} from './settings.ts';

export const probeConsts = wgsl(/* wgsl */ `
  const PROBE_TILE : u32 = ${PROBE_TILE}u;
  const PROBE_TILE_F : f32 = ${PROBE_TILE}.0;
  const PROBE_OCT : u32 = ${PROBE_OCT}u;
  const PROBE_OCT_F : f32 = ${PROBE_OCT}.0;
  const PROBE_TEXELS : u32 = ${PROBE_TEXELS}u;
  const PROBE_ADAPTIVE_PER_TILE : u32 = ${PROBE_ADAPTIVE_PER_TILE}u;

  struct ProbeCacheSample {
    colour: vec3f,
    weight: f32,
  };
`);

export const probeTangentBasis = wgslFn(/* wgsl */ `
  fn probeTangentBasis(normal: vec3f) -> mat3x3f {
    let n = normalize(normal);
    let up = select(vec3f(1,0,0), vec3f(0,0,1), abs(n.z) < 0.999);
    let t = normalize(cross(up, n));
    let b = cross(n, t);
    return mat3x3f(t, b, n);
  }
`);

/** Steradians per unit uv area of the hemi-oct square. Total over [0,1]^2 is 2pi. */
export const probeHemiOctJacobian = wgslFn(/* wgsl */ `
  fn probeHemiOctJacobian(uv: vec2f) -> f32 {
    let q = uv * 2.0 - 1.0;
    let p = vec2f(q.x + q.y, q.x - q.y) * 0.5;
    let v = vec3f(p.x, p.y, 1.0 - abs(p.x) - abs(p.y));
    let r2 = dot(v, v);
    let invR = inverseSqrt(max(1e-12, r2));
    return 2.0 * invR * invR * invR;
  }
`);

/**
 * A hash, not blue noise.
 *
 * The integrator gets a 1024x1024 blue-noise tile because its samples are
 * averaged by MSME over hundreds of frames and correlation shows up as banding.
 * A probe texel is one direction jittered inside one oct cell, temporally blended
 * at alpha 0.12 and then spatially filtered across nine probes — three layers of
 * averaging that a white-noise offset survives perfectly well. Not worth another
 * texture binding.
 */
export const probeJitter = wgslFn(/* wgsl */ `
  fn probeJitter(probeIndex: u32, texel: u32, frame: u32) -> vec2f {
    var h = probeIndex * 747796405u + texel * 2891336453u + frame * 2246822519u;
    h ^= h >> 15u; h *= 2246822519u;
    h ^= h >> 13u; h *= 3266489917u;
    h ^= h >> 16u;
    let a = f32(h & 0xffffu) / 65536.0;
    let b = f32((h >> 16u) & 0xffffu) / 65536.0;
    return vec2f(a, b);
  }
`);

export const probeEnvUV = wgslFn(/* wgsl */ `
  fn probeEnvUV(dirW: vec3f) -> vec2f {
    let d = normalize(dirW);
    let u = atan2(d.z, d.x) * (0.5 / PI) + 0.5;
    let v = acos(clamp(-d.y, -1.0, 1.0)) / PI;
    return vec2f(u, v);
  }
`);

export const probeSampleEnv = wgslFn(
  /* wgsl */ `
  fn probeSampleEnv(
    dirW: vec3f,
    envTex: texture_2d<f32>,
    envSampler: sampler,
    lod: f32
  ) -> vec3f {
    let uv = probeEnvUV(dirW);
    let hdr = textureSampleLevel(envTex, envSampler, uv, lod).rgb;
    let lum = dot(hdr, vec3f(0.2126, 0.7152, 0.0722));
    let knee = 5.0;
    let maxVal = 15.0;
    if (lum <= knee) { return hdr; }
    let compressed = knee + (maxVal - knee) * (1.0 - exp(-(lum - knee) / (maxVal - knee)));
    return hdr * (compressed / lum);
  }
`,
  [consts, probeEnvUV],
);

export const probeSampleDiffuse = wgslFn(/* wgsl */ `
  fn probeSampleDiffuse(
    tex: texture_2d_array<f32>,
    texSampler: sampler,
    uv: vec2f,
    layerIn: i32
  ) -> vec3f {
    let layerCount = textureNumLayers(tex);
    let layer = clamp(layerIn, 0, i32(layerCount) - 1);
    return textureSampleLevel(tex, texSampler, uv, layer, 0.0).rgb;
  }
`);

export const probeRadiusEpsilon = wgslFn(/* wgsl */ `
  fn probeRadiusEpsilon(sRad: f32) -> f32 {
    return clamp(sRad * 0.01, 0.0005, 0.01);
  }
`);

/** World -> cascaded grid -> hash. Same arithmetic the grid build and the integrator use. */
export const probeGridHelpers = wgsl(
  /* wgsl */ `
  fn probe_pos_to_grid_coord(pRel: vec3f) -> vec3i {
    return vec3i(floor(pRel / SURFEL_GRID_CELL_DIAMETER));
  }

  fn probe_grid_coord_to_cascade_float(coord: vec3i) -> f32 {
    let fcoord = vec3f(coord) + vec3f(0.5);
    let max_c = max(abs(fcoord.x), max(abs(fcoord.y), abs(fcoord.z)));
    return log2(max_c / (f32(SURFEL_CS) * 0.5));
  }

  fn probe_cascade_float_to_cascade(cf: f32) -> u32 {
    let v = ceil(max(0.0, cf));
    return u32(clamp(v, 0.0, f32(SURFEL_CASCADES - 1)));
  }

  fn probe_grid_coord_within_cascade(coord: vec3i, cascade: u32) -> vec3i {
    return (coord >> vec3<u32>(cascade)) + SURFEL_CS / 2;
  }

  fn probe_grid_coord_to_c4(coord: vec3i) -> vec4u {
    let cf = probe_grid_coord_to_cascade_float(coord);
    let cascade = probe_cascade_float_to_cascade(cf);
    let ucoord = probe_grid_coord_within_cascade(coord, cascade);
    let clamped = clamp(
      ucoord,
      vec3i(0, 0, 0),
      vec3i(SURFEL_CS - 1, SURFEL_CS - 1, SURFEL_CS - 1)
    );
    return vec4u(u32(clamped.x), u32(clamped.y), u32(clamped.z), cascade);
  }

  fn probe_grid_c4_to_hash(c4: vec4u) -> u32 {
    let cs = u32(SURFEL_CS);
    return c4.x + c4.y * cs + c4.z * cs * cs + c4.w * cs * cs * cs;
  }

  fn probe_surfel_radius_for_pos(pRel: vec3f) -> f32 {
    let dist = length(pRel);
    let cascadeRadius = SURFEL_GRID_CELL_DIAMETER * f32(SURFEL_CS) * 0.5;
    return SURFEL_BASE_RADIUS * max(1.0, dist / cascadeRadius);
  }
`,
  [consts],
);

/**
 * The read-only occlusion gate. `surfelRadialDepth.ts` only exports the
 * read-write flavour, which is bound to the integrator's buffer.
 */
const probeRadialOcclusion = wgslFn(
  /* wgsl */ `
  fn surfel_radial_occlusion(
    surfelIndex: u32,
    dirWS: vec3f,
    normalWS: vec3f,
    dist: f32,
    params: vec4f
  ) -> f32 {
    if (dist <= 0.0001) { return 0.0; }
    let n = normalize(normalWS);
    let up = select(vec3f(1, 0, 0), vec3f(0, 0, 1), abs(n.z) < 0.999);
    let t = normalize(cross(up, n));
    let b = cross(n, t);
    var hemi = vec3f(dot(dirWS, t), dot(dirWS, b), dot(dirWS, n));
    hemi.z = max(0.0, hemi.z);
    let uv = hemiOctSquareEncode(normalize(hemi));
    let m = linear_sample_radial_depth(surfelIndex, uv);
    let cosTheta = clamp(hemi.z, 0.0, 1.0);
    return compute_surfel_depth_weight(m, dist, cosTheta, params.x, params.y, params.z, params.w);
  }
`,
  [
    consts,
    hemiOctSquareEncode,
    linear_sample_radial_depth,
    compute_surfel_depth_weight,
  ],
);

/**
 * The world-space radiance cache read: upstream's `lookupSurfelGI`, with three
 * changes, all marked.
 *
 * The probe needs to know whether the cache had anything to say, not just what it
 * said — a zero return from upstream's version is ambiguous between "no light
 * here" and "no surfel here", and the entire point of this tier is that the
 * second case must never reach the screen as black. So it returns the
 * accumulated weight alongside the colour and the caller decides.
 *
 * It also reads the radial-depth atlas through the read-only sampler rather than
 * the integrator's read-write one, because the probe pass has no business
 * mutating a surfel's learned depth.
 *
 * And it comes in two flavours. WebGPU allows 14 storage buffers per compute
 * stage; the probe trace already needs both acceleration structures (8), the
 * surfel pool, moments, grid and depth atlas (4) and its own probe and radiance
 * buffers (2). That is exactly 14, and the keep-alive atomic would be the
 * fifteenth. It is not needed there: the far-field pass runs the same gather once
 * per probe every frame with `keepAlive` on, and that is what stops the age pass
 * recycling the cache the probes depend on.
 */
const makeSurfelCache = (name: string, keepAlive: boolean) => wgslFn(
  /* wgsl */ `
  fn ${name}(
    pt_ws: vec3f,
    normal_ws: vec3f,
    cam_pos: vec3f,
    grid_origin: vec3f,
    readOffset: u32,
    occParams: vec4f
  ) -> ProbeCacheSample {
    var out: ProbeCacheSample;
    out.colour = vec3f(0.0);
    out.weight = 0.0;

    let pRel = pt_ws - grid_origin;
    let gridCoord = probe_pos_to_grid_coord(pRel);
    let c4 = probe_grid_coord_to_c4(gridCoord);
    let hash = probe_grid_c4_to_hash(c4);
    let cellIdx = i32(hash % TOTAL_CELLS);

    let start = offsetsAndList.value[cellIdx];
    let end = offsetsAndList.value[cellIdx + 1];
    let count = max(end - start, 0);
    let maxCount = min(count, MAX_SURFELS_PER_CELL_LOOKUP);
    if (maxCount <= 0) { return out; }

    var totalColor = vec3f(0.0);
    var totalWeight = 0.0;
    var bestContrib = 0.0;
    var bestSid = -1;

    for (var i: i32 = 0; i < maxCount; i = i + 1) {
      let sid = offsetsAndList.value[OFFSETS_AND_LIST_START + start + i];
      if (sid < 0) { continue; }

      let surfel = surfels.value[u32(sid)];
      let sPos = surfel.posb.xyz;
      let sNor = normalize(surfel.normal);

      let sRad = probe_surfel_radius_for_pos(sPos - cam_pos) * SURFEL_RADIUS_OVERSCALE;
      let eps = probeRadiusEpsilon(sRad);
      let sPosOff = sPos + sNor * eps;

      let dV = pt_ws - sPosOff;
      let dist = length(dV);
      let dirWS = dV / max(1e-6, dist);

      let align = abs(dot(dV, sNor));
      let mahal = dist * (1.0 + align * SURFEL_NORMAL_DIRECTION_SQUISH);
      let directional = max(0.0, dot(sNor, normal_ws));
      var weight = smoothstep(sRad, 0.0, mahal) * directional;
      if (weight <= 0.0) { continue; }

      if (weight > 0.02) {
        weight *= surfel_radial_occlusion(u32(sid), dirWS, sNor, dist, occParams);
        if (weight <= 0.0) { continue; }
      }

      let sIrr = moments.value[u32(sid) + readOffset].irradiance.xyz;
      let contrib = sIrr * weight;
      let lenContrib = length(contrib);
      if (lenContrib > bestContrib) {
        bestContrib = lenContrib;
        bestSid = sid;
      }
      totalWeight += weight;
      totalColor += contrib;
    }

${
    keepAlive
      ? /* wgsl */ `
    // The surfel age pass recycles anything nothing has touched, and in probe mode
    // the per-pixel resolve that used to do the touching no longer runs — so
    // without this the cache the far field depends on quietly dies.
    if (bestSid >= 0 && bestContrib > 0.01) {
      let importance = clamp(i32(bestContrib * 50.0), 0, 50);
      atomicMax(&touched.value[bestSid], importance);
    }
    if (bestSid >= 0) {
      atomicMax(&touched.value[bestSid], 2);
    }
`
      : ''
  }
    if (totalWeight < 1e-5) { return out; }
    out.colour = totalColor / totalWeight;
    out.weight = totalWeight;
    return out;
  }
`,
  [
    consts,
    probeConsts,
    probeGridHelpers,
    probeRadiusEpsilon,
    hemiOctSquareEncode,
    point_sample_radial_depth,
    linear_sample_radial_depth,
    compute_surfel_depth_weight,
    probeRadialOcclusion,
  ],
);

/** The read-only gather, for the trace. Its `touched` writes would be a 15th binding. */
export const probeSurfelCacheRO = makeSurfelCache('probeSurfelCacheRO', false);
/** The same gather with the keep-alive, for the once-per-probe far-field pass. */
export const probeSurfelCache = makeSurfelCache('probeSurfelCache', true);

/**
 * What one probe ray brings back — pulled out of the trace kernel so it can be run
 * twice over the same ray.
 *
 * The dynamic term is a difference: the radiance a point receives with movable
 * geometry in the world, minus the radiance it receives without. That subtraction is
 * only worth anything if both halves are the *same estimator* down to the last
 * epsilon — if the two branches drift apart by so much as a different albedo boost,
 * the difference stops being "what the mover did" and starts being "how the two
 * copies disagree", and it does so on every pixel in the frame rather than near the
 * mover. So the trace calls this, twice, with `dynTrace` as the only thing that
 * differs, and when there is nothing dynamic in flight the two calls are bit-identical
 * and the difference is exactly zero. That last property is not a nicety: it is what
 * makes `?dyntrace=0` and `?mover=0` provably leave the baked statics alone.
 *
 * `far` is the probe's once-per-probe world-cache read, passed in rather than taken
 * again, for the same reason — a second gather would return a marginally different
 * number and put that difference into the delta.
 */
export const probeRayRadiance = wgslFn(
  /* wgsl */ `
  fn probeRayRadiance(
    ray: Ray,
    hit: SceneHit,
    eps: f32,
    nearField: f32,
    far: vec4f,
    diffuseTex: texture_2d_array<f32>,
    diffuseTexSampler: sampler,
    envTexture: texture_2d<f32>,
    envSampler: sampler,
    envIntensity: f32,
    envLod: f32,
    lightDir: vec3f,
    lightColor: vec3f,
    camPos: vec3f,
    gridOrigin: vec3f,
    momentsRead: u32,
    occParams: vec4f,
    albedoBoost: f32,
    dynTrace: f32,
    dynBounds: vec4f
  ) -> vec3f {
    var Li = vec3f(0.0);
    var needShade = false;

    if (!hit.didHit) {
      Li = probeSampleEnv(ray.direction, envTexture, envSampler, envLod) * envIntensity;
    } else if (hit.dist <= nearField) {
      needShade = true;
    } else {
      // Far field. The surfel cache is the world-space radiance cache, and its
      // irradiance at this probe already is the cosine-weighted average of everything
      // the hemisphere sees; using it as the radiance of the directions we declined to
      // trace is exact when the far field is isotropic and conserves energy when it is
      // not.
      if (far.w > 1e-5) {
        Li = far.xyz;
      } else {
        // The cache has a hole here. That hole is the defect this whole tier exists to
        // remove, so the probe pays for a full shade rather than emitting black.
        needShade = true;
      }
    }

    if (needShade) {
      let hitPoint = ray.origin + ray.direction * hit.dist;
      let hitNormal = normalize(hit.normal);
      // traceScene resolved the attribute out of whichever structure won, so nothing
      // here needs to know which one that was.
      let matId = i32(round(hit.attrib.z));
      var alb = probeSampleDiffuse(diffuseTex, diffuseTexSampler, hit.attrib.xy, matId);
      let y = max(1e-4, dot(alb, vec3f(0.2126, 0.7152, 0.0722)));
      let y2 = 1.0 - pow(1.0 - y, max(0.0, albedoBoost));
      alb = clamp(alb * (y2 / y), vec3f(0.0), vec3f(1.0));

      var shadowRay: Ray;
      shadowRay.origin = hitPoint + hitNormal * eps;
      shadowRay.direction = lightDir;
      if (!traceSceneOccluded(shadowRay, dynTrace, dynBounds)) {
        Li += lightColor * alb * max(0.0, dot(hitNormal, lightDir)) * (1.0 / PI);
      }
      let bounce = probeSurfelCacheRO(
        hitPoint, hitNormal, camPos, gridOrigin, momentsRead, occParams
      );
      Li += bounce.colour * alb;
    }

    return Li;
  }
`,
  [
    consts,
    probeConsts,
    rayStruct,
    sceneHitStruct,
    traceSceneOccluded,
    probeSampleEnv,
    probeSampleDiffuse,
    probeSurfelCacheRO,
    probeGridHelpers,
    probeRadiusEpsilon,
  ],
);

export { hemiOctSquareDecode };
