import { buildLayerMaps, type LayerMaps, type LayerSlice } from '../../shared/render/terrain/layerMaps.ts';
import { tileFbm, tileValue, tileWorley } from '../../shared/render/terrain/tileNoise.ts';

/**
 * The four sand surfaces the beach is made of, generated once at boot.
 *
 * They are drawn rather than loaded because the beach ships no texture files and
 * because a coral beach is four DIFFERENT surfaces, not one texture with the
 * contrast turned up: loose sun-bleached grain, the wind's ripple field, the
 * packed dark sand the swash leaves behind, and the shell and coral litter lying
 * on all three. Each is a slice of the layer arrays; which of them is where is
 * the material's business, not this file's.
 */

/** Texels per map. 512 resolves a grain at arm's length and costs 1 MB per texture. */
const SIZE = 512;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Warm cream through to shell white, the range coral sand actually covers. */
function sandTone(out: Float32Array, i: number, value: number, warmth: number): void {
  out[i * 3] = lerp(0.52, 0.90, value);
  out[i * 3 + 1] = lerp(0.40, 0.74, value) * lerp(1, 0.98, warmth);
  out[i * 3 + 2] = lerp(0.24, 0.50, value) * lerp(1, 0.90, warmth);
}

/**
 * Loose dry grain. The height is the grain itself: at the scale one repeat
 * covers (under a metre) a screen pixel sees several grains, so this map's job
 * is the sparkle of individual lit facets, not a shape.
 */
function dryGrainSlice(): LayerSlice {
  const albedo = new Float32Array(SIZE * SIZE * 3);
  const height = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      // One texel is 1.7 mm at this layer's tile, so a grain is two or three of
      // them: the map's whole job at this scale is that the eye can count them.
      const grain = tileValue(u, v, 256, 11) * 0.55 + tileValue(u, v, 170, 23) * 0.45;
      const clump = tileFbm(u, v, { period: 10, seed: 37, octaves: 4 });
      const i = y * SIZE + x;
      height[i] = grain * 0.8 + clump * 0.2;
      // Dark mineral grains and broken shell: sand is not one colour at grain
      // scale, and those flecks are most of what tells the eye how big a grain is.
      const mineral = tileValue(u, v, 128, 91) < 0.10 ? 1 : 0;
      const shell = tileValue(u, v, 96, 57) > 0.93 ? 1 : 0;
      const tone = 0.34 + grain * 0.62 + clump * 0.10 + shell * 0.40 - mineral * 0.45;
      sandTone(albedo, i, Math.min(1, Math.max(0, tone)), 1 - shell * 0.7);
    }
  }
  return { albedo, height, normalScale: 0.004 };
}

/**
 * The wind's ripple field: crests a few centimetres apart, running across the
 * prevailing wind, wandering as they go. Straight sine crests read as corduroy,
 * so the phase is pushed about by a low-frequency field — that wander is the
 * whole difference between a beach and a doormat.
 */
function rippleSlice(): LayerSlice {
  const albedo = new Float32Array(SIZE * SIZE * 3);
  const height = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      const wander = tileFbm(u, v, { period: 3, seed: 5, octaves: 3 }) - 0.5;
      // 18 crests across the layer's 1.7 m tile is a 9 cm wavelength — what wind of
      // a few metres per second leaves. At seven crests the beach was corduroy.
      const phase = (u * 18 + v * 5 + wander * 1.6) * Math.PI * 2;
      // Not sinusoidal: a long windward slope and a short steep lee face.
      const wave = Math.pow(Math.max(0, Math.sin(phase) * 0.5 + 0.5), 1.8);
      // Ripple trains do not run unbroken across a beach: they fork and die out.
      const train = tileFbm(u, v, { period: 5, seed: 71, octaves: 3 });
      const broken = Math.max(0, Math.min(1, (train - 0.28) * 2.4));
      const grain = tileValue(u, v, 200, 13);
      const i = y * SIZE + x;
      height[i] = Math.min(1, wave * broken * 0.85 + grain * 0.15);
      // Crests are picked clean and bleached; the troughs collect the heavier,
      // darker grains the wind cannot lift.
      const tone = 0.34 + height[i] * 0.50 + grain * 0.14;
      sandTone(albedo, i, Math.min(1, tone), 1 - height[i] * 0.6);
    }
  }
  return { albedo, height, normalScale: 0.010 };
}

/**
 * Packed wet sand. Water pulls the grains together, so the surface is smooth,
 * dark and faintly pitted where air escaped as the swash drained.
 */
