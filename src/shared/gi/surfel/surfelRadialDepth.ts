// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// surfelRadialDepth.ts (MSM 4-moment version)
import * as THREE from 'three/webgpu';
import { uniform, wgslFn } from 'three/tsl';
import {
  consts,
  hemiOctSquareDecode,
  hemiOctSquareEncode,
} from './wgslConsts';

export const U_OCCLUSION_PARAMS = uniform(
  new THREE.Vector4(1.2, 0.2, 0.25, 0.15),
);

export type OcclusionSettings = {
  shadowStrength: number;
  bleedReduction: number;
  grazingBiasScale: number;
  varianceBleedScale: number;
};

export const DEFAULT_OCCLUSION_SETTINGS: OcclusionSettings = {
  shadowStrength: 1.2,
  bleedReduction: 0.2,
  grazingBiasScale: 0.25,
  varianceBleedScale: 0.15,
};

const occlusionParams: OcclusionSettings = { ...DEFAULT_OCCLUSION_SETTINGS };

function syncOcclusionUniform() {
  U_OCCLUSION_PARAMS.value.set(
    occlusionParams.shadowStrength,
    occlusionParams.bleedReduction,
    occlusionParams.grazingBiasScale,
    occlusionParams.varianceBleedScale,
  );
}

export function applyOcclusionSettings(settings: Partial<OcclusionSettings>) {
  if (settings.shadowStrength !== undefined)
    occlusionParams.shadowStrength = settings.shadowStrength;
  if (settings.bleedReduction !== undefined)
    occlusionParams.bleedReduction = settings.bleedReduction;
  if (settings.grazingBiasScale !== undefined)
    occlusionParams.grazingBiasScale = settings.grazingBiasScale;
  if (settings.varianceBleedScale !== undefined)
    occlusionParams.varianceBleedScale = settings.varianceBleedScale;
  syncOcclusionUniform();
}

export const configureRadialDepthGUI = (gui) => {
  const occlusionFolder = gui.addFolder('Occlusion');
  const update = () => syncOcclusionUniform();

  const shadowController = occlusionFolder
    .add(occlusionParams, 'shadowStrength', 0, 10, 0.1)
    .name('Strength')
    .onChange(update);
  const bleedController = occlusionFolder
    .add(occlusionParams, 'bleedReduction', 0, 1, 0.01)
    .name('Bleed reduction')
    .onChange(update);
  const grazingController = occlusionFolder
    .add(occlusionParams, 'grazingBiasScale', 0, 1, 0.01)
    .name('Grazing bias scale')
    .onChange(update);
  const varianceController = occlusionFolder
    .add(occlusionParams, 'varianceBleedScale', 0, 1, 0.01)
    .name('Variance bleed scale')
    .onChange(update);

  shadowController.listen?.();
  bleedController.listen?.();
  grazingController.listen?.();
  varianceController.listen?.();

  syncOcclusionUniform();
};

export const reduceLightBleeding = wgslFn(/* wgsl */ `
    fn reduce_light_bleeding(visibility: f32, amount: f32) -> f32 {
    let a = clamp(amount, 0.0, 0.99);
    // Map [a..1] -> [0..1], clamp below a to 0.
    return clamp((visibility - a) / (1.0 - a), 0.0, 1.0);
  }
`);

export const surfel_depth_base_index = wgslFn(
  /* wgsl */ `
  fn surfel_depth_base_index(surfelIndex: u32) -> u32 {
    let t = u32(SURFEL_DEPTH_TEXELS);
    return surfelIndex * (t * t);
  }
`,
  [consts],
);

/**
 * MSM4 visibility from 4 moments (m1..m4).
 *
 * Texture layout per texel: rgba = (E[z], E[z^2], E[z^3], E[z^4])
 *
 * Notes:
 * - Uninitialized sentinel: vec4(0) (moment4 == 0 => "uninitialized")
 * - We compute Hamburger 4MSM (Algorithm 3) and return visibility = 1 - shadow
 * - Includes a tiny "moment bias" alpha for numerical robustness
 * - Includes an internal scale normalization to improve float32 conditioning (scale-invariant)
 */
