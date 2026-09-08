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

/**
 * Ceiling on the pool, not its size.
 *
 * It used to be both, and the two jobs pull in opposite directions. As a runtime cache
 * budget it was 30x too large: 262,144 slots costs 179 MiB of GPU storage plus the same
 * again in host typed arrays, and a 400 m landscape uses 3 % of it. As a bake budget it
 * is too small: a 1024 lightmap atlas on that same landscape wants 572,373 surfels and
 * gets 45.8 % of them, with the rest baking black.
 *
 * So it is now only the second thing — the point past which we refuse rather than
 * allocate — and `SURFEL_POOL_BASE` is the first. Refusing loudly is the whole reason
 * the number stays: an allocator that silently hands out nothing produces black, and
 * black is indistinguishable from a scene that is correctly unlit.
 */
export const MAX_SURFELS = isMobileDevice ? 65536 : 262144;

/**
 * Slots the pool starts with. Growth doubles from here on demand, up to MAX_SURFELS.
 *
 * 16,384 is a measurement, not a guess: the 400 m landscape settles at ~7,800 live
 * surfels and the Cornell box at ~3,100, so this is a little over 2x the largest
 * population either reference scene reaches. It is deliberately close enough to bite —
 * a scene half again as complex will grow, which is the path that has to work.
 */
export const SURFEL_POOL_BASE = isMobileDevice ? 8192 : 16384;

/** Occupancy at which the pool grows. Below 1 because growth is not instantaneous. */
export const SURFEL_POOL_GROW_AT = 0.85;

/**
 * Slots kept past a restored static cache, for movable geometry to allocate from.
 * 4096 is the size the runtime pool was given after a bake when the authoring pool
 * was thrown away; it is the same budget, now reached by not over-allocating rather
 * than by rebuilding.
 */
export const RUNTIME_POOL_TAIL = 4096;
export const MAX_SURFELS_PER_CELL = 64;

/**
 * The subset size `surfelGIResolvePass` used to read out of one grid cell.
 *
 * Kept because `?resolvecap=1` still runs that path and `?gridstats=` still reports
 * against this number, which is the only way the defect it caused stays visible: the
 * grid fills a cell in whatever order its atomics retired, so "the first 64" is a
 * different 64 every frame, and a corner cell whose surfels face three different planes
 * can hand back a subset that all weight to zero — a black patch that comes and goes
 * with nothing in the cache having changed. The shipping path no longer takes a subset
 * at all; see `RESOLVE_CELL_SCAN_CAP`.
 */
export const RESOLVE_FETCH_CAP = 64;

/**
 * Hard ceiling on how far the resolve will walk one cell's list.
 *
 * Not a quality knob and not the old cap under another name. Any selection that picks
 * the "best" K of N candidates has to evaluate all N to rank them, so once the loop is
 * paid for, discarding N-K of them only throws away energy and adds a comparison
 * network — the cheapest deterministic gather is therefore no selection at all, sum the
 * whole cell. What remains is a bound the shader compiler and the worst-case pixel need,
 * sized far above anything either reference scene reaches: `?gridstats=1400` puts the
 * fullest cell at 137 entries on the Cornell box and 248 on the 400 m landscape. A cell
 * past this would go back to reading an arbitrary prefix, which is why it is not close.
 */
export const RESOLVE_CELL_SCAN_CAP = 512;
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

/**
 * Ceiling on a surfel's temporal sample count, and therefore on how many integrations
 * it takes for one to be as converged as it will ever get.
 *
 * Exported rather than only existing as a WGSL literal because the lightmap bake's
 * iteration count is *derived* from it — a bake that runs fewer passes than this leaves
 * every texel short of the convergence the runtime reaches in a few hundred frames, and
 * unlike the runtime resolve a bake has nothing averaging neighbouring texels together,
 * so the shortfall lands in the image as per-texel grain. The two used to be separate
 * numbers with a comment in `bakeLightmap` arguing for one of them while the
 * composition root shipped the other; a constant they both read cannot drift.
 */
export const MAX_TEMPORAL_M = 200;

// Cell offsets + cell to surfel list in one buffer
// Index:    [0 .......... TOTAL_CELLS]  [TOTAL_CELLS+1 .................. end]
// Content:  [   prefix-sum offsets   ]  [               surfel indices       ]
//                                       |<-- OFFSETS_AND_LIST_START starts here
export const OFFSETS_AND_LIST_START = TOTAL_CELLS + 1;
