import type * as THREE from 'three/webgpu';
import type { SceneBVHBundle } from '../surfel/sceneBvh.ts';
import type { DynamicBVHBundle } from '../surfel/dynamicBvh.ts';
import { probeKnobs } from './knobs.ts';

/**
 * Pixels per screen-probe tile. 16 is Lumen's default and the number the rest of
 * the tuning assumes: it is small enough that a 16x16 patch of a Cornell wall is
 * one plane, and large enough that the trace cost stays under the surfel
 * integrator's. Changing it changes the density of the whole gather, so it is a
 * constant rather than a runtime setting — the compute graph bakes it in.
 */
export const PROBE_TILE = 16;

/** Octahedral resolution per probe. 8x8 = 64 traced directions, Lumen's default. */
export const PROBE_OCT = 8;
export const PROBE_TEXELS = PROBE_OCT * PROBE_OCT;

/**
 * Extra probes a single tile may add, one per quadrant.
 *
 * A tile straddling a silhouette has no single plane to represent it, and the
 * bilateral test in the resolve will reject the tile-centre probe for every pixel
 * on the far side — which is the coverage hole reappearing one tier up. Four is
 * the natural number because the subdivision is a quadtree step.
 */
export const PROBE_ADAPTIVE_PER_TILE = 4;

/**
 * How many probes the pool holds, as a multiple of the uniform grid.
 *
 * Adaptive probes are allocated from a shared pool rather than reserved per tile,
 * because the tiles that need them are the silhouettes — a few percent of the
 * screen. Three times the uniform count is roughly "every eighth tile may split
 * completely", which no real frame comes close to.
 */
export const PROBE_POOL_SCALE = 3;

/** Hard ceiling, so a 4K window at dpr 2 cannot allocate half a gigabyte. */
export const PROBE_POOL_MAX = 24576;

export interface ProbeSettings {
  /** Screen probes replace the surfel resolve as the final gather. */
  enabled: boolean;
  /**
   * Run the legacy surfel resolve as well, into its own texture, so the two can
   * be shown side by side in one frame. Costs a full second gather; only worth it
   * while a split pane is actually pointed at it.
   */
  compare: boolean;
  /**
   * World-space length of the near-field trace. Rays that hit further away than
   * this stop being paid for and read the surfel cache instead — the two-tier
   * split that makes this a final gather rather than a path tracer.
   */
  nearField: number;
  /** Blend weight for this frame's trace against the reprojected history. */
  temporalAlpha: number;
  /**
   * One in N of a probe's 64 directions is retraced per frame; the rest carry
   * their reprojected history forward. A texel with no history is always traced,
   * so this costs latency on standing geometry and nothing at all on a cut.
   */
  traceStride: number;
  /** How far off a probe's plane a pixel (or a neighbour) may sit, in world units. */
  planeEpsilon: number;
  /** Minimum normal agreement for a probe to be accepted by a pixel. */
  normalThreshold: number;
  /** Spatial bilateral filter across the probe grid. */
  spatialFilter: boolean;
  /** Adaptive probe placement on high-variance tiles. */
  adaptive: boolean;
  /** Trace the dynamic BVH as well as the static one. `?dyntrace=0` turns it off. */
  dynamicTracing: boolean;
  /**
   * Whether the temporal reprojection flips y on the way from NDC back to a uv.
   *
   * It must, and the only reason this is a switch rather than a constant is that the
   * bug it fixes was invisible in every static screenshot and cost a day to find: the
   * lookup was mirrored about the screen's centreline, which the plane test *accepts*
   * on any surface that spans the mirror, so probes carried a plausible-looking history
   * that was not theirs. `?probeReproj=0` restores it, and the flicker measurement is
   * quoted against that.
   */
  reprojectFlipY: boolean;
  /** Draw the placement pane. A full-screen pass, so off unless something reads it. */
  debug: boolean;
  /**
   * Lumen's `ScreenProbeShortRangeAO`: a per-pixel short cone trace against the depth
   * buffer, folded into the probe irradiance before it is composited.
   *
   * It exists because the probe tier has a floor it cannot see past. Probes sit on a
   * 16px pitch and are reconstructed through a 5x5 probe-space bilateral, so the
   * narrowest indirect shadow the gather can express is of order 80 screen pixels. A
   * wall/floor junction on this scene measures a 6/255 sag spread over 180px — present,
   * but not contact shading by any reading. Nothing else in the frame resolves below
   * that: `n8ao` is in package.json and imported nowhere.
   */
  shortRangeAO: boolean;
  /** World radius of that trace. See `knobs.ts` for why this number and not another. */
  aoRadius: number;
  aoIntensity: number;
  aoBias: number;
  /**
   * `lightmap` puts the statics' indirect light in the baked atlas, so a probe
   * standing on one reports the *change* movable geometry made rather than the
   * radiance arriving — see `dynamicDelta`.
   */
  mode: 'surfel' | 'lightmap';
  /**
   * The dynamic term in lightmap mode. False restores the old movers-only placement,
   * under which a lightmapped pixel had no probe at all and no mover could darken it.
   */
  dynamicDelta: boolean;
}