export const compute_surfel_depth_weight = wgslFn(
  /* wgsl */ `
  fn compute_surfel_depth_weight(
    mIn: vec4f, 
    distIn: f32,
    cosThetaIn: f32,          // 0..1, from hemi.z after clamp
    shadowStrengthIn: f32,    // darker shadows
    bleedReductionIn: f32,    // base bleed reduction 0..0.99
    grazingBiasScaleIn: f32,  // extra reduction at grazing,when variance is high
    // extra reduction from variance 0
    varianceBleedScaleIn: f32, 
  ) -> f32 {
    // Uninitialized => visible
    if (mIn.w == 0.0) { return 1.0; }

    // Prevent self-shadowing acne / pathological tiny depths.
    let zf = max(distIn, 1e-4);

    // Clamp moments to non-negative to avoid NaNs from filtering/precision oddities.
    // (Depths are >=0 in this pipeline, so this is a safe stabilizer.)
    let m1 = max(0.0, mIn.x);
    let m2 = max(0.0, mIn.y);
    let m3 = max(0.0, mIn.z);
    let m4 = max(0.0, mIn.w);

    // ------------------------------------------------------------
    // Scale normalization (improves numeric conditioning for large-world units):
    // Choose a scale from the RMS depth ~ sqrt(E[z^2]).
    // This is a simple change of variable (Z' = Z / s), so the CDF relation is preserved.
    // ------------------------------------------------------------
    let s = max(1e-4, sqrt(m2));
    let invS  = 1.0 / s;
    let invS2 = invS * invS;
    let invS3 = invS2 * invS;
    let invS4 = invS2 * invS2;

    let z  = zf * invS;

    var b = vec4f(
      m1 * invS,
      m2 * invS2,
      m3 * invS3,
      m4 * invS4
    );

    // ------------------------------------------------------------
    // Moment bias (small) for robustness (Algorithm 3 recommends alpha ~ 2e-6 for fp32).
    // This helps keep the moment matrix positive definite under filtering/precision.
    // ------------------------------------------------------------
    let alpha = 2e-6;
    b = b * (1.0 - alpha) + vec4f(0.5) * alpha;

    let b1 = b.x;
    let b2 = b.y;
    let b3 = b.z;
    let b4 = b.w;

    // Compute normalized variance for adaptive LBR
    let varN = max(0.0, b2 - b1 * b1);
    let varFactor = clamp(sqrt(varN), 0.0, 1.0); // smoother


    // Grazing in [0..1]
    let cosTheta = clamp(cosThetaIn, 0.0, 1.0);
    let grazing = 1.0 - cosTheta;

    // Effective bleed reduction:
    // - base term: bleedReductionIn
    // - variance term: varianceBleedScaleIn * varFactor
    // - grazing term: grazingBiasScaleIn * grazing * varFactor
    //   (NOTE: multiplied by varFactor so stable low-variance bins don't lose coverage)
    let bleed = clamp(
      bleedReductionIn
        + varianceBleedScaleIn * varFactor
        + grazingBiasScaleIn * grazing * varFactor,
      0.0,
      0.99
    );

    // ------------------------------------------------------------
    // Hamburger 4MSM (Algorithm 3)
    // We'll compute a SHADOW intensity in [0,1] first,
    // then convert to visibility and apply post-processing consistently.
    // ------------------------------------------------------------
    var shadow: f32;
    let eps = 1e-6;

    // Solve B c = (1, z, z^2)^T with LDL^T for symmetric 3x3:
    // B = [ 1   b1  b2
    //       b1  b2  b3
    //       b2  b3  b4 ]
    let l10 = b1;
    let l20 = b2;

    let d1  = max(eps, b2 - b1 * b1);
    let l21 = (b3 - b2 * b1) / d1;
    let d2  = max(eps, b4 - b2 * b2 - l21 * l21 * d1);

    // Forward solve L y = rhs
    let rhs0 = 1.0;
    let rhs1 = z;
    let rhs2 = z * z;

    let y0 = rhs0;
    let y1 = rhs1 - l10 * y0;
    let y2 = rhs2 - l20 * y0 - l21 * y1;

    // Diagonal solve D zV = y
    let z0 = y0;        // d0 == 1
    let z1 = y1 / d1;
    let z2v = y2 / d2;

    // Back solve L^T c = zV
    // c = (c0, c1, c2) such that: c2*x^2 + c1*x + c0 = 0
    let c2 = z2v;
    let c1 = z1 - l21 * c2;
    let c0 = z0 - l10 * c1 - l20 * c2;

    

    // If quadratic degenerates, fall back to VSM-style bound using first two moments.
    if (abs(c2) < 1e-6) {
      if (z <= b1) { 
        shadow = 0.0; 
      } else {
        let diff = z - b1;
        shadow = 1.0 - d1 / (d1 + diff * diff);
      }
    } else {
      let disc = max(0.0, c1 * c1 - 4.0 * c2 * c0);
      let sd = sqrt(disc);

      var z2r = (-c1 - sd) / (2.0 * c2);
      var z3r = (-c1 + sd) / (2.0 * c2);

      // Sort roots so z2r <= z3r
      if (z2r > z3r) {
        let t = z2r;
        z2r = z3r;
        z3r = t;
      }

      // If roots collapse, fall back (avoids rare div-by-small artifacts).
      if (abs(z3r - z2r) < 1e-6) {
        if (z <= b1) { 
          shadow = 0.0; 
        } else {
          let diff = z - b1;
          shadow = 1.0 - d1 / (d1 + diff * diff);
        }
      } else if (z <= z2r) {
        shadow = 0.0;
      } else if (z <= z3r) {
        // Middle branch
        let denom = (z3r - z2r) * max(eps, (z - z2r));
        shadow = (z * z3r - b1 * (z + z3r) + b2) / denom;
      } else {
        // Far branch
        let denom = max(eps, (z - z2r) * (z - z3r));
        shadow = 1.0 - (z2r * z3r - b1 * (z2r + z3r) + b2) / denom;
      }

    }


    shadow = clamp(shadow, 0.0, 1.0);

    // ------------------------------------------------------------
    // Post-processing (the part you were approximating with shadowMul):
    // 1) Shadow strength (your shadowMul)
    // 2) Convert to visibility
    // 3) Bleed-reduction remap (optionally driven by variance/grazing)
    // ------------------------------------------------------------
    let shadowStrength = max(0.0, shadowStrengthIn);
    shadow = clamp(shadow * shadowStrength, 0.0, 1.0);

    var visibility = 1.0 - shadow;
    visibility = reduce_light_bleeding(visibility, bleed);

    return clamp(visibility, 0.0, 1.0);
  }`,
  [reduceLightBleeding],
);

