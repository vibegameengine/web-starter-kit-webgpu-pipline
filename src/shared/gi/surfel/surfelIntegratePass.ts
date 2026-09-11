// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// surfelIntegratePass.ts
import * as THREE from 'three/webgpu';
import { storage, uniform, wgslFn, wgsl, sampler, texture } from 'three/tsl';
import type { SurfelPool } from './surfelPool';
import type { SceneBVHBundle } from './sceneBvh';
import { bvhAnyHitWithin } from '../contact/boundedTrace.ts';
import { SurfelMoments, SurfelStruct } from './surfelPool';
import {
  bvhIntersectFirstHit,
  getVertexAttribute,
  rayStruct,
  constants,
} from '../bvh/webgpu/index.js';
import {
  dynBoundsHit,
  dynBvhIntersectFirstHit,
  getDynVertexAttribute,
  sceneHitStruct,
  traceScene,
  traceSceneOccluded,
  type DynamicBVHBundle,
} from './dynamicBvh';
import {
  snap_to_surfel_grid_origin,
  type SurfelHashGrid,
} from './surfelHashGrid';
import {
  SLG_TOTAL_FLOATS,
  SLG_DIM,
  SLG_LOBE_COUNT,
  MAX_SURFELS_PER_CELL_FOR_KEEP_ALIVE,
  SURFEL_IMPORTANCE_INDIRECT_MAX,
  SURFEL_DEPTH_TEXELS,
  OFFSETS_AND_LIST_START,
} from './constants';

import {
  CASCADES,
  SURFEL_BASE_RADIUS,
  SURFEL_CS,
  SURFEL_GRID_CELL_DIAMETER,
  SURFEL_NORMAL_DIRECTION_SQUISH,
  SURFEL_RADIUS_OVERSCALE,
  SURFEL_TTL,
  TOTAL_CELLS,
} from './constants';
import {
  update_surfel_depth2,
  surfelRadialDepthOcclusionRW,
  U_OCCLUSION_PARAMS,
} from './surfelRadialDepth';
import {
  giHitEmissive,
  giLightConsts,
  giOccluded,
  giSampleLight,
  giShadeHit,
} from './hitShading';
import {
  U_GI_EMISSIVE_BASE,
  U_GI_EMISSIVE_SCALE,
  U_GI_LIGHT_COUNT,
  U_GI_MEDIUM,
  U_GI_LIGHT_SAMPLES,
  giLightsTexture,
  syncSceneLights,
} from './sceneLights';
import { giKnobs } from './knobs';

const MAX_SURFELS_PER_CELL_LOOKUP = 32;

export type SurfelIntegratePass = {
  setExactReuse: (on: boolean) => void;
  invalidate: () => void;
  /**
   * The baked irradiance atlas, or null to read every hit from the surfel cache.
   *
   * A ray landing on unwrapped static geometry reads its light straight from the
   * atlas instead of gathering the cache at that point: the same light, one texture
   * fetch against a hash-grid walk of up to 32 entries. Changing the texture rebuilds
   * the kernel, so hand it a stable object.
   */
  setBakedAtlas: (texture: THREE.Texture | null, intensity?: unknown) => void;
  /**
   * `scene` rather than a light: the tracer reads every analytic light in the graph out
   * of the storage buffer `sceneLights.ts` refreshes here. It used to take one
   * `THREE.DirectionalLight`, which made "sun" and "light source" the same concept all
   * the way down to the WGSL and left point lights, spot lights and emissive materials
   * contributing exactly nothing to global illumination.
   */
  run: (
    renderer: THREE.WebGPURenderer,
    pool: SurfelPool,
    bvh: SceneBVHBundle,
    dynBvh: DynamicBVHBundle,
    grid: SurfelHashGrid,
    camera: THREE.PerspectiveCamera,
    scene: THREE.Object3D,
    dispatchArgs: THREE.IndirectStorageBufferAttribute,
    options?: { includeDynamic?: boolean; schedule?: boolean },
  ) => void;
  setBaseSampleCount: (count: number) => void;
  setAlbedoBoost: (boost: number) => void;
  setGiScales: (fromDirect: number, fromIndirect: number) => void;
  setEnvControls: (intensity: number, lod: number) => void;
  setLeafTransmit: (enabled: boolean) => void;
  setDynamicTracing: (enabled: boolean) => void;
};

// --- Grid helper functions (world → grid → hash) ---
export { consts } from './wgslConsts';
import { consts } from './wgslConsts';

export const envEquirectUV = wgslFn(/* wgsl */ `
  fn envEquirectUV(dirW: vec3f) -> vec2f {
    let d = normalize(dirW);
    // u: [-pi..pi] -> [0..1]
    let u = atan2(d.z, d.x) * (0.5 / PI) + 0.5;
    // v: [0..pi] -> [0..1]
    let v = acos(clamp(-d.y, -1.0, 1.0)) / PI;
    return vec2f(u, v);
  }
`);

// const sampleEnvEquirect = wgslFn(
//   /* wgsl */ `
//   fn sampleEnvEquirect(
//     dirW: vec3f,
//     envTex: texture_2d<f32>,
//     envSampler: sampler,
//     lod: f32
//   ) -> vec3f {
//     let uv = envEquirectUV(dirW);
//     // In compute you don't have derivatives, so use SampleLevel.
//     return textureSampleLevel(envTex, envSampler, uv, lod).rgb;
//   }
// `,
//   [consts],
// );

const sampleEnvEquirectClamped = wgslFn(
  /* wgsl */ `
  fn sampleEnvEquirect(
    dirW: vec3f,
    envTex: texture_2d<f32>,
    envSampler: sampler,
    lod: f32
  ) -> vec3f {
    let uv = envEquirectUV(dirW);
    // In compute you don't have derivatives, so use SampleLevel.
    let hdr =  textureSampleLevel(envTex, envSampler, uv, lod).rgb;
    let lum = dot(hdr, vec3f(0.2126, 0.7152, 0.0722));
    let knee = 5.0;   // preserve below this
    let maxVal = 15.0; // compress toward this

    if (lum <= knee) { return hdr; }

    let compressed = knee + (maxVal - knee) * (1.0 - exp(-(lum - knee) / (maxVal - knee)));
    return hdr * (compressed / lum);
    }
`,
  [consts],
);

/* @important The offset that lifts a ray off its own surface is float error, not a length in metres.
   clamp(sRad * 0.01, 0.0005, 0.01) put a hard half-millimetre floor under it, and design section 07's
   A3 is what that costs: the sealed room built a thousand times smaller has 0.2 mm walls, every ray
   started outside it, and the interior read 0.355 against 0.248 for the sunlit ground - brighter
   inside a closed box than out in the sun. float32 keeps about seven digits, so the offset scales
   with the coordinate it is added to. ?spawnEps=radius restores the old rule. Design section 03. */
const RADIUS_SPAWN_EPSILON = 'return clamp(sRad * 0.01, 0.0005, 0.01);';
const POSITION_SPAWN_EPSILON = 'let reach = max(abs(p.x), max(abs(p.y), abs(p.z))); return max(reach * 1e-5, 1e-7);';

export const spawnEpsilon = wgslFn(/* wgsl */ `
  fn spawn_epsilon(p: vec3f, sRad: f32) -> f32 {
    ${giKnobs.spawnEpsilonFromRadius() ? RADIUS_SPAWN_EPSILON : POSITION_SPAWN_EPSILON}
  }
`);

export const radiusBasedEpsilon = wgslFn(/* wgsl */ `
  fn radius_based_epsilon(sRad: f32) -> f32 {
    // return 0.0001;
    return clamp(sRad * 0.01, 0.0005, 0.01);
  } 
`);

// Color helpers
const colorHelpers = wgsl(/* wgsl */ `
  fn calculate_luma(c: vec3f) -> f32 {
    return dot(c, vec3f(0.2126, 0.7152, 0.0722));
  }

  fn rgb_to_ycbcr(col: vec3f) -> vec3f {
    let r = col.r; let g = col.g; let b = col.b;
    let y  = 0.299 * r + 0.587 * g + 0.114 * b;
    let cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
    let cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
    return vec3f(y, cb, cr);
  }

  fn ycbcr_to_rgb(ycbcr: vec3f) -> vec3f {
    let y = ycbcr.x; let cb = ycbcr.y; let cr = ycbcr.z;
    let r = y + 1.402 * cr;
    let g = y - 0.344136 * cb - 0.714136 * cr;
    let b = y + 1.772 * cb;
    return vec3f(r, g, b);
  }
`);

