/**
 * Value noise that TILES EXACTLY.
 *
 * The layer maps are read through `fract(uv)` and every layer repeats across the
 * beach, so a field whose lattice does not wrap leaves a seam along every cell
 * border of every layer — a grid of hairlines drawn over the whole ground. The
 * simplex noise in `shared/lib/noise.ts` has no period, which is why this exists
 * next to it rather than inside it: this one is defined on a torus.
 *
 * Coordinates are in TURNS: x and y in [0, 1) cover one repeat of the map.
 */

function hashLattice(ix: number, iy: number, period: number, seed: number): number {
  const x = ((ix % period) + period) % period;
  const y = ((iy % period) + period) % period;
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number): number => t * t * (3 - 2 * t);

/** One octave, `period` cells across the repeat. Returns 0..1. */
export function tileValue(x: number, y: number, period: number, seed: number): number {
  const px = x * period;
  const py = y * period;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = fade(px - ix);
  const fy = fade(py - iy);
  const v00 = hashLattice(ix, iy, period, seed);
  const v10 = hashLattice(ix + 1, iy, period, seed);
  const v01 = hashLattice(ix, iy + 1, period, seed);
  const v11 = hashLattice(ix + 1, iy + 1, period, seed);
  return (v00 + (v10 - v00) * fx) * (1 - fy) + (v01 + (v11 - v01) * fx) * fy;
}

export interface TileFbmOptions {
  readonly period: number;
  readonly seed: number;
  readonly octaves?: number;
  readonly gain?: number;
}

/** Octaves of the above, each doubling the period — so the sum still tiles. Returns 0..1. */
export function tileFbm(x: number, y: number, options: TileFbmOptions): number {
  const { period, seed, octaves = 4, gain = 0.5 } = options;
  let amplitude = 1;
  let sum = 0;
  let norm = 0;
  let scale = period;
  for (let i = 0; i < octaves; i++) {
    sum += tileValue(x, y, scale, seed + i * 131) * amplitude;
    norm += amplitude;
    amplitude *= gain;
    scale *= 2;
  }
  return sum / norm;
}

/** Ridged version of the above: sharp crests, the shape wind leaves in sand. Returns 0..1. */
export function tileRidged(x: number, y: number, options: TileFbmOptions): number {
  const { period, seed, octaves = 3 } = options;
  let amplitude = 1;
  let sum = 0;
  let norm = 0;
  let scale = period;
  for (let i = 0; i < octaves; i++) {
    const signal = 1 - Math.abs(tileValue(x, y, scale, seed + i * 977) * 2 - 1);
    sum += signal * signal * amplitude;
    norm += amplitude;
    amplitude *= 0.45;
    scale *= 2;
  }
  return sum / norm;
}

/**
 * Distance to the nearest of `period²` scattered points, in cell units, 0..1-ish.
 * Wraps with the lattice, so scattered shells do not repeat visibly at the seam.
 */
export function tileWorley(x: number, y: number, period: number, seed: number): { distance: number; cellHash: number } {
  const px = x * period;
  const py = y * period;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  let best = 8;
  let bestHash = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox;
      const cy = iy + oy;
      const jx = hashLattice(cx, cy, period, seed);
      const jy = hashLattice(cx, cy, period, seed + 7717);
      const dx = cx + jx - px;
      const dy = cy + jy - py;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < best) {
        best = d;
        bestHash = hashLattice(cx, cy, period, seed + 3313);
      }
    }
  }
  return { distance: best, cellHash: bestHash };
}