export const linear_sample_radial_depth = wgslFn(
  /* wgsl */ `
  fn linear_sample_radial_depth(
    surfelIndex: u32,
    uvIn: vec2f
  ) -> vec4f {
    let uv = clamp(uvIn, vec2f(0.0), vec2f(0.999));

    let t = i32(SURFEL_DEPTH_TEXELS);
    let tu = u32(SURFEL_DEPTH_TEXELS);
    let base = surfel_depth_base_index(surfelIndex);

    let p = uv * f32(SURFEL_DEPTH_TEXELS) - vec2f(0.5);
    let i0 = vec2i(floor(p));
    let f  = fract(p);
    let i1 = i0 + vec2i(1);

    let maxC = t - 1;
    let c0 = clamp(i0, vec2i(0), vec2i(maxC));
    let c1 = clamp(i1, vec2i(0), vec2i(maxC));

    // load helper (inline)
    let idx00 = base + u32(c0.y) * tu + u32(c0.x);
    let idx10 = base + u32(c0.y) * tu + u32(c1.x);
    let idx01 = base + u32(c1.y) * tu + u32(c0.x);
    let idx11 = base + u32(c1.y) * tu + u32(c1.x);

    // globally bound: surfelDepth: <storage, value: array<vec4f>, read>,
    let p00 = surfelDepth.value[idx00];
    let p10 = surfelDepth.value[idx10];
    let p01 = surfelDepth.value[idx01];
    let p11 = surfelDepth.value[idx11];

    let w00 = (1.0 - f.x) * (1.0 - f.y);
    let w10 = (f.x)       * (1.0 - f.y);
    let w01 = (1.0 - f.x) * (f.y);
    let w11 = (f.x)       * (f.y);

    let v00 = select(0.0, 1.0, p00.w != 0.0);
    let v10 = select(0.0, 1.0, p10.w != 0.0);
    let v01 = select(0.0, 1.0, p01.w != 0.0);
    let v11 = select(0.0, 1.0, p11.w != 0.0);

    let sw = w00*v00 + w10*v10 + w01*v01 + w11*v11;
    if (sw < 1e-8) { return vec4f(0.0); }

    return (p00*w00*v00 + p10*w10*v10 + p01*w01*v01 + p11*w11*v11) / sw;
  }
`,
  [consts, surfel_depth_base_index],
);

export const point_sample_radial_depth = wgslFn(
  /* wgsl */ `
  fn point_sample_radial_depth(
    surfelIndex: u32,
    uvIn: vec2f
  ) -> vec4f {
    let uv = clamp(uvIn, vec2f(0.0), vec2f(0.999));

    let t = u32(SURFEL_DEPTH_TEXELS);
    let base = surfel_depth_base_index(surfelIndex);

    let px = vec2u(floor(uv * f32(SURFEL_DEPTH_TEXELS)));
    let x = min(px.x, t - 1u);
    let y = min(px.y, t - 1u);

    let idx = base + y * t + x;
    // globally bound: surfelDepth: <storage, value: array<vec4f>, read>,
    return surfelDepth.value[idx];
  }
`,
  [consts, surfel_depth_base_index],
);