/**
 * Mip level for one ray hit, from the footprint that hit represents.
 *
 * A compute shader has no derivatives, so there is no quad to take a gradient across
 * and the level has to be reasoned about rather than measured. The reasoning: a ray
 * leaving a surfel does not sample a point, it samples that surfel's disc smeared out
 * over the distance it travelled — `sRad` at the origin, widening with `dist`. Feeding
 * that footprint to the chain is the difference between a 200 m hit reading one texel
 * of a full-rate texture and reading the average of the patch it actually covers.
 *
 * Why it matters beyond bandwidth: point-sampling at range makes successive frames
 * disagree about a surface that has not changed, MSME reads the disagreement as
 * variance, and its firefly clamp then removes light that was correct. Aliasing here
 * comes out the other end as *darkening*, which is why it never looked like aliasing.
 */
const diffuseLodForHit = wgslFn(/* wgsl */ `
  fn diffuseLodForHit(
    tex: texture_2d_array<f32>,
    surfelRadius: f32,
    dist: f32,
    lodScale: f32
  ) -> f32 {
    let maxLod = f32(max(1u, textureNumLevels(tex)) - 1u);
    let footprint = max(0.0, surfelRadius) + max(0.0, dist);
    return clamp(log2(max(1.0, footprint * max(1e-3, lodScale))), 0.0, maxLod);
  }
`);

export const sampleDiffuseArray = wgslFn(/* wgsl */ `
  fn sampleDiffuseArray(
    tex: texture_2d_array<f32>,
    texSampler: sampler,
    uvIn: vec2f,
    layerIn: i32,
    lod: f32
  ) -> vec3f {
    let uv = uvIn;

    let layerCount = textureNumLayers(tex);
    let layer = clamp(layerIn, 0, i32(layerCount) - 1);

    // Unsampled texel load
    // let dims = textureDimensions(tex, 0); // vec2<u32>
    // let w = max(1u, dims.x);
    // let h = max(1u, dims.y);
    // let x = i32(min(u32(uv.x * f32(w)), w - 1u));
    // let y = i32(min(u32(uv.y * f32(h)), h - 1u));
    // let c = textureLoad(tex, vec2i(x, y), layer, 0);

    let maxLod = f32(max(1u, textureNumLevels(tex)) - 1u);
    let c = textureSampleLevel(tex, texSampler, uv, layer, clamp(lod, 0.0, maxLod));
    return c.rgb;
  }
`);

const blueNoise4 = wgslFn(
  /* wgsl */ `
  fn blueNoise4(
    surfelIndex: u32,
    sampleIndex: u32,
    purpose: u32,
    tex: texture_2d<f32>,
  ) -> vec4f {
    // Traverse the 1024x1024 tile in a deterministic way
    let combined = sampleIndex + purpose * 0x10000u;
    let seq = (combined * 4099u + surfelIndex * 7919u) & BLUE_NOISE_MASK;

    let x = seq & (BLUE_NOISE_SIZE - 1u);
    let y = seq >> 10u; // 1024 = 2^10

    return textureLoad(tex, vec2u(x,y), 0);
  }
`,
  [consts],
);

// ---------------------------------------------------------
// 1. Basis + cosine/cone sampling
// ---------------------------------------------------------

const getTangentBasis = wgslFn(/* wgsl */ `
  fn getTangentBasis(normal: vec3f) -> mat3x3f {
    let nNormal = normalize(normal);
    let up = select(vec3f(1,0,0), vec3f(0,0,1), abs(nNormal.z) < 0.999);
    let t = normalize(cross(up, nNormal));
    let b = cross(nNormal, t);
    return mat3x3f(t, b, nNormal);
  }
`);

// NEW: local-space cosine hemisphere sampling (z-up), no basis creation here. // NEW
const sampleCosineHemisphereLocal = wgslFn(
  /* wgsl */ `
  fn sampleCosineHemisphereLocal(u: vec2f) -> vec3f {
    // TODO: Testing
    // let z = u.x;
    // let r = sqrt(max(0.0, 1.0 - z * z));
    // let theta = 2.0 * PI * u.y;
    // let x = r * cos(theta);
    // let y = r * sin(theta);
    // return vec3f(x, y, z);
    let r = sqrt(u.x);
    let theta = 2.0 * PI * u.y;
    let x = r * cos(theta);
    let y = r * sin(theta);
    let z = sqrt(max(0.0, 1.0 - u.x));
    return vec3f(x, y, z);
  }
`,
  [consts],
); // NEW

// ------------------------------------------------------------------
// [SLG] Hemi-oct-square mapping (bijection hemi <-> square)
// ------------------------------------------------------------------
export { hemiOctSquareEncode, hemiOctSquareDecode } from './wgslConsts';
import { hemiOctSquareEncode, hemiOctSquareDecode } from './wgslConsts';

const slgSafeU01 = wgslFn(/* wgsl */ `
  fn slgSafeU01(x: f32) -> f32 {
    // Avoid exactly 0 or 1 (blue-noise textures often contain exact endpoints)
    return clamp(x, 1e-6, 1.0 - 1e-6);
  }
`);

const hemiOctJacobian = wgslFn(/* wgsl */ `
  fn hemiOctJacobian(uv: vec2f) -> f32 {
    // Maps uv in [0,1]^2 -> hemisphere direction n = normalize(v)
    // Returns J = dΩ / d(uv area)  (steradians per unit uv^2)

    let q = uv * 2.0 - 1.0;
    let p = vec2f(q.x + q.y, q.x - q.y) * 0.5;

    let z = 1.0 - abs(p.x) - abs(p.y);
    let v = vec3f(p.x, p.y, z);

    let r2 = dot(v, v);

    // J = 2 / |v|^3
    // |v|^3 = r2 * sqrt(r2)
    // Use inverseSqrt for speed; clamp to avoid INF if something goes weird numerically.
    let invR = inverseSqrt(max(1e-12, r2));
    return 2.0 * invR * invR * invR;
  }
`);

// pdfSLG works purely from uv in hemi-oct-square, no basis recompute
const pdfSLG = wgslFn(
  /* wgsl */ `
  fn pdfSLG(
    surfelIndex: u32,
    uv: vec2f,
    slgMass: f32
  ) -> f32 {
    if (slgMass <= 1e-6) { return 0.0; }

    let cx = min(u32(floor(uv.x * f32(SLG_DIM))), SLG_DIM - 1u);
    let cy = min(u32(floor(uv.y * f32(SLG_DIM))), SLG_DIM - 1u);
    let idx = cy * SLG_DIM + cx;

    let baseIdx = surfelIndex * SLG_TOTAL_FLOATS;
    let w = max(0.0, guidingBuffer.value[baseIdx + idx]);

    // P(cell) = w / slgMass
    // PDF = P(cell) * (1 / A_uv_cell) * (1 / J(uv))
    //     = P(cell) * 64 / J(uv)
    let J = hemiOctJacobian(uv);

    return (w / slgMass) * f32(SLG_LOBE_COUNT) / J;
  }
`,
  [consts, hemiOctJacobian],
);

// [SLG] Lobe axis in the SURFEL-LOCAL frame (no wasted cells)
const slgGetLobeAxisLocal = wgslFn(
  /* wgsl */ `
  fn slgGetLobeAxisLocal(idx: u32) -> vec3f {
    let x = f32(idx % SLG_DIM);
    let y = f32(idx / SLG_DIM);
    let uv = vec2f((x + 0.5) / f32(SLG_DIM), (y + 0.5) / f32(SLG_DIM));
    return hemiOctSquareDecode(uv);
  }
`,
  [consts, hemiOctSquareDecode],
);

// SLG Zero lobes for a fresh surfel
const slgClearForNewSurfel = wgslFn(/* wgsl */ `
fn slgClearForNewSurfel(
  surfelIndex: u32
) -> void {
    let base = surfelIndex * SLG_TOTAL_FLOATS;
    for (var j: u32 = 0u; j < SLG_TOTAL_FLOATS; j = j + 1u) {
        guidingBuffer.value[base + j] = 0.0;
    }
}`);

