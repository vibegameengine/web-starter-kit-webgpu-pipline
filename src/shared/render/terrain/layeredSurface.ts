import { cameraPosition, clamp, exp, float, max, mix, normalize, positionWorld, smoothstep, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { LayerMaps } from './layerMaps.ts';
import { detailSharpness, footprintOf, layerLookAt, layerPlainLook, layerPlainReliefAt, layerReliefAt, type Footprint, type LayerLook } from './layerSampler.ts';

/**
 * A ground surface as a STACK OF LAYERS — the shape a landscape material has in
 * an engine that does this for a living, ported from the WebGL material in
 * `web-starter-kit` to TSL and this WebGPU pipeline.
 *
 * · a LAYER carries a full bundle — albedo, relief, normal, roughness — so wet
 *   sand comes out dark AND smooth AND flat-normalled at once, not in patches.
 * · a MASK says how much of it is here, and is one of the quantities the world
 *   already knows (the water's wetness field, height above the waterline), never
 *   a baked copy of something the shader could answer for free.
 * · a BLEND MODE says how the mask is honoured: `weight` averages, `height` lets
 *   the layer's own relief take the edge, `alpha` lays a lid over what is under
 *   it, `overlay` lies on top of the finished stack — a shell is on the wet sand
 *   and on the dry sand alike, because a shell does not care what it lies on.
 */

/** Every TSL expression is a `Node`; the aliases only say what it holds. */
type F1 = Node;
type V2 = Node;
type V3 = Node;

/** How sharply a height blend resolves. At 0 it degenerates into a weight blend. */
const HEIGHT_BLEND_SHARPNESS = 12;
/** How wide the band is between an overlay showing nothing and showing fully. */
const OVERLAY_FEATHER = 0.05;

export interface TerrainLayer {
  readonly name: string;
  /** Index of this layer's map pair. */
  readonly slice: number;
  /** World metres one repeat covers. */
  readonly tileMeters: number;
  readonly blend: 'base' | 'weight' | 'height' | 'alpha' | 'overlay';
  /** 0..1, how much of this layer is here. The base layer needs none. */
  readonly mask?: F1;
  /** Multiplied into this layer's colour. */
  readonly tint?: V3;
  readonly roughness?: number;
  /** Pushes this layer's relief up or down before the height blend compares it. */
  readonly heightBias?: number;
  /** For an overlay: the fraction of the ground its stones cover, 0..1. */
  readonly density?: number;
  /** Metres of apparent depth the layer may fake by shifting its own lookup. */
  readonly parallaxMeters?: number;
  /** How hard the layer shadows what lies under it, 0..1. */
  readonly contactShadow?: number;
  readonly normalStrength?: number;
  /**
   * How the layer's repeat is hidden. `stochastic` turns and offsets every cell;
   * `plain` reads the map straight, for a pattern whose DIRECTION matters.
   */
  readonly tiling?: 'stochastic' | 'plain';
}

export interface LayeredSurface {
  readonly albedo: V3;
  /** World-space normal, the layers' relief folded into the geometry's own. */
  readonly normal: V3;
  readonly roughness: F1;
  /** Micro-occlusion between and under the layers' relief, 0..1. */
  readonly shade: F1;
  /** What each layer ended up owning, in the order they were given. */
  readonly weights: readonly F1[];
  /** What each layer read, in the same order — for the debug views. */
  readonly looks: readonly LayerLook[];
}

interface StackedLayer extends LayerLook {
  readonly layer: TerrainLayer;
  readonly uv: V2;
  readonly footprint: Footprint;
  readonly sharp: F1;
}

/**
 * Parallax: shift this layer's own lookup against the view. A shelly surface
 * reads as shells because near sides hide what is behind them as the camera
 * moves — one extra texture read buys that without a triangle. World space, not
 * view space: this uv's axes ARE world X and Z, and a view-space offset would
 * swim with the camera instead of standing still on the ground.
 */
function parallaxUv(maps: LayerMaps, layer: TerrainLayer, uv: V2): V2 {
  const depth = layer.parallaxMeters ?? 0;
  if (depth <= 0) return uv;
  const toCamera = normalize(cameraPosition.sub(positionWorld));
  const probe = reliefOf(layer)(maps.layers[layer.slice], uv, footprintOf(uv));
  const sink = float(1).sub(probe).mul(depth);
  return uv.sub(toCamera.xz.div(max(toCamera.y, 0.3)).mul(sink.div(layer.tileMeters))) as V2;
}

const reliefOf = (layer: TerrainLayer) => (layer.tiling === 'plain' ? layerPlainReliefAt : layerReliefAt);

function stackLayer(maps: LayerMaps, layer: TerrainLayer): StackedLayer {
  const uv = parallaxUv(maps, layer, positionWorld.xz.div(layer.tileMeters) as V2);
  const footprint = footprintOf(uv);
  const read = layer.tiling === 'plain' ? layerPlainLook : layerLookAt;
  const look = read(maps.layers[layer.slice], uv, footprint, (layer.normalStrength ?? 0) > 0);
  return { ...look, layer, uv, footprint, sharp: detailSharpness(footprint) };
}

/**
 * Which layer covers what. The BASE is never masked away: if everything else
 * lets go, ground is still ground — which is also the guard against the classic
 * all-height-blend hole, where competing weights race each other to zero.
 */
function competingWeights(stack: readonly StackedLayer[]): F1[] {
  const weights = stack.map(({ layer, relief, sharp }): F1 => {
    if (layer.blend === 'base') return float(1);
    if (layer.blend === 'alpha' || layer.blend === 'overlay') return float(0);
    const mask = layer.mask ?? float(0);
    if (layer.blend !== 'height') return mask;
    // The sharpness RELAXES with distance, the way the overlay's cut does. A hard
    // height blend read from a mip-averaged relief flips between this layer and
    // the one under it per pixel, and a beach seen from across the diorama comes
    // out stippled like coarse fabric instead of smooth sand.
    return mask.mul(exp(relief.x.sub(0.5 - (layer.heightBias ?? 0)).mul(sharp.mul(HEIGHT_BLEND_SHARPNESS))));
  });
  const total = weights.reduce((sum, w) => sum.add(w), float(0) as F1);
  return weights.map((w) => w.div(max(total, 0.0001)) as F1);
}

/**
 * A lid covers what it covers. A wet strip of beach is not 70% wet sand and 30%
 * dry sand; it is wet sand, and whatever is left under it keeps its proportions.
 */
function applyCover(weights: F1[], index: number, cover: F1): void {
  for (let j = 0; j < weights.length; j++) {
    if (j !== index) weights[j] = weights[j].mul(float(1).sub(cover)) as F1;
  }
  weights[index] = cover;
}

/**
 * An overlay is not in the competition at all: it is laid over the finished
 * stack, lids included, and its own ranked coverage decides where it takes the
 * pixel. Far away, where one pixel spans many shells, the mip-averaged coverage
 * IS the fraction of the pixel they occupy, so the hard cut has to give way to
 * it or the field crawls.
 */
function coverOf(entry: StackedLayer): F1 {
  const { layer, relief, sharp } = entry;
  if (layer.blend === 'alpha') return clamp(layer.mask ?? float(0), 0, 1) as F1;
  const density = layer.density ?? 0.3;
  const above = relief.y.sub(1 - density);
  const hard = clamp(above.div(OVERLAY_FEATHER), 0, 1);
  const soft = clamp(above.div(density), 0, 1);
  return clamp(layer.mask ?? float(1), 0, 1).mul(mix(soft, hard, sharp)) as F1;
}

/**
 * Parallax can only dig INTO a surface, never lift anything above it, so on its
 * own a shell comes out flush with the sand with a hole scoured around it —
 * pressed in rather than lying on top. What says "this is standing proud" is the
 * shadow it throws on its own downhill side, so one tap along the light asks
 * each point whether something ahead of it stands between it and the sun.
 */
function contactShade(maps: LayerMaps, stack: readonly StackedLayer[], sunDir: V3): F1 {
  let shade: F1 = float(1);
  for (const { layer, uv, footprint, relief } of stack) {
    const contact = layer.contactShadow ?? 0;
    if (contact <= 0) continue;
    const reach = Math.max(layer.parallaxMeters ?? 0, 0.01) * 2 / layer.tileMeters;
    const step = sunDir.xz.div(max(sunDir.y, 0.25)).mul(reach) as V2;
    // Everything the relief leaves LOW is a gap between the stones, and a gap is
    // shaded from most of the sky. Without it the sand between them is as bright
    // as their tops, which is what makes a scatter read as a printed pattern.
    shade = shade.mul(float(1).sub(relief.x.oneMinus().mul(contact * 0.55))) as F1;
    const ahead = reliefOf(layer)(maps.layers[layer.slice], uv.add(step) as V2, footprint);
    // The blocker has to be a SHELL, not a grain: the sand between them has
    // relief of its own, and shadowing off every grain is dark stipple.
    shade = shade.mul(float(1).sub(smoothstep(0.18, 0.55, ahead.sub(relief.x)).mul(contact))) as F1;
  }
  return shade;
}

function compose(stack: readonly StackedLayer[], weights: readonly F1[], geometryNormal: V3): Omit<LayeredSurface, 'shade' | 'weights' | 'looks'> {
  let albedo: V3 = vec3(0, 0, 0);
  let tilt: V2 = vec2(0, 0);
  let roughness: F1 = float(0);
  stack.forEach(({ layer, albedo: color, normal, sharp }, i) => {
    const w = weights[i];
    albedo = albedo.add(w.mul(layer.tint ? color.mul(layer.tint) : color)) as V3;
    roughness = roughness.add(w.mul(layer.roughness ?? 0.9)) as F1;
    const strength = layer.normalStrength ?? 0;
    // Relief the pixel cannot resolve must not tilt anything: a normal read from
    // a mip that averaged a hundred ripples is noise, not a slope.
    if (strength > 0) tilt = tilt.add(normal.xy.mul(w.mul(sharp).mul(strength))) as V2;
  });
  // The layer maps' uv axes are world X and Z, so a tangent-space tilt is a tilt
  // of the world normal in those same axes — no tangent frame to get wrong.
  return { albedo, normal: normalize(geometryNormal.add(vec3(tilt.x, 0, tilt.y))) as V3, roughness };
}

export interface LayeredSurfaceContext {
  /** Unit vector toward the sun, for the layers' contact shadows. */
  readonly sunDir: V3;
  /** The geometry's own world normal, which the layers' relief tilts. */
  readonly geometryNormal: V3;
}

/** Resolve the stack into one surface. Layer 0 must be the base. */
export function layeredTerrainSurface(
  maps: LayerMaps,
  layers: readonly TerrainLayer[],
  context: LayeredSurfaceContext,
): LayeredSurface {
  const stack = layers.map((layer) => stackLayer(maps, layer));
  const weights = competingWeights(stack);
  const cover = (mode: TerrainLayer['blend']) => stack.forEach((entry, index) => {
    if (entry.layer.blend === mode) applyCover(weights, index, coverOf(entry));
  });
  cover('alpha');
  cover('overlay');
  return {
    ...compose(stack, weights, context.geometryNormal),
    shade: contactShade(maps, stack, context.sunDir),
    weights,
    looks: stack,
  };
}
