// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
export const SURFEL_NORMAL_DIRECTION_SQUISH = 2.0;
export const SURFEL_LIFE_RECYCLE = 0x8000000;
export const SURFEL_LIFE_RECYCLED = SURFEL_LIFE_RECYCLE + 1;
export const SURFEL_CS = 32;
export const SURFEL_GRID_CELL_DIAMETER = 0.2;
export const SURFEL_TTL = 500;
const isMobileDevice =
  typeof navigator !== 'undefined' &&
  /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);

export const CASCADES = isMobileDevice ? 6 : 8;
export const SURFEL_BASE_RADIUS = 0.24;
export const MAX_SURFELS = isMobileDevice ? 65536 : 262144;
export const MAX_SURFELS_PER_CELL = 64;
export const MAX_SURFELS_PER_CELL_FOR_KEEP_ALIVE = 32;
export const TOTAL_CELLS = SURFEL_CS * SURFEL_CS * SURFEL_CS * CASCADES;
export const SURFEL_RADIUS_OVERSCALE = 1.25;

export const SLG_DIM = 8;
export const SLG_LOBE_COUNT = SLG_DIM * SLG_DIM; // 64 leaf cells
export const SLG_TOTAL_FLOATS = SLG_LOBE_COUNT + SLG_DIM; // 64 + 8 row sums = 72

export const SURFEL_MAX_HEALTH = 100; // Max credit a surfel can hold
export const SURFEL_KILL_SIGNAL = 255; // Immediate execution signal
export const SURFEL_IMPORTANCE_INDIRECT_MAX = 50;
export const SURFEL_IMPORTANCE_DIRECT_MAX = 100;

// ----------------------------------------------------------------------------
// Surfel radial depth atlas
// Each surfel owns a SURFEL_DEPTH_TEXELS x SURFEL_DEPTH_TEXELS tile storing MSM4 moments:
// rgba = (E[z], E[z^2], E[z^3], E[z^4])
// ----------------------------------------------------------------------------
export const SURFEL_DEPTH_TEXELS = 4;

// Large default so new surfels do NOT occlude everything until learned.
export const SURFEL_DEPTH_DEFAULT = 10.0;
export const SURFEL_DEPTH_DEFAULT2 =
  SURFEL_DEPTH_DEFAULT * SURFEL_DEPTH_DEFAULT;

export const FADE_FRAMES = 4;
export const TARGET_SAMPLE_COUNT = 32;

// Cell offsets + cell to surfel list in one buffer
// Index:    [0 .......... TOTAL_CELLS]  [TOTAL_CELLS+1 .................. end]
// Content:  [   prefix-sum offsets   ]  [               surfel indices       ]
//                                       |<-- OFFSETS_AND_LIST_START starts here
export const OFFSETS_AND_LIST_START = TOTAL_CELLS + 1;