// -----------------------------------------------------------------------------
// MSME (Multiscale Mean Estimator) helpers
// Based on Ray Tracing Gems, Chapter 25 (Barré‑Brisebois et al.), listing around
// pp. 26–27 (“MultiscaleMeanEstimator”).
// -----------------------------------------------------------------------------
const msmeHelpers = wgsl(/* wgsl */ `
struct MSMEData {
  mean: vec3f,
  shortMean: vec3f,
  vbbr: f32,
  variance: vec3f,
  inconsistency: f32,
};

fn runMSME(y: vec3f, dataIn: MSMEData, shortWindowBlend: f32) -> MSMEData {
  var data = dataIn;

  // 1) Firefly suppression (per-channel "high threshold")
  let dev = sqrt(max(vec3f(1e-5), data.variance));
  let highThreshold = vec3f(0.1) + data.shortMean + dev * 8.0;
  // let highThreshold = max(vec3f(1.0), data.shortMean * 2.0) + dev * 6.0;
  let yClamped = min(y, highThreshold);

  // 2) Short mean
  let delta = yClamped - data.shortMean;
  data.shortMean = mix(data.shortMean, yClamped, shortWindowBlend);
  let delta2 = yClamped - data.shortMean;

  // 3) Variance (slower blend than short mean)
  let varianceBlend = shortWindowBlend * 0.5;
  data.variance = mix(data.variance, delta * delta2, varianceBlend);
  data.variance = max(data.variance, vec3f(0.0));

  // 4) Inconsistency (short vs long, normalized by deviation)
  let devNew = sqrt(max(vec3f(1e-5), data.variance));
  let shortDiff = data.mean - data.shortMean;
  let relativeDiff =
      dot(vec3f(0.299, 0.587, 0.114), abs(shortDiff) / max(vec3f(1e-5), devNew));
  data.inconsistency = mix(data.inconsistency, relativeDiff, 0.08);

  // 5) VBBR (reduce blending in high variance situations)
  let term = (0.5 * data.shortMean) / max(vec3f(1e-5), devNew);
  let varianceBasedBlendReduction =
      clamp(dot(vec3f(0.299, 0.587, 0.114), term), 1.0/32.0, 1.0);

  // 6) Catch-up logic (react quickly when inconsistent)
  let catchUpFactor =
      smoothstep(0.0, 1.0, relativeDiff * max(0.02, data.inconsistency - 0.2));
  var catchUpBlend = clamp(catchUpFactor, 1.0/256.0, 1.0);

  // IMPORTANT: match original ordering — scale by previous vbbr, then update vbbr.
  catchUpBlend *= data.vbbr;
  data.vbbr = mix(data.vbbr, varianceBasedBlendReduction, 0.1);

  data.mean = mix(data.mean, yClamped, clamp(catchUpBlend, 0.0, 1.0));
  return data;
}`);

// ------------------------------------------------------------------
// [SLG] Sampling: choose lobe by weights, then sample a UNIFORM UV within that cell.
// ------------------------------------------------------------------
const slgSampleLobeIndex = wgslFn(
  /* wgsl */ `
  fn slgSampleLobeIndex(
    surfelIndex: u32,
    u: f32,
    totalIn: f32
  ) -> i32 {
    if (totalIn <= 1e-6) { return -1; }
    let baseIdx = surfelIndex * SLG_TOTAL_FLOATS;
    let rowSumOffset = baseIdx + SLG_LOBE_COUNT;

    // Safety: Clamp target
    var targ = clamp(u * totalIn, 0.0, totalIn);

    // 1) Row select
    var row: u32 = 0u;
    for (var r: u32 = 0u; r < SLG_DIM; r = r + 1u) {
      let w = max(0.0, guidingBuffer.value[rowSumOffset + r]);
      // STRICT FIX: Force selection if we are at the last element
      if (targ <= w || r == SLG_DIM - 1u) { row = r; break; }
      targ -= w;
    }

    // 2) Column select
    let rowStart = baseIdx + row * SLG_DIM;
    var col: u32 = 0u;
    for (var c: u32 = 0u; c < SLG_DIM; c = c + 1u) {
      let w = max(0.0, guidingBuffer.value[rowStart + c]);
      // STRICT FIX: Force selection if we are at the last element
      if (targ <= w || c == SLG_DIM - 1u) { col = c; break; }
      targ -= w;
    }

    return i32(row * SLG_DIM + col);
  }
`,
  [consts],
);

// [SLG] Update guiding weights by splatting luminance into the hemi-oct-square grid.
// takes `uv` directly (local-space-first)
const slgUpdateFromSample = wgslFn(
  /* wgsl */ `
  fn slgUpdateFromSample(
    surfelIndex: u32,
    uv: vec2f,
    lum: f32
  ) -> f32 {
    let gridPos = uv * f32(SLG_DIM) - 0.5;

    let basePos = floor(gridPos);
    let f = fract(gridPos);

    let baseIdx = surfelIndex * SLG_TOTAL_FLOATS;
    let rowSumOffset = baseIdx + SLG_LOBE_COUNT;

    let eta = LEARNING_RATE; // Learning Rate (Exponential Moving Average)
    var massDiff = 0.0;
    for (var dy: i32 = 0; dy <= 1; dy = dy + 1) {
      for (var dx: i32 = 0; dx <= 1; dx = dx + 1) {
        let cx = i32(basePos.x) + dx;
        let cy = i32(basePos.y) + dy;

        if (cx >= 0 && cx < i32(SLG_DIM) && cy >= 0 && cy < i32(SLG_DIM)) {
          let wx = select(1.0 - f.x, f.x, dx == 1);
          let wy = select(1.0 - f.y, f.y, dy == 1);
          let w  = wx * wy;
          let targ = lum * w; 
          
          let idx = u32(cy) * SLG_DIM + u32(cx);
          let oldVal = guidingBuffer.value[baseIdx + idx];
          
          // EMA Update: decays old value if targ is 0 (shadow)
          let newVal = mix(oldVal, targ, eta);
          
          guidingBuffer.value[baseIdx + idx] = newVal;
          
          // Maintain row sum cache
          let diff = newVal - oldVal;
          guidingBuffer.value[rowSumOffset + u32(cy)] += diff;
          massDiff += diff;
        }
      }
    }
    return massDiff;
  }
`,
  [consts],
);

// sampleGuidedDirection returns BOTH local direction + uv (local-space-first).
const sampleGuidedDirection = wgslFn(
  /* wgsl */ `
  fn sampleGuidedDirection(
    surfelIndex: u32,
    slgMass: f32,
    pGuide: f32,
    // u.xy for within-cell UV, u.z for lobe selection, u.w for decision
    u: vec4f,
  ) -> SLGSample {

    // Make sure we don't hit uv==0/1 exactly (z==0 boundary on hemi-oct-square)
    let ux = slgSafeU01(u.x);
    let uy = slgSafeU01(u.y);
    let uz = slgSafeU01(u.z);
    let uw = slgSafeU01(u.w);

    var out: SLGSample;

    // Guided: sample a UNIFORM UV within the chosen cell
    if (slgMass > 1e-6 && uw < pGuide) {
      let chosen = slgSampleLobeIndex(surfelIndex, uz, slgMass);
      if (chosen >= 0) {
        let col = u32(chosen) % SLG_DIM;
        let row = u32(chosen) / SLG_DIM;

        // Uniform in UV within selected cell
        let cellUV = vec2f(
          (f32(col) + ux) / f32(SLG_DIM),
          (f32(row) + uy) / f32(SLG_DIM)
        );

        out.uv = cellUV;
        out.dirLocal = hemiOctSquareDecode(cellUV);
        return out;
      }
    }

    // Fallback: cosine hemisphere in LOCAL space, then encode to uv for pdf/update
    let dirLocal = sampleCosineHemisphereLocal(vec2f(ux, uy));
    out.dirLocal = dirLocal;
    out.uv = hemiOctSquareEncode(dirLocal);
    return out;
  }
  
`,
  [
    consts,
    slgSampleLobeIndex,
    hemiOctSquareDecode,
    hemiOctSquareEncode,
    sampleCosineHemisphereLocal,
    slgSafeU01,
  ],
);