export const probeSettings: ProbeSettings = {
  enabled: true,
  compare: false,
  // ~a third of the Cornell box's 8-unit span: far enough that a corner is
  // resolved entirely by real rays, short enough that the opposite wall is the
  // cache's problem and not the tracer's.
  nearField: 2.5,
  // The first number this tier has ever actually chosen, rather than declared.
  //
  // Until the reprojection was fixed (see `reprojectFlipY`) the history lookup was
  // mirrored and almost never validated, so the blend below was not applied and its
  // value could not matter: 0.12, 0.03 and 1.0 all measured the same frame-to-frame
  // flicker to within noise. With the filter running, the window it asks for is
  // suddenly the parameter that sets stability, and 0.12 is too short — it leaves a
  // static wall at 0.32 mean frame-to-frame against a 0.16 probes-off reference, and
  // the moving region at 1.06. 0.06 is a ~32-sample window, which at stride 2 is
  // roughly half a second at 120 Hz and lands squarely inside the history weight
  // Lumen runs its own screen probes at. Measured: 0.19 and 0.72.
  //
  // The cost is latency, and it is paid by indirect light alone — the sun and its
  // shadow map are untouched — which is the cheapest place in the frame to pay it.
  temporalAlpha: 0.06,
  // Stride 2 halves the ray cost against a per-frame trace. It also halves the
  // per-frame delta on its own, because half the texels are carrying history rather
  // than moving; stride 1 measures *worse* for that reason (0.50 against 0.28 on the
  // static wall) despite tracing four times as much.
  traceStride: 2,
  planeEpsilon: 0.06,
  normalThreshold: 0.75,
  spatialFilter: true,
  adaptive: true,
  dynamicTracing: true,
  reprojectFlipY: probeKnobs.reprojectFlipY(),
  debug: false,
  shortRangeAO: probeKnobs.shortRangeAO(),
  aoRadius: probeKnobs.aoRadius(),
  aoIntensity: probeKnobs.aoIntensity(),
  aoBias: probeKnobs.aoBias(),
  mode: 'surfel',
  dynamicDelta: probeKnobs.dynamicDelta(),
};

export function applyProbeSettings(next: Partial<ProbeSettings>): void {
  Object.assign(probeSettings, next);
}

/**
 * Scene handles the probe trace needs and cannot reach on its own.
 *
 * The probe chain is constructed inside `createSurfelGIResolvePass`, because that
 * is the one place in the pipeline that is handed both the surfel hash grid and
 * the pool — the world-space cache the probes fall back to. It is *not* handed
 * the acceleration structures, the sun or the scene, all of which live behind
 * `SurfelGI`'s private fields, so the app deposits them here. Both structures,
 * not just the static one: a probe that cannot see a mover cannot shadow against
 * it or pick up its bounce, and the lit-mover case is one of the defects this
 * tier exists to fix.
 */
export interface ProbeScene {
  scene: THREE.Scene | null;
  bvh: SceneBVHBundle | null;
  dynBvh: DynamicBVHBundle | null;
  env: THREE.Texture | null;
  light: THREE.DirectionalLight | null;
}

export const probeScene: ProbeScene = {
  scene: null,
  bvh: null,
  dynBvh: null,
  env: null,
  light: null,
};

export function applyProbeScene(next: Partial<ProbeScene>): void {
  Object.assign(probeScene, next);
}

/**
 * Textures the debug panes read, published by the pass for the same
 * unreachability reason as `probeScene` — the app owns the frame graph but has no
 * handle on the resolve pass that owns these.
 */
export const probeTextures: {
  probe: THREE.Texture | null;
  legacy: THREE.Texture | null;
  debug: THREE.Texture | null;
} = {
  probe: null,
  legacy: null,
  debug: null,
};

/** Sized once per resize; the app reads it for the HUD and the GUI. */
export const probeStats = {
  tilesX: 0,
  tilesY: 0,
  uniformProbes: 0,
  maxProbes: 0,
};
