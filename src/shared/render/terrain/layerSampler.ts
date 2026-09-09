import { Fn, clamp, dFdx, dFdy, dot, exp, float, floor, fract, length, max, mix, smoothstep, sqrt, texture, vec2, vec3 } from 'three/tsl';
import type { Node, Texture, TextureNode } from 'three/webgpu';
import type { LayerTextures } from './layerMaps.ts';

/**
 * Reading one layer without seeing its tiling, in TSL.
 *
 * Ported from the WebGL layered-terrain material: every lookup takes a quarter
 * turn and an offset drawn from the cell it falls in, and the four neighbouring
 * cells are blended, so a repeat stops being a grid of copies.
 *
 * Two rules carry it, and both were paid for in the original:
 *
 * · Every read takes EXPLICIT GRADIENTS. A stochastic uv jumps at every cell
 *   border and wraps with `fract()`. The implicit derivative there is enormous,
 *   the GPU picks the smallest mip it owns, and fine sand at a distance turns
 *   into crawling white sparkle. The gradient of the SMOOTH pre-shuffle uv is
 *   the footprint that was meant, and a quarter turn does not change its size.
 *
 * · The colour, the relief and the normal of one cell take the SAME turn and
 *   offset — which is why they are packed into two textures read together.
 */

/** Every TSL expression is a `Node`; the aliases only say what it holds. */
type F1 = Node;
type V2 = Node;
type V3 = Node;