const slgGetTotalMass = wgslFn(
  /* wgsl */ `
    fn slgGetTotalMass(
      surfelIndex: u32
    ) -> f32 {
        let baseIdx = surfelIndex * SLG_TOTAL_FLOATS;
        let rowSumOffset = baseIdx + SLG_LOBE_COUNT;
        var total = 0.0;
        for (var r: u32 = 0u; r < SLG_DIM; r = r + 1u) {
            total += max(0.0, guidingBuffer.value[rowSumOffset + r]);
        }
        return total;
    }
    `,
  [consts],
);

export function createSurfelIntegratePass(
  blueNoiseTex: THREE.Texture,
  envTex: THREE.Texture,
): SurfelIntegratePass {
  let computeNode: THREE.ComputeNode | null = null;
  let bakedAtlas: THREE.Texture | null = null;
  /** @important The raster multiplies the atlas by this; a bounce ray must use the same gain. */
  let bakedAtlasIntensity: unknown = null;
  let lastSchedule = null;

  // Uniforms
  const U_FRAME = uniform(0);
  const U_CAM_POS = uniform(new THREE.Vector3());
  const U_READ_OFFSET = uniform(0);
  const U_WRITE_OFFSET = uniform(0);
  const U_GRID_ORIGIN = uniform(new THREE.Vector3());
  const U_BASE_SAMPLE_COUNT = uniform(4);
  const renderSize = new THREE.Vector2();
  const U_ALBEDO_BOOST = uniform(1.0);
  const U_GI_FROM_DIRECT = uniform(1.0);
  const U_GI_FROM_INDIRECT = uniform(1.0);
  // Per-run gate on the second BVH. Separate from the bundle's own `enabled` flag,
  // which only says whether the structure holds anything: a static bake has to trace
  // a *populated* dynamic structure and still ignore it, or the pinned cache ends up
  // with a mover's pose baked into it forever.
  const U_DYN_TRACE = uniform(0.0);
  /**
   * Texels-per-metre the footprint in `diffuseLodForHit` is measured against.
   *
   * One number for every material, which is a real approximation: each layer bakes its
   * own uv repeat flat, so the terrain's 16.7 tiles and a rock's 2 sit at very
   * different densities behind the same scale. The alternative is a per-material
   * density table, and that costs a second indirection on the hottest line in the
   * integrator to move a level selection by a fraction of a mip. `?giLod=` overrides it.
   */
  const U_DIFFUSE_LOD_SCALE = uniform(giKnobs.diffuseLodScale());
  const U_EXACT_REUSE = uniform(0);
  /**
   * Ablation switch. With it off, movers are still in the scene, still rastered, still
   * spawn surfels and still take pool slots — only the rays stop seeing them. That is
   * the only comparison that isolates what tracing movable geometry actually buys;
   * removing the mover instead changes the G-Buffer and the surfel population too, and
   * the resulting delta measures three things at once.
   */
  let dynamicTracing = true;

  const blueNoiseTexN = texture(blueNoiseTex);
  const envTexture = envTex ? texture(envTex).toInspector('Env') : null;
  const envSampler = envTex ? sampler(envTex) : null;

  const U_ENV_INTENSITY = uniform(1.0);
  const U_ENV_LOD = uniform(4.0);
  /** 1 = a bounce ray that stops on foliage also collects light through the leaf; 0 = ablation. */
  const U_LEAF_TRANSMIT = uniform(1.0);

  function run(
    renderer: THREE.WebGPURenderer,
    pool: SurfelPool,
    bvh: SceneBVHBundle,
    dynBvh: DynamicBVHBundle,
    grid: SurfelHashGrid,
    camera: THREE.PerspectiveCamera,
    scene: THREE.Object3D,
    dispatchArgs: THREE.IndirectStorageBufferAttribute,
    options: { includeDynamic?: boolean; schedule?: boolean } = {},
  ) {
    const surfelAttr = pool.getSurfelAttr();
    const momentsAttr = pool.getMomentsAttr();
    const poolMax = pool.getPoolMaxAtomic();
    const guidingAttr = pool.getGuidingAttr(); // SLG lobe weights
    const offsetsAndListAttr = grid.getOffsetsAndListAttr();
    const touchedAtomic = pool.getTouched();
    const surfelDepthAttr = pool.getSurfelDepthAttr();

    if (
      !surfelAttr ||
      !momentsAttr ||
      !poolMax ||
      !bvh.bvhNode ||
      !dynBvh?.bvhNode ||
      !offsetsAndListAttr ||
      !guidingAttr ||
      !surfelDepthAttr ||
      !touchedAtomic
    )
      return;

    const touchedBuffer = touchedAtomic.setName('touched');
    const schedule = options.schedule ?? null;
    if (schedule !== lastSchedule) { computeNode?.dispose(); computeNode = null; lastSchedule = schedule; }

    // Update Uniforms
    U_FRAME.value = renderer.info.frame;
    // Every frame, not once: the sun's angles are on a GUI slider and a torch can be
    // carried. Sixteen lights is a scene walk and 256 float writes — cheaper than the
    // first BVH node the next ray touches.
    syncSceneLights(scene);
    U_CAM_POS.value.copy(camera.position);
    snap_to_surfel_grid_origin(U_GRID_ORIGIN.value, camera.position);

    U_DYN_TRACE.value =
      dynamicTracing &&
      options.includeDynamic !== false &&
      dynBvh.enabled.value > 0
        ? 1
        : 0;

    // 1. UPDATE OFFSETS
    const { readOffset, writeOffset } = pool.getOffsets();
    U_READ_OFFSET.value = readOffset;
    U_WRITE_OFFSET.value = writeOffset;

    if (!computeNode) {
      const capacity = surfelAttr.count;

      const surfelBuffer = storage(surfelAttr, SurfelStruct, capacity)
        .setAccess('readOnly')
        .setName('surfels');
      const momentsBuffer = storage(momentsAttr, SurfelMoments, capacity * 2)
        .setAccess('readWrite')
        .setName('moments');

      const offsetsAndList = storage(
        offsetsAndListAttr,
        'int',
        offsetsAndListAttr.count,
      )
        .setAccess('readOnly')
        .setName('offsetsAndList');

      const guidingBuffer = storage(guidingAttr, 'float', guidingAttr.count)
        .setAccess('readWrite')
        .setName('guidingBuffer');
      const surfelDepthBuffer = storage(
        surfelDepthAttr,
        'vec4',
        surfelDepthAttr.count,
      )
        .setAccess('readWrite')
        .setName('surfelDepth');

      const gridHelpers = wgsl(
        /* wgsl */ `
        fn surfel_pos_to_grid_coord(pRel: vec3f) -> vec3i {
          return vec3i(floor(pRel / SURFEL_GRID_CELL_DIAMETER));
        }
      
        fn surfel_grid_coord_to_cascade_float(coord: vec3i) -> f32 {
          let fcoord = vec3f(coord) + vec3f(0.5);
          let max_c = max(abs(fcoord.x), max(abs(fcoord.y), abs(fcoord.z)));
          return log2(max_c / (f32(SURFEL_CS) * 0.5));
        }
      
        fn surfel_cascade_float_to_cascade(cf: f32) -> u32 {
          let v = ceil(max(0.0, cf));
          let clamped = clamp(v, 0.0, f32(SURFEL_CASCADES - 1));
          return u32(clamped);
        }

        fn surfel_grid_coord_within_cascade(coord: vec3i, cascade: u32) -> vec3i {
          let c = i32(cascade);
          
          return (coord >> vec3<u32>(cascade)) + SURFEL_CS / 2;
        }
      
        fn surfel_grid_coord_to_c4(coord: vec3i) -> vec4u {
          let cf = surfel_grid_coord_to_cascade_float(coord);
          let cascade = surfel_cascade_float_to_cascade(cf);
          let ucoord = surfel_grid_coord_within_cascade(coord, cascade);
      
          let clamped = clamp(
            ucoord,
            vec3i(0, 0, 0),
            vec3i(SURFEL_CS - 1, SURFEL_CS - 1, SURFEL_CS - 1)
          );
      
          return vec4u(u32(clamped.x), u32(clamped.y), u32(clamped.z), cascade);
        }
      
        fn surfel_grid_c4_to_hash(c4: vec4u) -> u32 {
          let cs = u32(SURFEL_CS);
          return c4.x
            + c4.y * cs
            + c4.z * cs * cs
            + c4.w * cs * cs * cs;
        }
      
        fn surfel_radius_for_pos(pRel: vec3f) -> f32 {
          let dist = length(pRel);
          let cascadeRadius = SURFEL_GRID_CELL_DIAMETER * f32(SURFEL_CS) * 0.5;
          return SURFEL_BASE_RADIUS * max(1.0, dist / cascadeRadius);
        }
      `,
        [consts],
      );

      const lookupSurfelGI = wgslFn(
        /* wgsl */ `
      fn lookupSurfelGI(
        pt_ws: vec3f,
        normal_ws: vec3f,
        cam_pos: vec3f,
        grid_origin: vec3f,
        readOffset: u32,
        occParams: vec4f,
        samplePhase: f32,
        exactVisibility: f32
      ) -> vec3f {
        // Position relative to camera, matches grid build
        let pRel = pt_ws - grid_origin;
    
        let gridCoord = surfel_pos_to_grid_coord(pRel);
        let c4       = surfel_grid_coord_to_c4(gridCoord);
        let hash     = surfel_grid_c4_to_hash(c4);
        let cellIdx  = i32(hash % TOTAL_CELLS);
    
        let start = offsetsAndList.value[cellIdx];
        let end   = offsetsAndList.value[cellIdx + 1];
        var count = max(end - start, 0);
    
        // Clamp to avoid insane work in hot cells
        let maxCount = min(count, MAX_SURFELS_PER_CELL_LOOKUP);
        if (maxCount <= 0) {
          return vec3f(0.0);
        }
    
        var totalColor = vec3f(0.0);
        var totalWeight = 0.0;
    
        var bestContrib = 0.0;
        var bestSid = 0;

        for (var i: i32 = 0; i < maxCount; i = i + 1) {
          // A cell contains several surfaces, especially with one probe per bake
          // texel. Its insertion order is not a spatially representative ordering:
          // taking only the prefix can miss the hit's entire wall near a corner.
          // Keep the same fetch budget, stratify over the full list, and vary the
          // phase independently of the bounce direction to avoid fixed omissions.
          // Noise textures can contain the endpoint 1. Small cells still visit
          // every entry exactly once; large cells keep the phase below that endpoint.
          let sampleIndex = select(
            min(count - 1, i32((f32(i) + min(samplePhase, 0.9999)) * f32(count) / f32(maxCount))),
            i, count == maxCount);
          let sid = offsetsAndList.value[OFFSETS_AND_LIST_START + start + sampleIndex];
          
          if (sid < 0) {
            continue;
          }
    
          let surfel = surfels.value[u32(sid)];
          let sPos   = surfel.posb.xyz;
          let sNor   = normalize(surfel.normal);
    
          // Surfel radius and falloff
          let pRelSurfel = sPos - cam_pos;
          let sRad = surfel_radius_for_pos(pRelSurfel) * SURFEL_RADIUS_OVERSCALE;
    
          // IMPORTANT: match the origin offset used for depth learning
          let eps = spawn_epsilon(sPos, sRad);
          let sPosOff = sPos + sNor * eps;

          let dV    = pt_ws - sPosOff;
          let dist  = length(dV);
          // if (dist <= eps) { continue; } // TODO
          let dirWS = dV / dist;

          let align     = abs(dot(dV, sNor));
          let mahal     = dist * (1.0 + align * SURFEL_NORMAL_DIRECTION_SQUISH);
    
          let directional = max(0.0, dot(sNor, normal_ws));
          var weight = smoothstep(sRad, 0.0, mahal) * directional;
    
          if (weight <= 0.0) {
            continue;
          }


          // Every admitted donor is tested. The weights are normalised below, so one
          // untested candidate is not a small error - it is the whole answer.
          if (weight > ${giKnobs.donorVisibilityGate().toFixed(4)}) {
            let vis = surfel_radial_occlusion_rw(
              u32(sid),
              dirWS,
              sNor,
              dist,
              occParams
            );
            weight *= vis;
            if (weight <= 0.0) { continue; }
          }

          if (exactVisibility > 0.5) {
            // The radial-depth estimate is a set of moments; between two surfaces that
            // share a cell it is a guess, and the weights are normalised afterwards, so
            // one wrong donor is not a small error. Trace the segment instead.
            var link: Ray;
            let lift = max(1e-4, dist * 0.01);
            link.origin = pt_ws + normal_ws * lift;
            let toDonor = (sPos + sNor * lift) - link.origin;
            let span = length(toDonor);
            if (span > 1e-6) {
              link.direction = toDonor / span;
              if (bvhAnyHitWithin(link, span * 0.99)) { continue; }
            }
          }

          let readSid = u32(sid) + readOffset;
          let sIrr = moments.value[readSid].irradiance.xyz;

          let contrib = sIrr * weight;
          let lenContrib = length(contrib);
          if (lenContrib > bestContrib) {
            bestContrib = lenContrib;
            bestSid = sid;
          }

          totalWeight = totalWeight + weight;
          totalColor  = totalColor + contrib;
        }

        // Indirect range: 1 to 50
        if (bestSid >= 0 && bestContrib > 0.01) {
          let impMax = f32(${SURFEL_IMPORTANCE_INDIRECT_MAX});
          let importance = clamp(i32(bestContrib * impMax), 0, 50);
          atomicMax(&touched.value[bestSid], importance);
        }

        if (totalWeight < 1e-5) { return vec3f(0.0); }
        return totalColor / totalWeight;
      }
      `,
        [consts, gridHelpers, surfelRadialDepthOcclusionRW],
      );

      // --- WGSL Integrator ---
      const integrator = wgslFn(
        /* wgsl */ `
      fn compute(
          diffuseTex: texture_2d_array<f32>,
          diffuseTexSampler: sampler,
          envTexture: texture_2d<f32>,
          envSampler: sampler,
          envIntensity: f32,
          envLod: f32,
          leafTransmit: f32,
          frame: u32,
          lightsTex: texture_2d<f32>,
          lightCount: u32,
          lightSamples: u32,
          emissiveBase: i32,
          emissiveScale: f32,
          camPos: vec3f,
          gridOrigin: vec3f,
          blueNoiseTex: texture_2d<f32>,
          readOffset: u32, writeOffset: u32,
          occParams: vec4f,
          baseSampleCount: u32,
          albedoBoost: f32,
          giFromDirect: f32,
          giFromIndirect: f32,
          dynTrace: f32,
          dynBounds: vec4f,
          diffuseLodScale: f32,
          exactReuse: f32,
          medium: vec4f,
${bakedAtlas ? `          bakeUvTex: texture_2d<f32>,
          atlasTex: texture_2d<f32>,
          atlasSampler: sampler,
          atlasIntensity: f32,
` : ''}        ) -> void {
          let index = instanceIndex;
          // let total = atomicLoad(&poolMax[0]);
          // if (i32(index) >= total) { return; }

          let s = surfels.value[index];
          if (s.age >= ${SURFEL_TTL}) { return; }

          // LOCAL CHANGE vs upstream: a negative age marks a surfel pinned by the
          // bake (see gi/immortalise.ts). Its radiance already converged, so skip
          // the ray tracing entirely -- that skip is what makes a timed bake pay
          // off instead of just pre-warming a still-fully-live integrator.
          //
          // The moments buffer is double-buffered and swapped every frame, so the
          // converged state must still be carried read -> write. Skipping the write
          // as well would show a stale buffer on alternate frames.
          if (s.age < 0) {
            let pinnedRead  = index + readOffset;
            let pinnedWrite = index + writeOffset;
            moments.value[pinnedWrite] = moments.value[pinnedRead];
            return;
          }

          // Compute basis once per surfel (used for ray directions + final meanWorld).
          ${schedule ? `if (moments.value[index + writeOffset].hit.w < 1.0) {
            moments.value[index + writeOffset] = moments.value[index + readOffset];
            return;
          }` : ''}
          let basis = getTangentBasis(s.normal);
          let nW = basis[2];

          // --- READ PREVIOUS STATE ---
          let readIdx  = index + readOffset;
          let mPrev    = moments.value[readIdx];

          // Decode previous MSME state
          var msmeState: MSMEData;
          msmeState.mean          = mPrev.irradiance.xyz;
          msmeState.shortMean     = mPrev.msmeData0.xyz;
          msmeState.vbbr          = mPrev.msmeData0.w;
          msmeState.variance      = mPrev.msmeData1.xyz;
          msmeState.inconsistency = mPrev.msmeData1.w;
          
          let prevCount = mPrev.irradiance.w;

          // [MSME FIX] sanitize state to avoid NaNs / stuck blending (important when buffers contain garbage)
          msmeState.vbbr = clamp(msmeState.vbbr, 1.0/32.0, 1.0);
          msmeState.inconsistency = clamp(msmeState.inconsistency, 0.0, 10.0);
          msmeState.variance = max(msmeState.variance, vec3f(0.0));

          let birthFrame = u32(s.posb.w);
          let sinceBirth = frame - birthFrame;
          
          var slgMass = slgGetTotalMass(index);

          let hasGrid = slgMass > 1e-5;
          var pGuide = select(0.0, 0.9, hasGrid);
          let guideRamp = clamp(f32(sinceBirth) / 16.0, 0.0, 1.0); 
          pGuide = min(pGuide * guideRamp, 0.9);
          
          var diffuseGI = vec3f(0.0);
          var validSamples = 0.0;

          // Adaptive based on MSME inconsistency
          let baseCount = max(1u, baseSampleCount);
          let boostCount = select(0u, 12u, msmeState.inconsistency > 0.3);
          var sampleCount = baseCount + boostCount;

          // A rigid receiver can retain its surface anchor while a teleport
          // invalidates its lighting history. Warm that history just like a newborn.
          let warmup = (sinceBirth <= 4u) || (prevCount < 32.0);
          // let warmup = (sinceBirth <= 2u) || (prevCount < 32.0);  // <-- tune threshold
          if (warmup) { sampleCount = 32u; }
          ${schedule ? 'sampleCount = u32(moments.value[index + writeOffset].hit.w);' : ''}

          var hitPos0 = s.posb.xyz;
          var debugFlag = 0.0;

          // NOTE: For debug - maybe use for real loop?
          // for (var i = 0u; i < 16u; i = i + 1u) {
          //     let pRelS = s.posb.xyz - camPos;
          //     let sRad = surfel_radius_for_pos(pRelS);
          //     let eps = radius_based_epsilon(sRad); // Offset from position
          //     let bx  = i % 4u;                         // 0..3
          //     let by  = i / 4u;                        // 0..3
          //     // Jitter within the bin - different position each frame
          //     let noise = blueNoise4(index, i + frame * 16u, 1u, blueNoiseTex);
          //     let jitter = noise.xy;  // 0 to 1
              
          //     let uvDepth = (vec2f(f32(bx) + jitter.x, f32(by) + jitter.y)) / f32(SURFEL_DEPTH_TEXELS);
          //     // convert uv -> local dir (must match your encode)
          //     let dirLocalDepth = hemiOctSquareDecode(uvDepth);
          //     let rayDirDepth   = basis * dirLocalDepth;

          //     // Offset along normalized normal (from basis) for consistent epsilon.
          //     let rayOrigin = s.posb.xyz + nW * eps; // Old: 0.002

          //     var ray: Ray; ray.origin = rayOrigin; ray.direction = rayDirDepth;
          //     let hit = bvhIntersectFirstHit(ray);

          //     // ----------------------------------------------------------
          //     // [RADIAL DEPTH] Learn depth along this direction (uv)
          //     // Similar to the example: miss writes "max depth", hit writes clamped hit depth.
          //     // ----------------------------------------------------------
          //     let maxDepth = sRad * 2.0;
          //     let dHit = clamp(hit.dist, 0.0, maxDepth);
          //     let dLearn = select(maxDepth, dHit, hit.didHit);
          //     update_surfel_depth2(surfelDepth, index, uvDepth, dLearn, dirLocalDepth);
          // }

          let DEPTH_PROBE_STRIDE = 4u; // 4 => 25% of surfels per frame do 1 probe
          let doProbe = (((index ^ frame) & (DEPTH_PROBE_STRIDE - 1u)) == 0u);

          // Common surfel data
          var ray: Ray;
          let pRelS = s.posb.xyz - camPos;
          let sRad = surfel_radius_for_pos(pRelS);
          let eps = spawn_epsilon(s.posb.xyz, sRad);
          ray.origin = s.posb.xyz + nW * eps;

          if (doProbe) {
            // pick a bin deterministically (covers all bins over time)

            let binCount = SURFEL_DEPTH_TEXELS * SURFEL_DEPTH_TEXELS;
            let bin = (frame + index * 13u) % u32(binCount);

            let bx = bin % SURFEL_DEPTH_TEXELS;
            let by = bin / SURFEL_DEPTH_TEXELS;

            // jitter within the bin
            let n4 = blueNoise4(index, frame, 0u, blueNoiseTex);
            let uvDepth = vec2f(f32(bx) + n4.x, f32(by) + n4.y) / f32(SURFEL_DEPTH_TEXELS);

            let dirLocalDepth = hemiOctSquareDecode(uvDepth);
            let rayDirDepth   = basis * dirLocalDepth;

            ray.direction = rayDirDepth;

            let hitD = traceScene(ray, dynTrace, dynBounds, 0u);

            let maxDepth = sRad * 2.0;
            let dHit = clamp(hitD.dist, 0.0, maxDepth);
            let dLearn = select(maxDepth, dHit, hitD.didHit);

            update_surfel_depth2(index, uvDepth, dLearn, dirLocalDepth);
          }

          for (var i = 0u; i < sampleCount; i = i + 1u) {
            let u4 = blueNoise4(index, frame * BLUE_NOISE_STRIDE + i, 1u, blueNoiseTex);
            // u4.xy = spatial
            // u4.z  = lobe selection
            // u4.w  = decision

            // Sample in LOCAL space; get both local dir + uv in one call.
            let slgS = sampleGuidedDirection(index, slgMass, pGuide, u4);
            let dirLocal = slgS.dirLocal;
            let uv = slgS.uv;

            // Cosine/pdf use local z directly
            let cosTerm = max(0.0, dirLocal.z);
            let pdfCos  = cosTerm / PI;

            // pdfSLG now uses uv directly
            var pdfGuide = 0.0;
            if (pGuide > 0.0) {
              pdfGuide = pdfSLG(index, uv, slgMass);
            }

            let mixPdf = (1.0 - pGuide) * pdfCos + pGuide * pdfGuide;

            if (mixPdf > 1e-6 && cosTerm > 0.0) {
              debugFlag = 1.0;
              // Convert local dir -> world dir once using precomputed basis
              let rayDir = basis * dirLocal;

              ray.direction = rayDir;
              // LOCAL CHANGE vs upstream: one BVH became two. traceScene keeps the
              // nearer of the static and dynamic hits and resolves the interpolated
              // uv/matId out of whichever structure won, so everything below this line
              // is upstream's shading path with no knowledge of the split.
              var hit = traceScene(ray, dynTrace, dynBounds, 0u);
              // Foliage is see-through for a bounce ray with probability (1 - opacity):
              // the ray that would have stopped on a frond continues to whatever is
              // behind it, so the sky reaches the ground under a crown and the crown
              // itself bounces at its own opacity. Two leaves deep is enough.
              {
                var passRay = ray;
                var passOffset = 0.0;
                let passU = blueNoise4(index, frame * BLUE_NOISE_STRIDE + i, 2u, blueNoiseTex).y;
                for (var leafHop: u32 = 0u; leafHop < 2u; leafHop = leafHop + 1u) {
                  if (!hit.didHit) { break; }
                  let passLayer = clamp(i32(round(hit.attrib.z)), 0, i32(textureNumLayers(diffuseTex)) - 1);
                  let passOpacity = textureSampleLevel(diffuseTex, diffuseTexSampler, hit.attrib.xy, passLayer, 0.0).a;
                  if (passOpacity > 0.995 || passU < passOpacity) { break; }
                  let advance = hit.dist - passOffset + eps;
                  passRay.origin = passRay.origin + passRay.direction * advance;
                  passOffset = passOffset + advance;
                  var next = traceScene(passRay, dynTrace, dynBounds, 0u);
                  next.dist = next.dist + passOffset;
                  hit = next;
                }
              }
              var bounceLi = vec3f(0.0);
              
              // ----------------------------------------------------------
              // [RADIAL DEPTH] Learn depth along this direction (uv)
              // Similar to the example: miss writes "max depth", hit writes clamped hit depth.
              // ----------------------------------------------------------
              let maxDepth = sRad * 2.0;
              // let maxDepth = 1e2;
              let dHit = clamp(hit.dist, 0.0, maxDepth);
              let dLearn = select(maxDepth, dHit, hit.didHit);
              update_surfel_depth2(index, uv, dLearn, dirLocal);
              
              if (hit.didHit) {
                let hitPoint  = ray.origin + ray.direction * hit.dist;
                let hitNormal = normalize(hit.normal);
                if (i == 0u) { hitPos0 = hitPoint; }
                let uvMat = hit.attrib;
                // matId is constant per triangle because we made geometry non-indexed + filled per-tri.
                let matId = i32(round(uvMat.z));
                let hitUv = uvMat.xy;
                let hitLod = diffuseLodForHit(diffuseTex, sRad, hit.dist, diffuseLodScale);
                var hitAlbedo = sampleDiffuseArray(diffuseTex, diffuseTexSampler, hitUv, matId, hitLod);
                let y = max(1e-4, dot(hitAlbedo, vec3f(0.2126, 0.7152, 0.0722)));
                let y2 = 1.0 - pow(1.0 - y, max(0.0, albedoBoost));
                let s = y2 / y;
                hitAlbedo = clamp(hitAlbedo * s, vec3f(0.0), vec3f(1.0));

                // Every analytic light in the scene, not just the sun, each with its own
                // shadow ray. A mover that cannot occlude one of those rays casts no
                // indirect shadow at all, which was the visible half of an earlier
                // defect: the sphere sat 30cm off a wall and the wall did not know it
                // was there. The whole of this now lives in hitShading.ts so the
                // reflection pass shades its hits through the same code rather than
                // growing a second, sun-only opinion of what a surface is worth.
                // Purpose 2, not a channel of u4: u4.zw already steer lobe selection,
                // and reusing them would correlate "which direction this ray went" with
                // "which light it asked about" — a bias that shows up as one lamp being
                // systematically brighter on surfaces facing a particular way.
                let lightU = blueNoise4(index, frame * BLUE_NOISE_STRIDE + i, 2u, blueNoiseTex).x;
                // Foliage is a thin sheet with two lit faces. hitNormal is the
                // geometric normal, whichever face the ray struck; a ray that comes at
                // a leaf from behind (a surfel under the crown looking up) sees the
                // face turned toward it lit by whatever is on its own side, plus what
                // comes *through* from the far side: T · E_far · cos / π, the same
                // Lambert transmission the raster's leaf BSDF uses, with the shadow
                // ray leaving from the far face. Opaque hits keep the plain path.
                let hitOpacity = textureSampleLevel(diffuseTex, diffuseTexSampler, hitUv, matId, 0.0).a;
                if (leafTransmit > 0.5 && hitOpacity < 0.995) {
                  let facing = select(-hitNormal, hitNormal, dot(hitNormal, ray.direction) < 0.0);
                  // Transmitted colour: the leaf's hue at the photometric transmittance
                  // the material declared (1 - opacity).
                  let hitLum = max(1e-3, dot(hitAlbedo, vec3f(0.2126, 0.7152, 0.0722)));
                  let through = clamp(hitAlbedo * ((1.0 - hitOpacity) / hitLum), vec3f(0.0), vec3f(1.0));
                  bounceLi += giShadeHit(
                    lightsTex, hitPoint, facing, hitAlbedo, eps,
                    dynTrace, dynBounds,
                    lightCount, lightSamples, lightU, medium,
                    diffuseTex, diffuseTexSampler
                  ) * giFromDirect;
                  bounceLi += giShadeHit(
                    lightsTex, hitPoint, -facing, through, eps,
                    dynTrace, dynBounds,
                    lightCount, lightSamples, lightU, medium,
                    diffuseTex, diffuseTexSampler
                  ) * giFromDirect;
                } else {
                  bounceLi += giShadeHit(
                    lightsTex, hitPoint, hitNormal, hitAlbedo, eps,
                    dynTrace, dynBounds,
                    lightCount, lightSamples, lightU, medium,
                    diffuseTex, diffuseTexSampler
                  ) * giFromDirect;
                }

                // Emission is added raw. It is not multiplied by the hit's albedo (a
                // light does not reflect itself) and not scaled by giFromDirect (that
                // knob asks for less *bouncing*, and turning it down must not put out
                // the lamp).
                bounceLi += giHitEmissive(
                  diffuseTex, diffuseTexSampler, hitUv, matId, hitLod,
                  emissiveBase, emissiveScale
                );

                // @important A secondary bounce takes its light from the baked atlas when the hit
                // is on static geometry the unwrap gave a chart, and from the surfel
                // cache otherwise: one texture fetch against a hash-grid walk of up to
                // 32 entries.
                //
                // The two sources are NOT measured equal, and nothing here should be
                // read as claiming they are. On the beach at cam=leaves, atlasHits on
                // against off moved 4942 pixels past 10/255 (max 74) where two
                // identical runs of the same pose moved 1484 (max 29). The leading
                // suspect is the atlas itself rather than this branch: the saved bake
                // predates both the van and the switch to sunIntensity 'environment',
                // and only a hand deletion re-bakes it. Re-measure after a forced
                // re-bake (?bakeCache=0) before blaming the read.
                //
                // The fallback is not a rare corner. Palm and shrub leaves, the shrub
                // stems and the island's underside all set userData.lightmap = false
                // and reach the BVH with bakeUv at the -1 sentinel, as do the cluster
                // proxy triangles, so on the beach most of what a ray can hit still
                // walks the cache.
                var gi = vec3f(0.0);
${bakedAtlas ? `                var fromAtlas = false;
                if (!hit.isDynamic) {
                  // uv1 lives in a texture rather than a fifteenth storage buffer:
                  // vertex i sits at (i % width, i / width), and -1 in either channel
                  // is the sentinel for a vertex the unwrap refused.
                  let w = i32(textureDimensions(bakeUvTex).x);
                  let ia = i32(hit.indices.x); let ib = i32(hit.indices.y); let ic = i32(hit.indices.z);
                  let a = textureLoad(bakeUvTex, vec2i(ia % w, ia / w), 0).xy;
                  let b = textureLoad(bakeUvTex, vec2i(ib % w, ib / w), 0).xy;
                  let c = textureLoad(bakeUvTex, vec2i(ic % w, ic / w), 0).xy;
                  fromAtlas = all(a >= vec2f(0.0)) && all(b >= vec2f(0.0)) && all(c >= vec2f(0.0));
                  if (fromAtlas) {
                    let bc = hit.barycoord;
                    let atlasUv = a * bc.x + b * bc.y + c * bc.z;
                    // @important The same gain the raster applies (applyLightmap): without it the
                    // knob dims what the eye sees and leaves the bounce carrying the
                    // undimmed value, and one physical quantity becomes two.
                    gi = textureSampleLevel(atlasTex, atlasSampler, atlasUv, 0.0).rgb * atlasIntensity;
                  }
                }
                if (!fromAtlas) { gi = lookupSurfelGI(hitPoint, hitNormal, camPos, gridOrigin, readOffset, occParams, lightU, exactReuse); }
` : `                gi = lookupSurfelGI(hitPoint, hitNormal, camPos, gridOrigin, readOffset, occParams, lightU, exactReuse);
`}
                bounceLi += gi * hitAlbedo * giFromIndirect;
              } else {
                // Basic Sky
                // let t = 0.5 * (rayDir.y + 1.0);
                // bounceLi = mix(vec3f(0.05), vec3f(0.2), vec3f(t));
                bounceLi = sampleEnvEquirect(rayDir, envTexture, envSampler, envLod) * envIntensity;
              }

              // Use local cosTerm already computed
              diffuseGI += bounceLi * (cosTerm / PI) / mixPdf;
              let lum = calculate_luma(bounceLi) * cosTerm;

              // Update SLG from uv directly.
              let slgMassDiff = slgUpdateFromSample(index, uv, lum);
              slgMass += slgMassDiff;
              validSamples += 1.0;
            }
          }

          slgMass = slgGetTotalMass(index);

          let newAvg = diffuseGI / max(1.0, validSamples);

          // --- RUN MSME ---
          if (validSamples > 0.0) {
            // Adapt short-window blend to how many samples contributed this frame          
            let tau = 12.5; // ~1/0.08, matches the paper-ish magnitude
            let n = validSamples;
            let shortWindowBlend = clamp(1.0 - exp(-n / tau), 0.01, 0.10); // TODO 0.10 or 0.12?

            // No temporal averaging
            // ---------------------
            // msmeState.mean = newAvg;
            // msmeState.shortMean = newAvg;
            // msmeState.variance = vec3f(1.0);
            // msmeState.vbbr = 1.0;
            // msmeState.inconsistency = 1.0;

            // EMA
            // msmeState.mean = mix(msmeState.mean, newAvg, 0.01);
            // msmeState.shortMean = mix(msmeState.mean, newAvg, 0.01);
            // msmeState.variance = vec3f(1.0);
            // msmeState.vbbr = 1.0;
            // msmeState.inconsistency = 1.0;

            if (prevCount < 32.0) {
              let blend = 1.0 / (1.0 + prevCount);
              msmeState.mean      = mix(msmeState.mean,      newAvg, blend);
              msmeState.shortMean = mix(msmeState.shortMean, newAvg, blend);
              msmeState.variance  = mix(msmeState.variance, vec3f(1.0), blend);

              // [MSME FIX] keep brand-new surfels responsive
              msmeState.vbbr = max(msmeState.vbbr, 1.0);
              msmeState.inconsistency = max(msmeState.inconsistency, 1.0);
            } else {
              msmeState = runMSME(newAvg, msmeState, shortWindowBlend);
            }
          }

          var totalCount = prevCount;
          if (validSamples > 0.0) {
            totalCount = min(prevCount + 1.0, MAX_TEMPORAL_M);
          }
          let alpha = validSamples / max(1.0, totalCount);

          let baseIdx = index * SLG_TOTAL_FLOATS;
          var maxW = 0.0;
          var meanLocal = vec3f(0.0);
          for (var li: u32 = 0u; li < SLG_LOBE_COUNT; li = li + 1u) {
            let w = max(0.0, guidingBuffer.value[baseIdx + li]);
            if (w <= 0.0) { continue; }
            if (w > maxW) { maxW = w; }
            let axisL = slgGetLobeAxisLocal(li);
            meanLocal += axisL * w;
          }
          let meanLen = length(meanLocal);
          let meanLocalN = select(vec3f(0.0, 0.0, 1.0), meanLocal / meanLen, meanLen > 1e-6);

          // Reuse precomputed basis
          let meanWorld = normalize(basis * meanLocalN);

          // --- WRITE NEW STATE ---
          let outIdx = index + writeOffset;
              
          moments.value[outIdx].irradiance   = vec4f(msmeState.mean, totalCount);
          moments.value[outIdx].msmeData0    = vec4f(msmeState.shortMean, msmeState.vbbr);
          moments.value[outIdx].msmeData1    = vec4f(msmeState.variance, msmeState.inconsistency);
          // Baked mode packs floor(LOD)*16 + importance into z; xy=UV, w=frame.
          // Authoring retains its original world-hit diagnostic format.
          moments.value[outIdx].hit          = vec4f(hitPos0, debugFlag);
          moments.value[outIdx].guiding      = vec4f(meanWorld, slgMass);
        }
      `,
        [
          constants,
          consts,
          rayStruct,
          bvhIntersectFirstHit,
          getVertexAttribute,
          dynBvhIntersectFirstHit,
          getDynVertexAttribute,
          sceneHitStruct,
          dynBoundsHit,
          traceScene,
          traceSceneOccluded,

          // The shared hit-shading seam. Everything that fires a ray at this scene and
          // asks what came back goes through these four; see hitShading.ts.
          giLightConsts,
          giOccluded,
          giSampleLight,
          giShadeHit,
          giHitEmissive,

          blueNoise4,

          getTangentBasis,

          hemiOctSquareEncode,
          hemiOctSquareDecode,
          hemiOctJacobian,
          slgGetLobeAxisLocal,
          slgClearForNewSurfel,
          slgGetTotalMass,
          slgUpdateFromSample,
          slgSampleLobeIndex,

          sampleGuidedDirection,
          pdfSLG,

          // cache lookup + color
          lookupSurfelGI,
          bvhAnyHitWithin,
          gridHelpers,
          colorHelpers,
          msmeHelpers,
          update_surfel_depth2,
          radiusBasedEpsilon,
          spawnEpsilon,
          surfelRadialDepthOcclusionRW,
          diffuseLodForHit,
          sampleDiffuseArray,
          envEquirectUV,
          sampleEnvEquirectClamped,
          bvh.bvhNode,
          bvh.positionNode,
          bvh.indexNode,
          bvh.colorNode,
          dynBvh.bvhNode,
          dynBvh.positionNode,
          dynBvh.indexNode,
          dynBvh.colorNode,
          surfelBuffer,
          momentsBuffer,
          offsetsAndList,
          touchedBuffer,
          guidingBuffer,
          surfelDepthBuffer,
        ],
      );

      const computeCall = integrator({
        diffuseTex: texture(bvh.diffuseArrayTex),
        diffuseTexSampler: sampler(bvh.diffuseArrayTex),

        envTexture,
        envSampler,
        envIntensity: U_ENV_INTENSITY,
        envLod: U_ENV_LOD,
        leafTransmit: U_LEAF_TRANSMIT,

        frame: U_FRAME,
        lightsTex: giLightsTexture,
        lightCount: U_GI_LIGHT_COUNT,
        lightSamples: U_GI_LIGHT_SAMPLES,
        emissiveBase: U_GI_EMISSIVE_BASE,
        emissiveScale: U_GI_EMISSIVE_SCALE,
        exactReuse: U_EXACT_REUSE,
        medium: U_GI_MEDIUM,
        // Only bound when the atlas exists; without it the kernel has no such
        // parameters and every hit walks the surfel cache.
        ...(bakedAtlas ? {
          bakeUvTex: texture(bvh.lightmapUvTexture),
          atlasTex: texture(bakedAtlas),
          atlasSampler: sampler(bakedAtlas),
          atlasIntensity: bakedAtlasIntensity ?? uniform(1),
        } : {}),
        camPos: U_CAM_POS,
        gridOrigin: U_GRID_ORIGIN,
        blueNoiseTex: blueNoiseTexN,
        readOffset: U_READ_OFFSET,
        writeOffset: U_WRITE_OFFSET,
        occParams: U_OCCLUSION_PARAMS,
        baseSampleCount: U_BASE_SAMPLE_COUNT,
        albedoBoost: U_ALBEDO_BOOST,
        giFromDirect: U_GI_FROM_DIRECT,
        giFromIndirect: U_GI_FROM_INDIRECT,
        dynTrace: U_DYN_TRACE,
        dynBounds: dynBvh.influence,
        diffuseLodScale: U_DIFFUSE_LOD_SCALE,
      });

      computeNode = computeCall
        .compute(capacity)
        .setName('Surfel Integrate Pass');
    }

    renderer.compute(computeNode, dispatchArgs);
  }

  return {
    run,
    invalidate: () => { computeNode?.dispose(); computeNode = null; },
    setBakedAtlas: (value: THREE.Texture | null, intensity?: unknown) => {
      bakedAtlasIntensity = intensity ?? bakedAtlasIntensity;
      if (value === bakedAtlas) return;
      bakedAtlas = value;
      computeNode?.dispose();
      computeNode = null;
    },
    setExactReuse: (on: boolean) => { U_EXACT_REUSE.value = on ? 1 : 0; },
    setBaseSampleCount: (count: number) => {
      U_BASE_SAMPLE_COUNT.value = Math.max(1, Math.floor(count));
    },
    setAlbedoBoost: (boost: number) => {
      U_ALBEDO_BOOST.value = Math.max(0, boost);
    },
    setGiScales: (fromDirect: number, fromIndirect: number) => {
      U_GI_FROM_DIRECT.value = Math.max(0, fromDirect);
      U_GI_FROM_INDIRECT.value = Math.max(0, fromIndirect);
    },
    setEnvControls: (intensity: number, lod: number) => {
      U_ENV_INTENSITY.value = Math.max(0, intensity);
      U_ENV_LOD.value = Math.max(0, lod);
    },
    setLeafTransmit: (enabled: boolean) => {
      U_LEAF_TRANSMIT.value = enabled ? 1 : 0;
    },
    setDynamicTracing: (enabled: boolean) => {
      dynamicTracing = enabled;
    },
  };
}
