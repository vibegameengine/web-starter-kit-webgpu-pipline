// @ts-nocheck -- vendored from jure/webgiya.
//
// LOCAL CHANGE vs upstream: the `consts` WGSL block used to live in
// surfelIntegratePass.ts, which surfelRadialDepth.ts imports from — while
// surfelIntegratePass.ts imports surfelRadialDepth.ts back. That cycle only stayed
// benign under webgiya's own main.ts import order; any other entry point evaluates
// surfelRadialDepth first and dies with "Cannot access 'consts' before
// initialization". Hoisting the block here breaks the cycle for good, since it
// depends on nothing but ./constants.
import { wgsl, wgslFn } from 'three/tsl';
import {
  CASCADES,
  MAX_TEMPORAL_M,
  MAX_SURFELS_PER_CELL_FOR_KEEP_ALIVE,
  OFFSETS_AND_LIST_START,
  SLG_DIM,
  SLG_LOBE_COUNT,
  SLG_TOTAL_FLOATS,
  SURFEL_BASE_RADIUS,
  SURFEL_CS,
  SURFEL_DEPTH_TEXELS,
  SURFEL_GRID_CELL_DIAMETER,
  SURFEL_NORMAL_DIRECTION_SQUISH,
  SURFEL_RADIUS_OVERSCALE,
  TOTAL_CELLS,
} from './constants';

const MAX_SURFELS_PER_CELL_LOOKUP = 32;

export const consts = wgsl(/* wgsl */ `
  const SURFEL_CS = ${SURFEL_CS};
  const SURFEL_CASCADES = ${CASCADES};
  const SURFEL_GRID_CELL_DIAMETER = ${SURFEL_GRID_CELL_DIAMETER};
  const SURFEL_BASE_RADIUS = ${SURFEL_BASE_RADIUS};
  const SURFEL_RADIUS_OVERSCALE = ${SURFEL_RADIUS_OVERSCALE};
  const SURFEL_NORMAL_DIRECTION_SQUISH = ${SURFEL_NORMAL_DIRECTION_SQUISH};
  const TOTAL_CELLS = ${TOTAL_CELLS}u;
  const MAX_SURFELS_PER_CELL_LOOKUP = ${MAX_SURFELS_PER_CELL_LOOKUP};
  const MAX_SURFELS_PER_CELL_FOR_KEEP_ALIVE = ${MAX_SURFELS_PER_CELL_FOR_KEEP_ALIVE};
  const SURFEL_DEPTH_TEXELS = ${SURFEL_DEPTH_TEXELS};
  const MAX_TEMPORAL_M: f32 = ${MAX_TEMPORAL_M.toFixed(1)};
  const BLUE_NOISE_SIZE : u32 = 1024u;
  const BLUE_NOISE_MASK : u32 = BLUE_NOISE_SIZE * BLUE_NOISE_SIZE - 1u;
  
  const SHORT_ESTIMATOR_SAMPLE_COUNT : f32 = 4.0;
  const PI: f32 = 3.141592653589793238462;

  const SLG_DIM : u32 = ${SLG_DIM}u;
  const SLG_LOBE_COUNT : u32 = ${SLG_LOBE_COUNT}u;
  const SLG_TOTAL_FLOATS : u32 = ${SLG_TOTAL_FLOATS}u;

  const LEARNING_RATE : f32 = 0.02; 
  const PGUIDE_DEFAULT : f32 = 0.5;

  const BLUE_NOISE_STRIDE: u32 = 64u;

  const OFFSETS_AND_LIST_START: i32 = ${OFFSETS_AND_LIST_START};
  struct SLGSample {
    dirLocal: vec3f,
    uv: vec2f,
  };

`);


// Moved here alongside `consts`, for the same cycle-breaking reason.
export const hemiOctSquareEncode = wgslFn(
  /* wgsl */ `
  fn hemiOctSquareEncode(d: vec3f) -> vec2f {
    // Assumes d is normalized and d.z >= 0
    let invL1 = 1.0 / (abs(d.x) + abs(d.y) + d.z);
    let p = d.xy * invL1;                // diamond: |px|+|py|<=1

    // rotate/scale diamond -> full square [-1,1]^2
    let q = vec2f(p.x + p.y, p.x - p.y);

    return q * 0.5 + 0.5;                // [0,1]^2
  }
`,
  [consts],
);

export const hemiOctSquareDecode = wgslFn(
  /* wgsl */ `
  fn hemiOctSquareDecode(uv: vec2f) -> vec3f {
    let q = uv * 2.0 - 1.0;                     // [-1,1]^2
    let p = vec2f(q.x + q.y, q.x - q.y) * 0.5;  // diamond

    let z = max(0.0, 1.0 - abs(p.x) - abs(p.y));
    return normalize(vec3f(p.x, p.y, z));       // guaranteed hemi
  }
`,
  [consts],
);