export const hash12 = /*#__PURE__*/ Fn(([p]: [V2]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

/** One of four quarter turns of a unit cell, picked by the cell's own hash. */
export const quarterTurn = /*#__PURE__*/ Fn(([uv, pick]: [V2, F1]) => {
  const flipX = float(1).sub(uv.x);
  const flipY = float(1).sub(uv.y);
  const turn3 = pick.lessThan(0.75).select(vec2(flipX, flipY), vec2(flipY, uv.x));
  const turn2 = pick.lessThan(0.5).select(vec2(uv.y, flipX), turn3);
  return pick.lessThan(0.25).select(uv, turn2);
});

/** The screen footprint of the SMOOTH uv, which every lookup is read through. */
export interface Footprint {
  readonly dx: V2;
  readonly dy: V2;
}

interface CellSample {
  /** rgb = albedo, a = relief. */
  readonly surface: Node;
  /** xy = tangent-space normal, z = ranked coverage. */
  readonly detail: Node;
  /** Tone jitter for this cell, 0.82..1.18. Colour only: relief must not be scaled. */
  readonly tone: F1;
  /** The 0..1 pick that chose this cell's quarter turn. */
  readonly pick: F1;
}

const sampleAt = (map: Texture, uv: V2, f: Footprint): Node => (texture(map, uv) as TextureNode).grad(f.dx, f.dy);

/** One cell's variant of the layer: where it lands in the maps, and how it is tinted. */
function cellSample(maps: LayerTextures, cell: V2, local: V2, f: Footprint): CellSample {
  const pick = hash12(cell) as F1;
  const rotated = quarterTurn(local, pick) as V2;
  const offset = vec2(hash12(cell.add(vec2(17, 3))), hash12(cell.add(vec2(5, 29))));
  const uv = fract(rotated.add(offset)) as V2;
  return {
    surface: sampleAt(maps.surface, uv, f),
    detail: sampleAt(maps.detail, uv, f),
    tone: mix(0.82, 1.18, hash12(cell.add(vec2(41, 11)))) as F1,
    pick,
  };
}

/**
 * The layer's tangent-space normal for one cell. The quarter turn is applied to
 * the VECTOR as well as to the lookup: a turned ripple lit from an unturned
 * normal reads as a flat print catching the light from the wrong side.
 */
function turnedNormal(sample: CellSample): V3 {
  const n = sample.detail.xy.mul(2).sub(1) as V2;
  const z = sqrt(clamp(float(1).sub(dot(n, n)), 0, 1));
  const turn3 = sample.pick.lessThan(0.75).select(vec3(n.x.negate(), n.y.negate(), z), vec3(n.y, n.x.negate(), z));
  const turn2 = sample.pick.lessThan(0.5).select(vec3(n.y.negate(), n.x, z), turn3);
  return sample.pick.lessThan(0.25).select(vec3(n.x, n.y, z), turn2) as V3;
}

export interface LayerLook {
  readonly albedo: V3;
  /** x = relief, y = ranked coverage. */
  readonly relief: V2;
  readonly normal: V3;
}

const CORNERS = [vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(1, 1)];

/** How hard the tallest variant of a cell wins its pixel. 0 is a plain average. */
const VARIANT_HEIGHT_SHARPNESS = 6;

interface CellBlend {
  readonly corners: CellSample[];
  /** One weight per corner, summing to 1. */
  readonly weights: F1[];
}

/**
 * The four cell variants a uv sits between, and how much each owns.
 *
 * NOT a plain bilinear average. Each variant is a differently turned copy of the
 * same map, so averaging them cancels exactly what they carry: measured on the
 * ripple layer, the blended normal came out within ±0.03 of straight up, and the
 * beach rendered as smooth as poured cream. Weighting each corner by its own
 * relief lets the tallest variant take the pixel, the way the layers themselves
 * height-blend, and the ripples survive the tiling that hides them.
 */
function cellBlend(maps: LayerTextures, uv: V2, f: Footprint): CellBlend {
  const cell = floor(uv) as V2;
  const local = fract(uv) as V2;
  const t = smoothstep(vec2(0, 0), vec2(1, 1), local) as V2;
  const corners = CORNERS.map((corner) => cellSample(maps, cell.add(corner) as V2, local, f));
  const area = [
    float(1).sub(t.x).mul(float(1).sub(t.y)),
    t.x.mul(float(1).sub(t.y)),
    float(1).sub(t.x).mul(t.y),
    t.x.mul(t.y),
  ];
  const raw = corners.map((corner, i) => area[i].mul(exp(corner.surface.a.sub(0.5).mul(VARIANT_HEIGHT_SHARPNESS))) as F1);
  const total = raw.reduce((sum, w) => sum.add(w), float(0) as F1);
  return { corners, weights: raw.map((w) => w.div(max(total, 1e-4)) as F1) };
}

const blended = (blend: CellBlend, of: (s: CellSample) => Node): Node =>
  blend.corners.map((corner, i) => of(corner).mul(blend.weights[i]) as Node).reduce((sum, term) => sum.add(term) as Node);

/**
 * The whole layer at one uv: the four neighbouring cell variants, resolved.
 *
 * Taking a single cell is what leaves the visible rectangular patchwork — the
 * variation is right, the seams between the cells are not. `wantNormal` is false
 * for a layer whose relief never reaches the lighting, and skips that blend.
 */
export function layerLookAt(maps: LayerTextures, uv: V2, f: Footprint, wantNormal: boolean): LayerLook {
  const blend = cellBlend(maps, uv, f);
  return {
    albedo: blended(blend, (s) => s.surface.rgb.mul(s.tone)) as V3,
    relief: blended(blend, (s) => vec2(s.surface.a, s.detail.z)) as V2,
    normal: wantNormal ? (blended(blend, turnedNormal) as V3) : (vec3(0, 0, 1) as V3),
  };
}

/** Relief alone, for the taps that only ask how high this layer stands. */
export function layerReliefAt(maps: LayerTextures, uv: V2, f: Footprint): F1 {
  const blend = cellBlend(maps, uv, f);
  return blended(blend, (s) => s.surface.a) as F1;
}

/**
 * The same layer read PLAIN: one tap, no turns, no cell blend.
 *
 * A stochastic read turns each cell by a quarter and blends its neighbours, which
 * is right for a surface with no direction in it — grain, gravel, litter. Wind
 * ripples HAVE a direction: turning every 2.6 m cell of them ninety degrees
 * leaves dapple where the beach should show trains of crests running one way.
 * A layer whose own map already wanders is better read straight.
 */
export function layerPlainLook(maps: LayerTextures, uv: V2, f: Footprint, wantNormal: boolean): LayerLook {
  const surface = sampleAt(maps.surface, uv, f);
  const detail = sampleAt(maps.detail, uv, f);
  const n = detail.xy.mul(2).sub(1) as V2;
  return {
    albedo: surface.rgb as V3,
    relief: vec2(surface.a, detail.z) as V2,
    normal: wantNormal ? (vec3(n.x, n.y, sqrt(clamp(float(1).sub(dot(n, n)), 0, 1))) as V3) : (vec3(0, 0, 1) as V3),
  };
}

/** Plain relief, for the taps that only ask how high a plain-read layer stands. */
export function layerPlainReliefAt(maps: LayerTextures, uv: V2, f: Footprint): F1 {
  return sampleAt(maps.surface, uv, f).a as F1;
}

/**
 * How much of this layer's own texture one screen pixel spans, inverted and
 * clamped: 1 where the detail is resolvable, 0 where it is not and the layer
 * must stop deciding anything per pixel.
 */
export function detailSharpness(f: Footprint): F1 {
  return clamp(float(1).sub(max(length(f.dx), length(f.dy)).mul(16)), 0, 1) as F1;
}

export const footprintOf = (uv: V2): Footprint => ({ dx: dFdx(uv) as V2, dy: dFdy(uv) as V2 });