export const surfelRadialDepthOcclusion = wgslFn(
  /* wgsl */ `
  fn surfel_radial_occlusion(
    surfelIndex: u32,
    dirWS: vec3f,
    normalWS: vec3f,
    dist: f32,
    pixelNormal: vec3f,
    sRad: f32,
    dV: vec3f,
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

    // let m = point_sample_radial_depth(surfelIndex, uv);

    // Clamp to hemisphere (your encoding assumes z>=0)
    hemi.z = max(0.0, hemi.z);
    let cosTheta = clamp(hemi.z, 0.0, 1.0);

    return compute_surfel_depth_weight(m, dist, cosTheta, params.x, params.y, params.z, params.w);
  }
`,
  [
    hemiOctSquareEncode,
    compute_surfel_depth_weight,
    point_sample_radial_depth,
    linear_sample_radial_depth,
  ],
);

export const update_surfel_depth2 = wgslFn(
  /* wgsl */ `
  fn update_surfel_depth2(
    surfelIndex: u32,
    uvIn: vec2f,
    dist: f32,
    dirLocal: vec3f,
  ) -> void {

    let uv = clamp(uvIn, vec2f(0.0), vec2f(0.999));

    let tu = u32(SURFEL_DEPTH_TEXELS);
    let base = surfel_depth_base_index(surfelIndex);

    // Same "round to nearest texel center" logic you had:
    let p = uv * f32(SURFEL_DEPTH_TEXELS) - vec2f(0.5);
    var pxOffsetI = vec2i(floor(p + vec2f(0.5)));
    let maxI = i32(SURFEL_DEPTH_TEXELS - 1u);
    pxOffsetI = clamp(pxOffsetI, vec2i(0), vec2i(maxI));
    let pxOffset = vec2u(u32(pxOffsetI.x), u32(pxOffsetI.y));

    let idx = base + pxOffset.y * tu + pxOffset.x;

    let prev = surfelDepth.value[idx];
    var next: vec4f;

    if (prev.w == 0.0) {
      let d = max(dist, 1e-4);
      let d2 = d * d;
      let d3 = d2 * d;
      let d4 = d2 * d2;
      next = vec4f(d, d2, d3, d4);
    } else {
      let uvCenter = (vec2f(f32(pxOffset.x) + 0.5, f32(pxOffset.y) + 0.5)) / f32(SURFEL_DEPTH_TEXELS);
      let texelDir = hemiOctSquareDecode(uvCenter);
      let depthWeight = clamp(dot(dirLocal, texelDir), 0.0, 1.0);

      let d = max(dist, 1e-4);
      let d2 = d * d;
      let d3 = d2 * d;
      let d4 = d2 * d2;
      let sample = vec4f(d, d2, d3, d4);

      let kHit  = 0.05;
      let kMiss = 0.01;
      let k2 = select(kHit, kMiss, dist > prev.x);

      let alpha = k2; // optionally: * depthWeight
      next = prev + alpha * (sample - prev);

      next.y = max(next.y, next.x * next.x);
      next.w = max(next.w, next.y * next.y);
    }

    surfelDepth.value[idx] = next;
  }
`,
  [consts, hemiOctSquareDecode, surfel_depth_base_index],
);

// -----------------------------------------------------------------------------
// Point sample variant for a READ_WRITE (from integrate pass)
// -----------------------------------------------------------------------------
export const point_sample_radial_depth_rw = wgslFn(
  /* wgsl */ `
  fn point_sample_radial_depth_rw(
    surfelIndex: u32,
    uvIn: vec2f
  ) -> vec4f {
    let uv = clamp(uvIn, vec2f(0.0), vec2f(0.999));

    let tu = u32(SURFEL_DEPTH_TEXELS);
    let base = surfel_depth_base_index(surfelIndex);

    let px = vec2u(floor(uv * f32(SURFEL_DEPTH_TEXELS)));
    let x = min(px.x, tu - 1u);
    let y = min(px.y, tu - 1u);

    let idx = base + y * tu + x;
    // globally bound: surfelDepth: <storage, value: array<vec4f>, read>,
    return surfelDepth.value[idx];
  }
`,
  [consts, surfel_depth_base_index],
);

// -----------------------------------------------------------------------------
// MSM occlusion using READ_WRITE storage texture (integrator)
// IMPORTANT: returns 0 for directions behind the surfel hemisphere.
// -----------------------------------------------------------------------------
export const surfelRadialDepthOcclusionRW = wgslFn(
  /* wgsl */ `
  fn surfel_radial_occlusion_rw(
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

    // let m = linear_sample_radial_depth(surfelIndex, uv);

    let m = point_sample_radial_depth_rw(surfelIndex, uv);

    // Clamp to hemisphere (your encoding assumes z>=0)
    hemi.z = max(0.0, hemi.z);
    let cosTheta = clamp(hemi.z, 0.0, 1.0);

    return compute_surfel_depth_weight(m, dist, cosTheta, params.x, params.y, params.z, params.w);
  }
`,
  [
    hemiOctSquareEncode,
    point_sample_radial_depth_rw,
    compute_surfel_depth_weight,
    linear_sample_radial_depth,
  ],
);