function wetSandSlice(): LayerSlice {
  const albedo = new Float32Array(SIZE * SIZE * 3);
  const height = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      const swell = tileFbm(u, v, { period: 6, seed: 101, octaves: 3 });
      const pit = tileWorley(u, v, 64, 211);
      const bubble = pit.cellHash > 0.72 ? Math.max(0, 1 - pit.distance * 3.5) : 0;
      const i = y * SIZE + x;
      height[i] = Math.min(1, Math.max(0, 0.55 + swell * 0.25 - bubble * 0.5));
      // Dark and cool: wetted grains lose their diffuse haze and the light that
      // comes back has been through water on the way out.
      const tone = 0.16 + swell * 0.13 + tileValue(u, v, 200, 3) * 0.05 - bubble * 0.06;
      albedo[i * 3] = lerp(0.30, 0.52, tone * 3);
      albedo[i * 3 + 1] = lerp(0.24, 0.44, tone * 3);
      albedo[i * 3 + 2] = lerp(0.18, 0.34, tone * 3);
    }
  }
  return { albedo, height, normalScale: 0.002 };
}

/** Colour of one piece of litter, by what the cell's hash says it is. */
function litterColor(albedo: Float32Array, i: number, kind: number, lit: number): void {
  if (kind < 0.50) {
    albedo[i * 3] = 0.95 * lit; albedo[i * 3 + 1] = 0.89 * lit; albedo[i * 3 + 2] = 0.76 * lit; // shell white
  } else if (kind < 0.64) {
    albedo[i * 3] = 0.92 * lit; albedo[i * 3 + 1] = 0.72 * lit; albedo[i * 3 + 2] = 0.62 * lit; // pink coral
  } else if (kind < 0.85) {
    albedo[i * 3] = 0.46 * lit; albedo[i * 3 + 1] = 0.40 * lit; albedo[i * 3 + 2] = 0.31 * lit; // warm pebble
  } else {
    albedo[i * 3] = 0.24 * lit; albedo[i * 3 + 1] = 0.18 * lit; albedo[i * 3 + 2] = 0.12 * lit; // dark basalt chip
  }
}

/**
 * Shells, coral chips and pebbles LYING ON the sand. Its ranked coverage channel
 * is what decides where it takes the pixel, so the material states a density and
 * gets exactly that share of the ground covered.
 */
function litterSlice(): LayerSlice {
  const albedo = new Float32Array(SIZE * SIZE * 3);
  const height = new Float32Array(SIZE * SIZE);
  const presence = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      const cell = tileWorley(u, v, 22, 401);
      // Only a third of the cells hold a piece, and a piece fills most of its cell.
      // A dome in every cell puts a shell every four centimetres, and a coverage
      // cut through that field takes the CAPS of all of them: the beach comes out
      // stippled with specks instead of strewn with shells.
      const occupied = cell.cellHash < 0.34 ? 1 : 0;
      const radius = lerp(0.34, 0.62, cell.cellHash * 2.9);
      const inside = Math.max(0, 1 - cell.distance / radius) * occupied;
      // Nearly flat on top with a rolled edge: what the ranked cut then selects is
      // the piece, not its summit.
      const shape = Math.min(1, Math.pow(inside, 0.35));
      const grit = tileValue(u, v, 240, 67);
      const i = y * SIZE + x;
      presence[i] = shape;
      height[i] = Math.min(1, shape * 0.85 + grit * 0.15);
      const lit = 0.70 + shape * 0.30 + tileValue(u, v, 150, 89) * 0.14;
      litterColor(albedo, i, cell.cellHash * 2.9, Math.min(1.1, lit));
      // Off the pieces the map is plain sand. Their colours must not survive into
      // the coarse mips, where a whole cell averages into one distant pixel.
      if (shape <= 0.02) sandTone(albedo, i, 0.55 + grit * 0.2, 1);
    }
  }
  return { albedo, height, presence, normalScale: 0.045 };
}

export const SAND_SLICE = { dryGrain: 0, ripples: 1, wetPacked: 2, litter: 3 } as const;

/** The four slices, before they become textures. Exposed so a check can look at them. */
export function sandLayerSlices(): LayerSlice[] {
  return [dryGrainSlice(), rippleSlice(), wetSandSlice(), litterSlice()];
}

let cached: LayerMaps | null = null;

/**
 * Install authored maps, which the material then reads instead of the drawn ones.
 * @important Called before the island is built: the material captures whichever
 * maps exist when its nodes are made, and swapping the arrays afterwards would
 * mean rebuilding every node the sand shades with.
 */
export function useSandLayerMaps(maps: LayerMaps | null): void {
  if (maps) cached = maps;
}

/** The layer maps for the beach: the authored set if one was installed, else drawn. */
export function sandLayerMaps(): LayerMaps {
  if (cached) return cached;
  cached = buildLayerMaps(sandLayerSlices(), SIZE);
  return cached;
}
