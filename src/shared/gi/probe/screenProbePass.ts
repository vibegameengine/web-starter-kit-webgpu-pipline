// @ts-nocheck -- TSL/WGSL node graphs; the published types describe none of this well.
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  atomicAdd,
  atomicStore,
  clamp,
  cross,
  float,
  floor,
  getViewPosition,
  instanceIndex,
  instancedArray,
  int,
  inverseSqrt,
  ivec2,
  max,
  min,
  sampler,
  storage,
  struct,
  texture,
  textureStore,
  uniform,
  vec2,
  vec3,
  vec4,
  uint,
  dot as dotNode,
  smoothstep,
  wgslFn,
} from 'three/tsl';
import {
  bvhIntersectFirstHit,
  constants as bvhConstants,
  getVertexAttribute,
  intersectionResultStruct,
  rayStruct,
} from '../bvh/webgpu/index.js';
import {
  dynBoundsHit,
  dynBvhIntersectFirstHit,
  getDynVertexAttribute,
  sceneHitStruct,
  traceScene,
  traceSceneOccluded,
} from '../surfel/dynamicBvh.ts';

import { Layer } from '../../world/index.ts';
import { createGBuffer } from '../surfel/gbuffer.ts';
import { SurfelMoments, SurfelStruct, type SurfelPool } from '../surfel/surfelPool.ts';
import {
  snap_to_surfel_grid_origin,
  surfel_grid_c4_to_hash,
  surfel_grid_coord_to_c4,
  surfel_pos_to_grid_coord,
  surfel_radius_for_pos,
  type SurfelHashGrid,
} from '../surfel/surfelHashGrid.ts';
import {
  OFFSETS_AND_LIST_START,
  SURFEL_NORMAL_DIRECTION_SQUISH,
  SURFEL_RADIUS_OVERSCALE,
} from '../surfel/constants.ts';
import { U_OCCLUSION_PARAMS } from '../surfel/surfelRadialDepth.ts';
import { consts } from '../surfel/wgslConsts.ts';
import {
  hemiOctSquareDecode,
  probeConsts,
  probeGridHelpers,
  probeJitter,
  probeRadiusEpsilon,
  probeRayRadiance,
  probeSampleDiffuse,
  probeSampleEnv,
  probeSurfelCache,
  probeSurfelCacheRO,
  probeTangentBasis,
} from './probeWgsl.ts';
import {
  PROBE_ADAPTIVE_PER_TILE,
  PROBE_OCT,
  PROBE_POOL_MAX,
  PROBE_POOL_SCALE,
  PROBE_TEXELS,
  PROBE_TILE,
  probeScene,
  probeSettings,
  probeStats,
  probeTextures,
} from './settings.ts';

/**
 * One screen probe. `aux.xy` is the pixel it was placed at, `aux.z` marks an
 * adaptive probe — both only exist so the resolve can weight by screen distance
 * and so the debug pane can draw what placement actually decided.
 */
const ProbeStruct = struct(
  {
    pos: 'vec4', // xyz world position, w = 1 when the probe found geometry
    normal: 'vec4', // xyz world normal, w = view-space depth
    aux: 'vec4', // xy screen pixel, z = adaptive flag
    far: 'vec4', // xyz world-cache radiance for the far field, w = cache weight
  },
  'ScreenProbe',
);

// --- small TSL echoes of the WGSL hemi-oct helpers ---------------------------
// The trace writes the atlas in WGSL and the SH projection reads it in TSL, so
// the two have to agree on the mapping to the last bit; the alternative is a
// probe whose stored radiance points somewhere other than where it was traced.

const octDecode = (uv) => {
  const q = uv.mul(2).sub(1);
  const p = vec2(q.x.add(q.y), q.x.sub(q.y)).mul(0.5);
  const z = max(float(0), float(1).sub(p.x.abs()).sub(p.y.abs()));
  return vec3(p.x, p.y, z).normalize();
};

const octJacobian = (uv) => {
  const q = uv.mul(2).sub(1);
  const p = vec2(q.x.add(q.y), q.x.sub(q.y)).mul(0.5);
  const v = vec3(p.x, p.y, float(1).sub(p.x.abs()).sub(p.y.abs()));
  const invR = inverseSqrt(max(float(1e-12), v.dot(v)));
  return invR.mul(invR).mul(invR).mul(2);
};

const tangentBasis = (n) => {
  const up = n.z.abs().lessThan(0.999).select(vec3(0, 0, 1), vec3(1, 0, 0));
  const t = cross(up, n).normalize();
  return { t, b: cross(n, t) };
};

/**
 * Irradiance from an L1 SH probe, in the units the composite expects.
 *
 * The coefficients already carry their basis constants, so this is
 * `E(N)/pi = c0*Y00 + (2/3)*Y1*(c.N)`. Clamped at zero because L1 rings: a probe
 * that saw one very bright direction reconstructs negative on the opposite side,
 * and negative irradiance times albedo is a black ring around a light source.
 */
/**
 * Directions and steps in the short-range AO trace.
 *
 * Baked in rather than made settable because they are loop bounds in the resolve
 * kernel, and because the useful lever is the *radius*, not the tap count: 8x5 already
 * puts the estimator's own noise well under the 6/255 gradient it is there to sharpen,
 * and doubling it buys nothing a screenshot can show. Cost is 40 depth fetches per
 * pixel, all inside a disc a few dozen pixels wide, so it is very nearly free — the
 * measured frame time did not move.
 */
const AO_DIRS = 8;
const AO_STEPS = 5;

/**
 * `signed` exists for the dynamic-delta probes and for nothing else.
 *
 * The clamp is right for radiance — L1 rings, and a probe that saw one very bright
 * direction reconstructs negative on the opposite side, which is a black halo round
 * every light source. It is catastrophic for a difference: the whole reason the
 * dynamic term is a signed quantity is that a mover has to be able to *darken* what it
 * stands near, and clamping at zero deletes precisely that half of it and keeps only
 * the bounce. The ringing is still there in the signed branch; it is bounded by the
 * magnitude of the delta itself, which is small wherever the mover is not.
 */
const evalSH = (c0, c1, c2, c3, n, signed = null) => {
  const v = c0
    .mul(0.282095)
    .add(
      c1
        .mul(n.y)
        .add(c2.mul(n.z))
        .add(c3.mul(n.x))
        .mul(0.488603 * (2 / 3)),
    );
  const clamped = max(vec3(0), v);
  return signed === null ? clamped : signed.select(v, clamped);
};

export function createScreenProbePass(grid: SurfelHashGrid, pool: SurfelPool) {
  // --- uniforms -------------------------------------------------------------
  const U_PROJ_INV = uniform(new THREE.Matrix4());
  const U_CAM_WORLD = uniform(new THREE.Matrix4());
  const U_PREV_VIEW_PROJ = uniform(new THREE.Matrix4());
  const U_CAM_POS = uniform(new THREE.Vector3());
  const U_GRID_ORIGIN = uniform(new THREE.Vector3());
  const U_FRAME = uniform(0);
  const U_MOMENTS_READ = uniform(0);
  const U_PROBE_CUR = uniform(0);
  const U_PROBE_PREV = uniform(0);
  const U_RAD_CUR = uniform(0);
  const U_RAD_PREV = uniform(0);
  const U_LIGHT_DIR = uniform(new THREE.Vector3(0, 1, 0));
  const U_LIGHT_COLOR = uniform(new THREE.Color(1, 1, 1));
  const U_ENV_INTENSITY = uniform(1);
  const U_ENV_LOD = uniform(4);
  const U_NEAR_FIELD = uniform(2.5);
  const U_TEMPORAL = uniform(0.12);
  /**
   * Ceiling on the accumulated-frame count in `probeRadiance.w`, and the switch that
   * gives that field its meaning: 0 is the shipping 0/1 valid flag and the fixed-alpha
   * blend, anything else is the running average. One uniform for both because the two
   * are the same decision — see `probeSettings.temporalAge`.
   */
  const U_AGE_MAX = uniform(0);
  const U_PLANE_EPS = uniform(0.06);
  const U_NORMAL_THRESHOLD = uniform(0.75);
  const U_ADAPTIVE = uniform(1);
  const U_FILTER = uniform(1);
  const U_ALBEDO_BOOST = uniform(1);
  const U_HISTORY_VALID = uniform(0);
  const U_DYN_TRACE = uniform(0);
  const U_TRACE_STRIDE = uniform(4);
  const U_REPROJ_FLIP = uniform(1);
  const U_AO_RADIUS = uniform(0.3);
  const U_AO_INTENSITY = uniform(1.3);
  const U_AO_BIAS = uniform(0.08);
  /**
   * Pixels per world unit at one unit of view depth: `0.5 * height * P[1][1]`. The AO
   * radius is a world quantity and the march is a screen-space one, and this is the
   * only honest way across — a fixed pixel radius would be a different amount of
   * shading at every distance, which is how screen-space AO earns its reputation.
   */
  const U_PROJ_SCALE = uniform(1);
  /** 1 in lightmap mode: statics report a difference rather than a radiance. */
  const U_DELTA_MODE = uniform(0);

  // --- state ----------------------------------------------------------------
  let width = 0;
  let height = 0;
  let tilesX = 0;
  let tilesY = 0;
  let uniformCount = 0;
  let maxProbes = 0;

  let probeAttr: THREE.StorageBufferAttribute | null = null;
  let radianceAttr: THREE.StorageBufferAttribute | null = null;
  let shRawAttr: THREE.StorageBufferAttribute | null = null;
  let shOutAttr: THREE.StorageBufferAttribute | null = null;
  let tileAdaptiveAttr: THREE.StorageBufferAttribute | null = null;
  let adaptiveCounter: THREE.StorageBufferNode | null = null;

  let outputTexture: THREE.Texture | null = null;
  let debugTexture: THREE.Texture | null = null;

  let clearNode: THREE.ComputeNode | null = null;
  let placeNode: THREE.ComputeNode | null = null;
  let farNode: THREE.ComputeNode | null = null;
  let traceNode: THREE.ComputeNode | null = null;
  let shNode: THREE.ComputeNode | null = null;
  let filterNode: THREE.ComputeNode | null = null;
  let resolveNode: THREE.ComputeNode | null = null;
  let debugNode: THREE.ComputeNode | null = null;

  /** Movers-only G-Buffer, allocated the first time lightmap mode asks for one. */
  let moverGBuffer: ReturnType<typeof createGBuffer> | null = null;
  /**
   * Its depth, and the whole of what the rest of the pass needs from it. Null in
   * surfel mode, and the node graph is keyed on that so switching modes rebuilds
   * rather than reading a texture that is no longer being drawn.
   */
  let maskDepth: THREE.Texture | null = null;

  let parity = 0;
  let boundGBufferKey = '';
  let hadHistory = false;

  function discard() {
    clearNode = null;
    placeNode = null;
    farNode = null;
    traceNode = null;
    shNode = null;
    filterNode = null;
    resolveNode = null;
    debugNode = null;
  }

  function resize(w: number, h: number) {
    if (w === width && h === height && probeAttr) return;
    width = w;
    height = h;
    tilesX = Math.max(1, Math.ceil(w / PROBE_TILE));
    tilesY = Math.max(1, Math.ceil(h / PROBE_TILE));
    uniformCount = tilesX * tilesY;
    maxProbes = Math.min(PROBE_POOL_MAX, uniformCount * PROBE_POOL_SCALE);

    probeStats.tilesX = tilesX;
    probeStats.tilesY = tilesY;
    probeStats.uniformProbes = uniformCount;
    probeStats.maxProbes = maxProbes;

    // Doubled: the trace reprojects into last frame's probes and their radiance,
    // so both generations have to be resident at once. Same ping-pong trick the
    // surfel moments buffer uses, for the same reason.
    probeAttr = new THREE.StorageBufferAttribute(
      new Float32Array(maxProbes * 2 * 16),
      16,
    );
    radianceAttr = new THREE.StorageBufferAttribute(
      new Float32Array(maxProbes * PROBE_TEXELS * 2 * 4),
      4,
    );
    shRawAttr = new THREE.StorageBufferAttribute(new Float32Array(maxProbes * 4 * 4), 4);
    shOutAttr = new THREE.StorageBufferAttribute(new Float32Array(maxProbes * 4 * 4), 4);
    tileAdaptiveAttr = new THREE.StorageBufferAttribute(
      new Int32Array(uniformCount * PROBE_ADAPTIVE_PER_TILE),
      1,
    );
    adaptiveCounter = instancedArray(new Int32Array(1), 'int').toAtomic();

    outputTexture = new THREE.StorageTexture(w, h);
    outputTexture.type = THREE.HalfFloatType;
    outputTexture.format = THREE.RGBAFormat;
    debugTexture = new THREE.StorageTexture(w, h);
    debugTexture.type = THREE.HalfFloatType;
    debugTexture.format = THREE.RGBAFormat;

    probeTextures.probe = outputTexture;
    probeTextures.debug = debugTexture;

    parity = 0;
    hadHistory = false;
    discard();
  }

  /**
   * In lightmap mode the statics already carry their indirect light in a texture,
   * so a probe standing on one would add it a second time. `DynamicCaster` is the
   * mask that means "movable" in this codebase (see world/mobility.ts: every
   * object is also on `Default`, so excluding `GiStatic` would exclude nothing) —
   * a pixel with no probe resolves to zero, and zero times albedo is exactly the
   * "leave the lightmap alone" the composite needs.
   */
  function moverOnlyGBuffer(
    renderer: THREE.WebGPURenderer,
    camera: THREE.PerspectiveCamera,
  ) {
    const scene = probeScene.scene;
    if (!scene) return null;
    if (!moverGBuffer) moverGBuffer = createGBuffer(renderer);
    else moverGBuffer.resize(renderer);

    const previousTarget = renderer.getRenderTarget();
    const previousBackground = scene.background;
    const cameraLayers = camera.layers.mask;

    scene.background = null;
    camera.layers.set(Layer.DynamicCaster);
    renderer.setMRT(moverGBuffer.sceneMRT);
    renderer.setRenderTarget(moverGBuffer.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previousTarget);
    renderer.setMRT(null);
    camera.layers.mask = cameraLayers;
    scene.background = previousBackground;

    return moverGBuffer;
  }

  function build(gbuffer: { target: THREE.RenderTarget }) {
    const bvh = probeScene.bvh;
    const dynBvh = probeScene.dynBvh;
    const env = probeScene.env;
    if (!bvh || !dynBvh || !env) return false;

    const texDepth = gbuffer.target.depthTexture;
    const texNormal = gbuffer.target.textures[0];
    const surfelAttr = pool.getSurfelAttr();
    const momentsAttr = pool.getMomentsAttr();
    const offsetsAndListAttr = grid.getOffsetsAndListAttr();
    const touchedAtomic = pool.getTouched();
    const surfelDepthAttr = pool.getSurfelDepthAttr();
    if (
      !texDepth ||
      !texNormal ||
      !surfelAttr ||
      !momentsAttr ||
      !offsetsAndListAttr ||
      !touchedAtomic ||
      !surfelDepthAttr
    ) {
      return false;
    }

    const capacity = surfelAttr.count;
    const probes = storage(probeAttr!, ProbeStruct, maxProbes * 2).setName('probes');
    const probesRO = storage(probeAttr!, ProbeStruct, maxProbes * 2)
      .setAccess('readOnly')
      .setName('probes');
    const radiance = storage(radianceAttr!, 'vec4', maxProbes * PROBE_TEXELS * 2).setName(
      'probeRadiance',
    );
    const radianceRO = storage(radianceAttr!, 'vec4', maxProbes * PROBE_TEXELS * 2)
      .setAccess('readOnly')
      .setName('probeRadiance');
    const shRaw = storage(shRawAttr!, 'vec4', maxProbes * 4);
    const shRawRO = storage(shRawAttr!, 'vec4', maxProbes * 4).setAccess('readOnly');
    const shOut = storage(shOutAttr!, 'vec4', maxProbes * 4);
    const shOutRO = storage(shOutAttr!, 'vec4', maxProbes * 4).setAccess('readOnly');
    const tileAdaptive = storage(tileAdaptiveAttr!, 'int', tileAdaptiveAttr!.count);
    const tileAdaptiveRO = storage(
      tileAdaptiveAttr!,
      'int',
      tileAdaptiveAttr!.count,
    ).setAccess('readOnly');

    const surfelsRO = storage(surfelAttr, SurfelStruct, capacity)
      .setAccess('readOnly')
      .setName('surfels');
    const momentsRO = storage(momentsAttr, SurfelMoments, capacity * 2)
      .setAccess('readOnly')
      .setName('moments');
    const offsetsAndListRO = storage(offsetsAndListAttr, 'int', offsetsAndListAttr.count)
      .setAccess('readOnly')
      .setName('offsetsAndList');
    const surfelDepthRO = storage(surfelDepthAttr, 'vec4', surfelDepthAttr.count)
      .setAccess('readOnly')
      .setName('surfelDepth');
    const touchedBuffer = touchedAtomic.setName('touched');

    // ---------------------------------------------------------------- geometry
    const sampleGeom = (px, py) => {
      const uv = vec2(
        px.toFloat().add(0.5).div(float(width)),
        py.toFloat().add(0.5).div(float(height)),
      );
      const depth = texture(texDepth, uv).r;
      const valid = depth.lessThan(0.999).and(depth.greaterThan(0.0));
      const viewPos = getViewPosition(uv, depth, U_PROJ_INV);
      const worldPos = U_CAM_WORLD.mul(vec4(viewPos, 1.0)).xyz;
      const n = texture(texNormal, uv).xyz.mul(2.0).sub(1.0).normalize();
      return { valid, worldPos, n, viewZ: viewPos.z };
    };

    /**
     * Is this pixel one the baked lighting already speaks for?
     *
     * In lightmap mode the statics carry their indirect light in a texture, so what a
     * probe on one of them owes the composite is the *change* a mover made, while a
     * probe standing on the mover itself owes the full gather — the mover has no
     * lightmap and nothing else in the frame will light it. One buffer, two
     * quantities, so every stage downstream has to be able to tell them apart, and
     * this is where that decision is made once.
     *
     * The test is a depth comparison against a movers-only draw of the same scene from
     * the same camera. A silhouette test on the mask alone would classify the pixels
     * where a mover is hidden *behind* a static as mover pixels; comparing the two
     * depths does not, because a hidden mover is further away. `<=` rather than `==`
     * because the two draws rasterise the same triangles through the same matrices but
     * are separate passes, and asking for bit equality of a depth value across passes
     * is asking for a one-pixel rim of misclassified probes round every mover.
     *
     * Returns 0 in surfel mode, where every probe reports the full gather and this
     * whole distinction does not exist.
     */
    const deltaFlag = (px, py) => {
      if (!maskDepth) return float(0);
      const uv = vec2(
        px.toFloat().add(0.5).div(float(width)),
        py.toFloat().add(0.5).div(float(height)),
      );
      const md = texture(maskDepth, uv).r;
      const sd = texture(texDepth, uv).r;
      const isMover = md
        .lessThan(float(0.999))
        .and(md.greaterThan(float(0)))
        .and(md.lessThanEqual(sd.add(float(1e-5))));
      return U_DELTA_MODE.mul(isMover.select(float(0), float(1)));
    };

    // ------------------------------------------------- short-range AO (Lumen's)
    /**
     * `ScreenProbeShortRangeAO`: the near-field tier below the probes, in exactly the
     * sense the probes are the near-field tier below the surfel cache. Screen-space
     * depth marching, not BVH rays — the whole point is that it resolves the few
     * pixels around a contact, and a BVH ray budget that could do that per pixel is
     * not a budget this frame has.
     *
     * Horizon form (HBAO), not a disc estimator: per direction only the *largest*
     * occlusion along the march counts, which is what stops a wall that is sampled
     * five times from occluding five times over. The falloff is what makes it a
     * contact term rather than an ambient one — beyond `aoRadius` a sample cannot
     * contribute at all, so the term is guaranteed to have converged to 1 by then and
     * the "does it stop" half of the acceptance is structural rather than tuned.
     *
     * The dither is spatial only. There is no temporal filter downstream of this — it
     * multiplies an irradiance that is already temporally converged — so a per-frame
     * rotation would be visible as crawl on a still camera and measurable as noise in
     * a strip average. A fixed interleaved-gradient rotation is stable by
     * construction; its cost is a faint fixed pattern instead of noise, which is the
     * better failure when the output is a screenshot.
     */
    const shortRangeAO = (px, py, P, N, viewZ) => {
      const visibility = float(1).toVar();
      If(U_AO_INTENSITY.greaterThan(float(0)), () => {
        const radiusPx = clamp(
          U_AO_RADIUS.mul(U_PROJ_SCALE).div(max(float(0.05), viewZ.negate())),
          float(2),
          float(96),
        );
        const ign = float(52.9829189)
          .mul(
            float(0.06711056)
              .mul(px.toFloat())
              .add(float(0.00583715).mul(py.toFloat()))
              .fract(),
          )
          .fract();

        const occ = float(0).toVar();
        Loop({ start: int(0), end: int(AO_DIRS), type: 'int', name: 'd' }, ({ d }) => {
          const ang = ign
            .add(d.toFloat().div(float(AO_DIRS)))
            .mul(float(Math.PI * 2));
          const dx = ang.cos();
          const dy = ang.sin();
          const horizon = float(0).toVar();

          Loop(
            { start: int(1), end: int(AO_STEPS + 1), type: 'int', name: 's' },
            ({ s }) => {
              // Quadratic step spacing: the first tap lands a pixel or two out, so the
              // contact itself is sampled densely and the outer radius costs one tap.
              const t = s.toFloat().div(float(AO_STEPS));
              const stepPx = max(float(1), t.mul(t).mul(radiusPx));
              // Snapped to the texel centre, and this matters more than it looks.
              // The depth texture is nearest-filtered, so a continuous uv fetches one
              // pixel's depth but unprojects along a ray half a pixel away from it —
              // and the reconstructed point then sits slightly off the surface, giving
              // a flat wall a small self-occlusion that varies with the dither angle.
              // It showed up as a faint diagonal weave over every flat surface in the
              // frame, about 2/255, which is under the frame's own run-to-run noise and
              // still perfectly visible in a 4x crop. Snapping makes the fetch and the
              // unprojection describe the same pixel, and the weave goes away.
              const sx = clamp(
                px.toFloat().add(dx.mul(stepPx)),
                float(0),
                float(width - 1),
              ).floor();
              const sy = clamp(
                py.toFloat().add(dy.mul(stepPx)),
                float(0),
                float(height - 1),
              ).floor();
              const suv = vec2(
                sx.add(0.5).div(float(width)),
                sy.add(0.5).div(float(height)),
              );
              const sd = texture(texDepth, suv).r;
              If(sd.lessThan(float(0.999)).and(sd.greaterThan(float(0))), () => {
                const q = U_CAM_WORLD.mul(
                  vec4(getViewPosition(suv, sd, U_PROJ_INV), 1.0),
                ).xyz;
                const v = q.sub(P);
                const len = v.length();
                If(len.greaterThan(float(1e-4)).and(len.lessThan(U_AO_RADIUS)), () => {
                  const c = v.div(len).dot(N).sub(U_AO_BIAS);
                  const fall = float(1).sub(len.div(U_AO_RADIUS));
                  horizon.assign(max(horizon, c.mul(fall)));
                });
              });
            },
          );

          occ.addAssign(max(float(0), horizon));
        });

        visibility.assign(
          clamp(
            float(1).sub(occ.div(float(AO_DIRS)).mul(U_AO_INTENSITY)),
            float(0),
            float(1),
          ),
        );
      });
      return visibility;
    };

    // --------------------------------------------------------------- 0. clear
    clearNode = Fn(() => {
      const i = int(instanceIndex);
      If(i.equal(int(0)), () => {
        atomicStore(adaptiveCounter!.element(0), int(0));
      });
      probes.element(i.add(int(U_PROBE_CUR))).get('pos').assign(vec4(0, 0, 0, 0));
    })()
      .compute(maxProbes)
      .setName('Probe clear');

    // ----------------------------------------------------------- 1. placement
    placeNode = Fn(() => {
      const tid = int(instanceIndex);
      const tx = tid.mod(int(tilesX));
      const ty = tid.div(int(tilesX));

      // The tile's own thread owns all of its adaptive slots, so clearing them
      // here needs no synchronisation with anything.
      Loop({ start: int(0), end: int(PROBE_ADAPTIVE_PER_TILE), type: 'int', name: 'k' }, ({ k }) => {
        tileAdaptive
          .element(tid.mul(int(PROBE_ADAPTIVE_PER_TILE)).add(k))
          .assign(int(-1));
      });

      const cx = min(tx.mul(int(PROBE_TILE)).add(int(PROBE_TILE >> 1)), int(width - 1));
      const cy = min(ty.mul(int(PROBE_TILE)).add(int(PROBE_TILE >> 1)), int(height - 1));
      const c = sampleGeom(cx, cy);

      const slot = tid.add(int(U_PROBE_CUR));
      If(c.valid, () => {
        probes.element(slot).get('pos').assign(vec4(c.worldPos, float(1)));
        probes.element(slot).get('normal').assign(vec4(c.n, c.viewZ));
        probes
          .element(slot)
          .get('aux')
          .assign(vec4(cx.toFloat(), cy.toFloat(), float(0), deltaFlag(cx, cy)));
      });

      // Adaptive placement. A tile that is one plane needs nothing; a tile the
      // centre probe cannot speak for gets a probe per offending quadrant, which
      // is a single quadtree step and enough for a silhouette at this density.
      If(U_ADAPTIVE.greaterThan(0.5), () => {
        Loop({ start: int(0), end: int(4), type: 'int', name: 'q' }, ({ q }) => {
          const qx = min(
            tx
              .mul(int(PROBE_TILE))
              .add(q.mod(int(2)).mul(int(PROBE_TILE >> 1)))
              .add(int(PROBE_TILE >> 2)),
            int(width - 1),
          );
          const qy = min(
            ty
              .mul(int(PROBE_TILE))
              .add(q.div(int(2)).mul(int(PROBE_TILE >> 1)))
              .add(int(PROBE_TILE >> 2)),
            int(height - 1),
          );
          const s = sampleGeom(qx, qy);

          If(s.valid, () => {
            const offPlane = s.worldPos.sub(c.worldPos).dot(c.n).abs();
            const needs = c.valid
              .not()
              .or(s.n.dot(c.n).lessThan(0.9))
              .or(offPlane.greaterThan(U_PLANE_EPS));

            If(needs, () => {
              const got = atomicAdd(adaptiveCounter!.element(0), int(1));
              const idx = int(uniformCount).add(got);
              If(idx.lessThan(int(maxProbes)), () => {
                const b = idx.add(int(U_PROBE_CUR));
                probes.element(b).get('pos').assign(vec4(s.worldPos, float(1)));
                probes.element(b).get('normal').assign(vec4(s.n, s.viewZ));
                probes
                  .element(b)
                  .get('aux')
                  .assign(vec4(qx.toFloat(), qy.toFloat(), float(1), deltaFlag(qx, qy)));
                tileAdaptive
                  .element(tid.mul(int(PROBE_ADAPTIVE_PER_TILE)).add(q))
                  .assign(idx);
              });
            });
          });
        });
      });
    })()
      .compute(uniformCount)
      .setName('Probe placement');

    // ------------------------------------------------------- 2. far-field read
    // The far field is a property of the probe, not of one of its 64 directions:
    // every texel that declines to keep tracing wants the same cache value. Doing
    // it here instead of inside the trace is a straight 64x on the most expensive
    // call in the chain -- a 32-surfel gather with a four-moment visibility solve
    // per surfel. This one change is the difference between 7 fps and playable.
    const farReader = wgslFn(
      /* wgsl */ `
      fn compute(
        camPos: vec3f,
        gridOrigin: vec3f,
        momentsRead: u32,
        occParams: vec4f,
        probeCur: u32,
      ) -> void {
        let i = instanceIndex;
        if (i >= ${maxProbes}u) { return; }
        let slot = i + probeCur;
        let pr = probes.value[slot];
        if (pr.pos.w < 0.5) { return; }
        let s = probeSurfelCache(
          pr.pos.xyz, normalize(pr.normal.xyz), camPos, gridOrigin, momentsRead, occParams
        );
        probes.value[slot].far = vec4f(s.colour, s.weight);
      }
    `,
      [
        consts,
        probeConsts,
        probeSurfelCache,
        probeGridHelpers,
        probeRadiusEpsilon,
        surfelsRO,
        momentsRO,
        offsetsAndListRO,
        touchedBuffer,
        surfelDepthRO,
        probes,
      ],
    );

    farNode = farReader({
      camPos: U_CAM_POS,
      gridOrigin: U_GRID_ORIGIN,
      momentsRead: U_MOMENTS_READ,
      occParams: U_OCCLUSION_PARAMS,
      probeCur: U_PROBE_CUR,
    })
      .compute(maxProbes)
      .setName('Probe far field');

    // --------------------------------------------------------------- 3. trace
    const tracer = wgslFn(
      /* wgsl */ `
      fn compute(
        diffuseTex: texture_2d_array<f32>,
        diffuseTexSampler: sampler,
        envTexture: texture_2d<f32>,
        envSampler: sampler,
        envIntensity: f32,
        envLod: f32,
        frame: u32,
        lightDir: vec3f,
        lightColor: vec3f,
        camPos: vec3f,
        gridOrigin: vec3f,
        momentsRead: u32,
        occParams: vec4f,
        nearField: f32,
        temporalAlpha: f32,
        planeEps: f32,
        prevViewProj: mat4x4f,
        probeCur: u32,
        probePrev: u32,
        radCur: u32,
        radPrev: u32,
        historyValid: f32,
        albedoBoost: f32,
        dynTrace: f32,
        dynBounds: vec4f,
        traceStride: u32,
        reprojFlipY: f32,
        ageMax: f32,
      ) -> void {
        let tid = instanceIndex;
        let probeIdx = tid / PROBE_TEXELS;
        let texel = tid % PROBE_TEXELS;
        if (probeIdx >= ${maxProbes}u) { return; }

        let outIdx = probeIdx * PROBE_TEXELS + texel + radCur;
        let pr = probes.value[probeIdx + probeCur];
        if (pr.pos.w < 0.5) {
          probeRadiance.value[outIdx] = vec4f(0.0, 0.0, 0.0, 0.0);
          return;
        }

        let P = pr.pos.xyz;
        let N = normalize(pr.normal.xyz);
        let basis = probeTangentBasis(N);

        // Temporal reprojection, resolved before the trace rather than after it,
        // because it is also what decides whether this texel needs tracing at all.
        // Where last frame's probe grid held a probe on the same plane facing the
        // same way, this texel's history is that probe's same texel -- the basis is
        // a deterministic function of the normal, so agreeing normals mean agreeing
        // directions.
        // hist.w carries whichever of two meanings ageMax selects: zero keeps the
        // shipping 0/1 valid flag, anything else makes it a count of frames already
        // folded into hist.xyz. conf is the reprojection test's answer, likewise
        // either 0/1 or a weight -- see the accept branch below.
        var hist = vec4f(0.0);
        var conf = 0.0;
        if (historyValid > 0.5) {
          let clip = prevViewProj * vec4f(P, 1.0);
          if (clip.w > 1e-6) {
            let ndc = clip.xyz / clip.w;
            // NDC y points up; this buffer's rows count down from the top. Every other
            // stage in this pass gets from one to the other through three.js's
            // getViewPosition, which reads uv.y as 1 - (ndc.y * 0.5 + 0.5) under the
            // WebGPU coordinate system. Inverting it without that term does not fail
            // loudly -- it mirrors the lookup about the screen's centreline, so a probe
            // reads the history of whatever sits the same distance the other side of the
            // horizon. On a wall that spans the mirror the plane and normal tests
            // *accept* it, which is why the result was shimmer rather than a black frame.
            // ?probeReproj=0 restores the mirrored lookup; it is the ablation the
            // flicker numbers are quoted against.
            let flat = ndc.xy * 0.5 + 0.5;
            let suv = vec2f(flat.x, select(flat.y, 1.0 - flat.y, reprojFlipY > 0.5));
            if (suv.x >= 0.0 && suv.x < 1.0 && suv.y >= 0.0 && suv.y < 1.0) {
              let ppx = suv * vec2f(${width}.0, ${height}.0);
              let ptx = u32(ppx.x) / PROBE_TILE;
              let pty = u32(ppx.y) / PROBE_TILE;
              if (ptx < ${tilesX}u && pty < ${tilesY}u) {
                let pIdx = pty * ${tilesX}u + ptx;
                let pp = probes.value[pIdx + probePrev];
                if (pp.pos.w > 0.5) {
                  let pn = normalize(pp.normal.xyz);
                  let nd = dot(pn, N);
                  let offPlane = abs(dot(P - pp.pos.xyz, pn));
                  if (ageMax > 0.5) {
                    // The same two quantities, read as a weight instead of a verdict.
                    //
                    // The thresholds are unchanged -- confidence still reaches zero at
                    // exactly the cosine and the plane distance the hard test rejected
                    // at -- so nothing that used to be accepted is now refused and
                    // nothing refused is now accepted. What changes is the middle: a
                    // probe on a surface that is *moving through* the tolerance, which
                    // on a mover is most of them, keeps a fraction of its accumulated
                    // history rather than being handed a cliff to fall off.
                    conf = smoothstep(0.9, 1.0, nd) * (1.0 - smoothstep(0.0, planeEps, offPlane));
                    hist = probeRadiance.value[pIdx * PROBE_TEXELS + texel + radPrev];
                  } else if (nd > 0.9 && offPlane < planeEps) {
                    conf = 1.0;
                    hist = probeRadiance.value[pIdx * PROBE_TEXELS + texel + radPrev];
                  }
                }
              }
            }
          }
        }

        // Amortisation, and the single reason this pass is affordable.
        //
        // A software BVH traversal carries a 60-entry stack; two of them (static
        // plus dynamic) do not fit in the register budget and the shader spills to
        // local memory. Measured on this scene: 121 fps tracing the static BVH
        // alone, 21 fps with the dynamic traversal merely compiled in, 4 fps with
        // it live. The per-ray cost is what it is, so the lever is how many rays a
        // frame casts -- a texel with valid history keeps it and waits its turn.
        // A texel with no history is traced regardless, so a camera cut or a
        // disocclusion is filled immediately rather than a stride later.
        let doTrace = (texel % traceStride) == (frame % traceStride);
        // Confidence scales the accumulated count rather than gating it. Under the
        // flag semantics the two are the same number -- hist.w is 1 exactly when
        // conf is 1, and 0 otherwise -- so the 0.5 test still reads as "has history"
        // either way, and a texel whose history is only half trusted carries half a
        // window forward instead of the whole thing or none of it.
        let ageIn = select(hist.w, min(hist.w * conf, ageMax), ageMax > 0.5);
        if (!doTrace && ageIn > 0.5) {
          probeRadiance.value[outIdx] = select(hist, vec4f(hist.xyz, ageIn), ageMax > 0.5);
          return;
        }

        // Jittered inside the oct cell, so 64 texels integrate the whole
        // hemisphere over a handful of frames instead of 64 fixed directions
        // for ever. The temporal blend below is what turns that into signal.
        let jit = probeJitter(probeIdx, texel, frame);
        let cell = vec2f(f32(texel % PROBE_OCT), f32(texel / PROBE_OCT));
        let uv = (cell + jit) / PROBE_OCT_F;
        let dirLocal = hemiOctSquareDecode(uv);
        let dir = basis * dirLocal;

        let sRad = probe_surfel_radius_for_pos(P - camPos);
        let eps = probeRadiusEpsilon(sRad);

        var ray: Ray;
        ray.origin = P + N * eps;
        ray.direction = dir;
        // Both structures, nearest hit wins. A probe that traced the static BVH
        // alone would be blind to every mover in the scene -- no contact darkening
        // under one, no bounce off one -- which is exactly the failure the dynamic
        // tracing work landed to remove.
        let hit = traceScene(ray, dynTrace, dynBounds);

        var Li = probeRayRadiance(
          ray, hit, eps, nearField, pr.far,
          diffuseTex, diffuseTexSampler, envTexture, envSampler, envIntensity, envLod,
          lightDir, lightColor, camPos, gridOrigin, momentsRead, occParams,
          albedoBoost, dynTrace, dynBounds
        );

        // The dynamic term, as a signed difference.
        //
        // A probe standing on a baked static must not report the radiance arriving at
        // it — the lightmap already carries that, and adding it again doubles the
        // room. What it must report is what *changed* because movable geometry is in
        // the world, and that quantity is two-sided: a mover tints a nearby wall with
        // its own colour and, more importantly, blocks the wall's view of everything
        // behind it. The blocking half is the one that reads as an object standing in
        // the room rather than pasted over it, and no additive-only term can express
        // it, which is why this is a subtraction rather than a second gather.
        //
        // The static half re-traces only when the ray actually entered the movers'
        // bounds. Everywhere else the same hit is reused and the two calls differ by
        // one shadow ray — which still matters, because a static surface the mover
        // shadows from the sun bounces less light even though the mover is nowhere
        // near the ray that found it. That is the indirect shadow, and skipping the
        // second shadow ray is exactly how it would go missing.
        if (pr.aux.w > 0.5) {
          var hitS = hit;
          if (dynTrace > 0.5 && dynBoundsHit(ray, dynBounds)) {
            hitS = traceScene(ray, 0.0, dynBounds);
          }
          let LiS = probeRayRadiance(
            ray, hitS, eps, nearField, pr.far,
            diffuseTex, diffuseTexSampler, envTexture, envSampler, envIntensity, envLod,
            lightDir, lightColor, camPos, gridOrigin, momentsRead, occParams,
            albedoBoost, 0.0, dynBounds
          );
          Li = Li - LiS;
        }

        var outVal = vec4f(Li, 1.0);
        if (ageMax > 0.5) {
          // A running average with a floor under it. 1/(n+1) is the weight that makes
          // n+1 samples their own mean, so the first sample after a disocclusion is
          // taken whole, the second at a half, the third at a third -- instead of the
          // shipping pair of a raw sample at full strength followed by a 6%
          // correction, which is the step the flicker measurement sees. temporalAlpha
          // is the floor: once the count saturates the window stops growing, so
          // genuine change is still tracked rather than averaged away.
          let a = select(1.0, max(temporalAlpha, 1.0 / (ageIn + 1.0)), ageIn > 0.0);
          outVal = vec4f(mix(hist.xyz, Li, clamp(a, 0.0, 1.0)), min(ageIn + 1.0, ageMax));
        } else if (hist.w > 0.5 && temporalAlpha < 1.0) {
          outVal = vec4f(mix(hist.xyz, Li, temporalAlpha), 1.0);
        }

        probeRadiance.value[outIdx] = outVal;
      }
    `,
      [
        bvhConstants,
        consts,
        probeConsts,
        rayStruct,
        intersectionResultStruct,
        sceneHitStruct,
        bvhIntersectFirstHit,
        dynBvhIntersectFirstHit,
        dynBoundsHit,
        getVertexAttribute,
        getDynVertexAttribute,
        traceScene,
        traceSceneOccluded,
        probeTangentBasis,
        probeJitter,
        hemiOctSquareDecode,
        probeSampleEnv,
        probeSampleDiffuse,
        probeSurfelCacheRO,
        probeRayRadiance,
        probeGridHelpers,
        probeRadiusEpsilon,
        // Fourteen storage buffers, which is the WebGPU per-stage maximum: eight
        // for the two acceleration structures, four for the surfel cache, two for
        // the probes themselves. The keep-alive atomic would be the fifteenth and
        // is done once per probe by the far-field pass instead.
        bvh.bvhNode,
        bvh.positionNode,
        bvh.indexNode,
        bvh.colorNode,
        dynBvh.bvhNode,
        dynBvh.positionNode,
        dynBvh.indexNode,
        dynBvh.colorNode,
        surfelsRO,
        momentsRO,
        offsetsAndListRO,
        surfelDepthRO,
        probesRO,
        radiance,
      ],
    );

    traceNode = tracer({
      diffuseTex: texture(bvh.diffuseArrayTex),
      diffuseTexSampler: sampler(bvh.diffuseArrayTex),
      envTexture: texture(env),
      envSampler: sampler(env),
      envIntensity: U_ENV_INTENSITY,
      envLod: U_ENV_LOD,
      frame: U_FRAME,
      lightDir: U_LIGHT_DIR,
      lightColor: U_LIGHT_COLOR,
      camPos: U_CAM_POS,
      gridOrigin: U_GRID_ORIGIN,
      momentsRead: U_MOMENTS_READ,
      occParams: U_OCCLUSION_PARAMS,
      nearField: U_NEAR_FIELD,
      temporalAlpha: U_TEMPORAL,
      planeEps: U_PLANE_EPS,
      prevViewProj: U_PREV_VIEW_PROJ,
      probeCur: U_PROBE_CUR,
      probePrev: U_PROBE_PREV,
      radCur: U_RAD_CUR,
      radPrev: U_RAD_PREV,
      historyValid: U_HISTORY_VALID,
      albedoBoost: U_ALBEDO_BOOST,
      dynTrace: U_DYN_TRACE,
      dynBounds: dynBvh.influence,
      traceStride: U_TRACE_STRIDE,
      reprojFlipY: U_REPROJ_FLIP,
      ageMax: U_AGE_MAX,
    })
      .compute(maxProbes * PROBE_TEXELS)
      .setName('Probe trace');

    // ------------------------------------------------------ 4. octahedral -> SH
    // 64 texture fetches per probe per pixel is not a gather anyone can afford,
    // so the directional part collapses to four coefficients here, once per
    // probe, and the per-pixel step becomes four loads and a dot product. This is
    // what Lumen's ConvertToIrradiance step is for.
    shNode = Fn(() => {
      const pid = int(instanceIndex);
      const pr = probesRO.element(pid.add(int(U_PROBE_CUR)));
      const valid = pr.get('pos').w.greaterThan(0.5);

      const c0 = vec3(0).toVar();
      const c1 = vec3(0).toVar();
      const c2 = vec3(0).toVar();
      const c3 = vec3(0).toVar();

      If(valid, () => {
        const n = pr.get('normal').xyz.normalize();
        const { t, b } = tangentBasis(n);
        Loop({ start: int(0), end: int(PROBE_TEXELS), type: 'int', name: 'k' }, ({ k }) => {
          const cx = k.mod(int(PROBE_OCT)).toFloat();
          const cy = k.div(int(PROBE_OCT)).toFloat();
          const uv = vec2(
            cx.add(0.5).div(float(PROBE_OCT)),
            cy.add(0.5).div(float(PROBE_OCT)),
          );
          const dl = octDecode(uv);
          const dw = t.mul(dl.x).add(b.mul(dl.y)).add(n.mul(dl.z));
          const dOmega = octJacobian(uv).div(float(PROBE_TEXELS));
          const L = radianceRO
            .element(pid.mul(int(PROBE_TEXELS)).add(k).add(int(U_RAD_CUR)))
            .xyz.mul(dOmega);
          c0.addAssign(L.mul(0.282095));
          c1.addAssign(L.mul(dw.y.mul(0.488603)));
          c2.addAssign(L.mul(dw.z.mul(0.488603)));
          c3.addAssign(L.mul(dw.x.mul(0.488603)));
        });
      });

      const base = pid.mul(int(4));
      shRaw.element(base).assign(vec4(c0, valid.select(float(1), float(0))));
      shRaw.element(base.add(int(1))).assign(vec4(c1, float(0)));
      shRaw.element(base.add(int(2))).assign(vec4(c2, float(0)));
      shRaw.element(base.add(int(3))).assign(vec4(c3, float(0)));
    })()
      .compute(maxProbes)
      .setName('Probe SH');

    // ------------------------------------------------------- 5. spatial filter
    filterNode = Fn(() => {
      const pid = int(instanceIndex);
      const pr = probesRO.element(pid.add(int(U_PROBE_CUR)));
      const valid = pr.get('pos').w.greaterThan(0.5);
      const base = pid.mul(int(4));

      // Adaptive probes have no grid neighbours to speak of -- they exist
      // precisely because their neighbourhood disagrees with them -- so they pass
      // through untouched.
      const doFilter = valid
        .and(pid.lessThan(int(uniformCount)))
        .and(U_FILTER.greaterThan(0.5));

      If(doFilter.not(), () => {
        Loop({ start: int(0), end: int(4), type: 'int', name: 'k' }, ({ k }) => {
          shOut.element(base.add(k)).assign(shRawRO.element(base.add(k)));
        });
      }).Else(() => {
        const P = pr.get('pos').xyz;
        const N = pr.get('normal').xyz.normalize();
        const tx = pid.mod(int(tilesX));
        const ty = pid.div(int(tilesX));

        const a0 = vec3(0).toVar();
        const a1 = vec3(0).toVar();
        const a2 = vec3(0).toVar();
        const a3 = vec3(0).toVar();
        const cnt = float(0).toVar();

        // 5x5, not 3x3. A probe's estimate is 64 rays wide and its variance shows
        // up as probe-sized mottling on a flat wall; nine taps is not enough to
        // bury it. The outer ring is Gaussian-weighted rather than boxed, so the
        // extra reach costs reconstruction detail roughly in proportion to what it
        // buys — a box 5x5 blurs contact shading into nothing.
        Loop({ start: int(0), end: int(25), type: 'int', name: 'k' }, ({ k }) => {
          const dx = k.mod(int(5)).sub(int(2));
          const dy = k.div(int(5)).sub(int(2));
          const nx = tx.add(dx);
          const ny = ty.add(dy);
          If(
            nx
              .greaterThanEqual(int(0))
              .and(nx.lessThan(int(tilesX)))
              .and(ny.greaterThanEqual(int(0)))
              .and(ny.lessThan(int(tilesY))),
            () => {
              const j = ny.mul(int(tilesX)).add(nx);
              const pj = probesRO.element(j.add(int(U_PROBE_CUR)));
              // A delta probe and a full-radiance probe hold different quantities in
              // the same units. Averaging them would push a mover's whole gather into
              // the difference its neighbour on the wall reports, which reads as a
              // bright fringe hugging every silhouette — so they are simply different
              // signals and never each other's neighbours.
              const sameKind = pj
                .get('aux')
                .w.sub(pr.get('aux').w)
                .abs()
                .lessThan(float(0.5));
              If(pj.get('pos').w.greaterThan(0.5).and(sameKind), () => {
                const nj = pj.get('normal').xyz.normalize();
                // Same rejection the lightmap denoiser uses, ramped rather than
                // binary: same facing, same plane. Anything else is a different
                // surface and averaging it in is how light leaks through a wall.
                const wPlane = clamp(
                  float(1).sub(pj.get('pos').xyz.sub(P).dot(N).abs().div(U_PLANE_EPS)),
                  float(0),
                  float(1),
                );
                const wNormal = clamp(
                  nj.dot(N).sub(U_NORMAL_THRESHOLD).div(float(1).sub(U_NORMAL_THRESHOLD)),
                  float(0),
                  float(1),
                );
                const r2 = dx.mul(dx).add(dy.mul(dy)).toFloat();
                const w = r2.mul(-0.5).exp().mul(wPlane).mul(wNormal);
                If(w.greaterThan(float(0)), () => {
                  const jb = j.mul(int(4));
                  a0.addAssign(shRawRO.element(jb).xyz.mul(w));
                  a1.addAssign(shRawRO.element(jb.add(int(1))).xyz.mul(w));
                  a2.addAssign(shRawRO.element(jb.add(int(2))).xyz.mul(w));
                  a3.addAssign(shRawRO.element(jb.add(int(3))).xyz.mul(w));
                  cnt.addAssign(w);
                });
              });
            },
          );
        });

        const inv = float(1).div(max(float(1e-4), cnt));
        shOut.element(base).assign(vec4(a0.mul(inv), float(1)));
        shOut.element(base.add(int(1))).assign(vec4(a1.mul(inv), float(0)));
        shOut.element(base.add(int(2))).assign(vec4(a2.mul(inv), float(0)));
        shOut.element(base.add(int(3))).assign(vec4(a3.mul(inv), float(0)));
      });
    })()
      .compute(maxProbes)
      .setName('Probe filter');

    // ------------------------------------------------------------ 6. integrate
    /** Last resort: the old per-pixel surfel gather, geometry-weighted only. */
    const surfelFallback = (worldPos, pixNormal) => {
      const pRel = worldPos.sub(U_GRID_ORIGIN);
      const cellIdx = surfel_grid_c4_to_hash(
        surfel_grid_coord_to_c4(surfel_pos_to_grid_coord(pRel)),
      ).toInt();
      const start = offsetsAndListRO.element(cellIdx);
      const end = offsetsAndListRO.element(cellIdx.add(int(1)));
      const capped = min(int(32), end.sub(start).max(int(0)));

      const light = vec3(0).toVar();
      const weight = float(0).toVar();
      Loop({ start: int(0), end: capped, type: 'int', name: 'k' }, ({ k }) => {
        const sid = offsetsAndListRO.element(
          int(OFFSETS_AND_LIST_START).add(start).add(k),
        );
        If(sid.greaterThanEqual(int(0)).and(sid.lessThan(int(capacity))), () => {
          const s = surfelsRO.element(sid);
          const sPos = s.get('posb').xyz;
          const sNor = s.get('normal');
          const sRad = surfel_radius_for_pos(sPos, U_CAM_POS).mul(SURFEL_RADIUS_OVERSCALE);
          const dV = worldPos.sub(sPos);
          const squish = float(1).add(
            dotNode(dV, sNor).abs().mul(SURFEL_NORMAL_DIRECTION_SQUISH),
          );
          const w = smoothstep(sRad, float(0), dV.length().mul(squish)).mul(
            max(float(0), dotNode(sNor, pixNormal)),
          );
          const irr = momentsRO
            .element(uint(sid).add(uint(U_MOMENTS_READ)))
            .get('irradiance').xyz;
          light.addAssign(irr.mul(w));
          weight.addAssign(w);
        });
      });
      return vec4(light.div(max(float(1e-5), weight)), weight);
    };

    resolveNode = Fn(() => {
      const tid = int(instanceIndex);
      const x = tid.mod(int(width));
      const y = tid.div(int(width));
      const uv = vec2(
        x.toFloat().add(0.5).div(float(width)),
        y.toFloat().add(0.5).div(float(height)),
      );

      const depth = texture(texDepth, uv).r;
      const valid = depth.lessThan(0.999).and(depth.greaterThan(0.0));
      const outColor = vec4(0).toVar();

      If(valid, () => {
        const N = texture(texNormal, uv).xyz.mul(2.0).sub(1.0).normalize();
        const viewPos = getViewPosition(uv, depth, U_PROJ_INV);
        const P = U_CAM_WORLD.mul(vec4(viewPos, 1.0)).xyz;
        // Recomputed here rather than carried, because the resolve runs per pixel and
        // the probes are per tile: a pixel next to a mover's silhouette must be able to
        // disagree with the probe at its tile centre about which side of it it is on.
        const pixDelta = deltaFlag(x, y);
        const isDelta = pixDelta.greaterThan(float(0.5));

        const s0 = vec3(0).toVar();
        const s1 = vec3(0).toVar();
        const s2 = vec3(0).toVar();
        const s3 = vec3(0).toVar();
        const wsum = float(0).toVar();
        // A second, geometry-blind accumulator. A pixel whose four tile corners
        // all fail the plane test would otherwise resolve to black, which is the
        // exact failure mode being fixed -- so the bilinear weights alone are
        // kept as a floor.
        const r0 = vec3(0).toVar();
        const r1 = vec3(0).toVar();
        const r2 = vec3(0).toVar();
        const r3 = vec3(0).toVar();
        const rsum = float(0).toVar();

        const fx = x.toFloat().add(0.5).div(float(PROBE_TILE)).sub(0.5);
        const fy = y.toFloat().add(0.5).div(float(PROBE_TILE)).sub(0.5);
        const bx = floor(fx);
        const by = floor(fy);
        const frx = fx.sub(bx);
        const fry = fy.sub(by);

        const gather = (j) => {
          const jb = j.mul(int(4));
          const g0 = shOutRO.element(jb).xyz;
          const g1 = shOutRO.element(jb.add(int(1))).xyz;
          const g2 = shOutRO.element(jb.add(int(2))).xyz;
          const g3 = shOutRO.element(jb.add(int(3))).xyz;
          return { g0, g1, g2, g3 };
        };

        /**
         * How much a probe is allowed to speak for this pixel, as a number that
         * varies smoothly rather than a yes/no.
         *
         * A hard `planeD < eps` test is what produces tile-shaped staircases along
         * every silhouette: the *weights* are continuous in screen position but the
         * accepted *set* changes the instant the tile index does, so the result
         * jumps at every tile boundary. Ramping the same two tests to zero instead
         * makes the whole reconstruction continuous, and costs two divides.
         */
        /**
         * A pixel may only be spoken for by probes holding the same quantity it does.
         *
         * Without this a wall pixel one tile away from a mover reconstructs partly
         * from the mover's own probe, whose SH is a full room gather rather than a
         * difference — a bright halo that follows the object around and is worse than
         * the missing shadow it was meant to fix.
         */
        const kindMatches = (pj) =>
          pj.get('aux').w.sub(pixDelta).abs().lessThan(float(0.5));

        const bilateral = (pj, g, wb) => {
          const nj = pj.get('normal').xyz.normalize();
          const nd = nj.dot(N);
          const planeD = pj.get('pos').xyz.sub(P).dot(nj).abs();
          const wPlane = clamp(
            float(1).sub(planeD.div(U_PLANE_EPS)),
            float(0),
            float(1),
          );
          const wNormal = clamp(
            nd.sub(U_NORMAL_THRESHOLD).div(float(1).sub(U_NORMAL_THRESHOLD)),
            float(0),
            float(1),
          );
          const w = wb.mul(wPlane).mul(wNormal);
          If(w.greaterThan(float(0)), () => {
            s0.addAssign(g.g0.mul(w));
            s1.addAssign(g.g1.mul(w));
            s2.addAssign(g.g2.mul(w));
            s3.addAssign(g.g3.mul(w));
            wsum.addAssign(w);
          });
        };

        Loop({ start: int(0), end: int(4), type: 'int', name: 'k' }, ({ k }) => {
          const ox = k.mod(int(2));
          const oy = k.div(int(2));
          const tx = clamp(bx.toInt().add(ox), int(0), int(tilesX - 1));
          const ty = clamp(by.toInt().add(oy), int(0), int(tilesY - 1));
          const wb = ox
            .equal(int(0))
            .select(float(1).sub(frx), frx)
            .mul(oy.equal(int(0)).select(float(1).sub(fry), fry));

          const j = ty.mul(int(tilesX)).add(tx);
          const pj = probesRO.element(j.add(int(U_PROBE_CUR)));
          If(pj.get('pos').w.greaterThan(0.5).and(kindMatches(pj)), () => {
            const g = gather(j);
            r0.addAssign(g.g0.mul(wb));
            r1.addAssign(g.g1.mul(wb));
            r2.addAssign(g.g2.mul(wb));
            r3.addAssign(g.g3.mul(wb));
            rsum.addAssign(wb);
            bilateral(pj, g, wb);
          });

          // The same tile's adaptive probes, gathered inside the bilinear
          // footprint rather than from the pixel's own tile alone. Weighting them
          // by screen proximity to the pixel put a hard tile boundary back into an
          // otherwise continuous reconstruction; borrowing the corner's bilinear
          // weight keeps them continuous, and the bilateral ramp above is already
          // what decides whether they are the right probes at all.
          Loop(
            { start: int(0), end: int(PROBE_ADAPTIVE_PER_TILE), type: 'int', name: 'a' },
            ({ a }) => {
              const ai = tileAdaptiveRO.element(
                j.mul(int(PROBE_ADAPTIVE_PER_TILE)).add(a),
              );
              If(ai.greaterThanEqual(int(0)), () => {
                const pa = probesRO.element(ai.add(int(U_PROBE_CUR)));
                If(pa.get('pos').w.greaterThan(0.5).and(kindMatches(pa)), () => {
                  bilateral(pa, gather(ai), wb);
                });
              });
            },
          );
        });

        const useMain = wsum.greaterThan(float(1e-4));
        const useRelax = rsum.greaterThan(float(1e-4));
        const inv = float(1).div(max(float(1e-5), wsum));
        const invR = float(1).div(max(float(1e-5), rsum));

        const c0 = useMain.select(s0.mul(inv), r0.mul(invR));
        const c1 = useMain.select(s1.mul(inv), r1.mul(invR));
        const c2 = useMain.select(s2.mul(inv), r2.mul(invR));
        const c3 = useMain.select(s3.mul(inv), r3.mul(invR));

        outColor.assign(vec4(evalSH(c0, c1, c2, c3, N, isDelta), float(1)));

        // Nothing on screen could speak for this pixel at all. Rather than the
        // cell-shaped black patch the old resolve produced, read the world-space
        // cache directly -- worst case it is slightly leaked light, which is the
        // better failure by a wide margin.
        //
        // Except for a delta pixel, where that reasoning inverts. The cache holds a
        // radiance, not a difference, so handing it to a lightmapped surface adds the
        // room's whole indirect term a second time — over exactly the pixels the
        // reconstruction already admits it knows nothing about. Zero is the honest
        // answer there: no probe could see it, so no mover changed it.
        If(useMain.or(useRelax).not().and(isDelta.not()), () => {
          const fb = surfelFallback(P, N);
          outColor.assign(vec4(fb.xyz, float(1)));
        });

        // After the fallback, deliberately: the fallback is the world-space cache read
        // straight, which is the *least* contact-aware estimate in the whole chain and
        // therefore the one that most needs this. Applied to the irradiance rather than
        // to the composite, because that is what makes it indirect-only — direct sun
        // already has a shadow map and must not be occluded twice.
        outColor.assign(
          vec4(
            outColor.xyz.mul(shortRangeAO(x, y, P, N, viewPos.z)),
            outColor.w,
          ),
        );
      });

      textureStore(outputTexture!, ivec2(x, y), outColor);
    })()
      .compute(width * height)
      .setName('Probe integrate');

    // ---------------------------------------------------------------- 7. debug
    debugNode = Fn(() => {
      const tid = int(instanceIndex);
      const x = tid.mod(int(width));
      const y = tid.div(int(width));
      const tx = clamp(x.div(int(PROBE_TILE)), int(0), int(tilesX - 1));
      const ty = clamp(y.div(int(PROBE_TILE)), int(0), int(tilesY - 1));
      const j = ty.mul(int(tilesX)).add(tx);
      const pj = probesRO.element(j.add(int(U_PROBE_CUR)));

      const col = vec3(0).toVar();
      If(pj.get('pos').w.greaterThan(0.5), () => {
        col.assign(pj.get('normal').xyz.mul(0.5).add(0.5).mul(0.55));
      }).Else(() => {
        // Magenta: a tile the G-Buffer gave nothing to place a probe on.
        col.assign(vec3(0.5, 0.0, 0.35));
      });

      // Tile grid, then the probe itself on top of it.
      const onGrid = x.mod(int(PROBE_TILE)).equal(int(0)).or(y.mod(int(PROBE_TILE)).equal(int(0)));
      If(onGrid, () => {
        col.mulAssign(0.45);
      });

      const cx = min(tx.mul(int(PROBE_TILE)).add(int(PROBE_TILE >> 1)), int(width - 1));
      const cy = min(ty.mul(int(PROBE_TILE)).add(int(PROBE_TILE >> 1)), int(height - 1));
      If(
        x.sub(cx).abs().lessThan(int(2)).and(y.sub(cy).abs().lessThan(int(2))),
        () => {
          col.assign(
            pj.get('pos').w.greaterThan(0.5).select(vec3(0, 1, 0), vec3(1, 0, 0)),
          );
        },
      );

      Loop({ start: int(0), end: int(PROBE_ADAPTIVE_PER_TILE), type: 'int', name: 'k' }, ({ k }) => {
        const ai = tileAdaptiveRO.element(j.mul(int(PROBE_ADAPTIVE_PER_TILE)).add(k));
        If(ai.greaterThanEqual(int(0)), () => {
          const pa = probesRO.element(ai.add(int(U_PROBE_CUR)));
          const ax = pa.get('aux').x.toInt();
          const ay = pa.get('aux').y.toInt();
          If(x.sub(ax).abs().lessThan(int(2)).and(y.sub(ay).abs().lessThan(int(2))), () => {
            col.assign(vec3(0, 0.8, 1));
          });
        });
      });

      textureStore(debugTexture!, ivec2(x, y), vec4(col, float(1)));
    })()
      .compute(width * height)
      .setName('Probe debug');

    boundGBufferKey = gbufferKey(gbuffer);
    return true;
  }

  function gbufferKey(gbuffer: { target: THREE.RenderTarget }) {
    // The mask's identity is part of the key: whether it exists decides whether the
    // placement and resolve kernels contain a delta branch at all, and that is a
    // compile-time fact about the graph rather than a uniform.
    return `${gbuffer.target.id}:${gbuffer.target.width}x${gbuffer.target.height}:${maskDepth?.id ?? 'n'}`;
  }

  /**
   * Returns true when the chain actually ran. A false means the caller should
   * keep whatever it was compositing before rather than switch to a stale or
   * never-written texture.
   */
  function run(
    renderer: THREE.WebGPURenderer,
    camera: THREE.PerspectiveCamera,
    gbuffer: { target: THREE.RenderTarget },
  ): boolean {
    if (!probeScene.bvh || !probeScene.dynBvh || !probeScene.env) return false;

    /**
     * Lightmap mode used to place probes *from* the movers-only G-Buffer, so a
     * lightmapped pixel got no probe and resolved to zero. That correctly stopped the
     * statics being lit twice, and it also made it impossible for a mover to change
     * them at all — no probe, no ray, no indirect shadow. Placement now runs off the
     * full G-Buffer in both modes and the movers-only draw survives only as a mask;
     * what keeps the statics from being double-lit is that their probes report a
     * difference rather than a radiance, which is a property of the estimator instead
     * of a hole in the coverage.
     */
    const lightmap = probeSettings.mode === 'lightmap';
    const delta = lightmap && probeSettings.dynamicDelta;
    const movers = lightmap ? moverOnlyGBuffer(renderer, camera) : null;
    maskDepth = delta ? movers?.target.depthTexture ?? null : null;
    // `?dyndelta=0` is the old world: the movers-only buffer is not a mask, it is the
    // whole G-Buffer the tier sees, and everything outside a mover is simply absent.
    const source = lightmap && !delta ? movers ?? gbuffer : gbuffer;

    resize(source.target.width, source.target.height);
    if (!outputTexture) return false;

    if (!resolveNode || boundGBufferKey !== gbufferKey(source)) {
      discard();
      if (!build(source)) return false;
    }

    U_PROJ_INV.value.copy(camera.projectionMatrixInverse);
    U_CAM_WORLD.value.copy(camera.matrixWorld);
    U_CAM_POS.value.copy(camera.position);
    U_FRAME.value = renderer.info.frame;
    U_MOMENTS_READ.value = pool.getOffsets().writeOffset;
    snap_to_surfel_grid_origin(U_GRID_ORIGIN.value, camera.position);

    const light = probeScene.light;
    if (light) {
      U_LIGHT_DIR.value
        .subVectors(light.position, light.target.position)
        .normalize();
      U_LIGHT_COLOR.value.copy(light.color).multiplyScalar(light.intensity);
    }

    U_NEAR_FIELD.value = probeSettings.nearField;
    U_TEMPORAL.value = probeSettings.temporalAlpha;
    // Zero is the ablation, and it is the default: the kernel's `ageMax > 0.5` branches
    // collapse to the arithmetic that shipped, down to `hist.w` staying a flag.
    U_AGE_MAX.value = probeSettings.temporalAge
      ? Math.max(1, probeSettings.temporalAgeMax)
      : 0;
    U_PLANE_EPS.value = probeSettings.planeEpsilon;
    U_NORMAL_THRESHOLD.value = probeSettings.normalThreshold;
    U_ADAPTIVE.value = probeSettings.adaptive ? 1 : 0;
    U_FILTER.value = probeSettings.spatialFilter ? 1 : 0;
    U_HISTORY_VALID.value = hadHistory ? 1 : 0;
    U_TRACE_STRIDE.value = Math.max(1, Math.round(probeSettings.traceStride));
    U_REPROJ_FLIP.value = probeSettings.reprojectFlipY ? 1 : 0;
    U_AO_RADIUS.value = Math.max(1e-3, probeSettings.aoRadius);
    U_AO_BIAS.value = probeSettings.aoBias;
    // Zero is the ablation: the branch in the kernel collapses and the resolve emits
    // exactly what it emitted before this pass existed.
    U_AO_INTENSITY.value = probeSettings.shortRangeAO ? probeSettings.aoIntensity : 0;
    U_PROJ_SCALE.value = 0.5 * height * camera.projectionMatrix.elements[5];
    U_DELTA_MODE.value = delta ? 1 : 0;
    // Read every frame rather than baked in: `?dyntrace=0` is the ablation the
    // dynamic tracer is measured with, and the probes have to answer to it too.
    U_DYN_TRACE.value =
      probeSettings.dynamicTracing && (probeScene.dynBvh?.enabled.value ?? 0) > 0
        ? 1
        : 0;

    U_PROBE_CUR.value = parity * maxProbes;
    U_PROBE_PREV.value = (1 - parity) * maxProbes;
    U_RAD_CUR.value = parity * maxProbes * PROBE_TEXELS;
    U_RAD_PREV.value = (1 - parity) * maxProbes * PROBE_TEXELS;

    renderer.compute(clearNode!);
    renderer.compute(placeNode!);
    renderer.compute(farNode!);
    renderer.compute(traceNode!);
    renderer.compute(shNode!);
    renderer.compute(filterNode!);
    renderer.compute(resolveNode!);
    if (probeSettings.debug) renderer.compute(debugNode!);

    // Next frame's reprojection wants this frame's matrices and this frame's half.
    U_PREV_VIEW_PROJ.value
      .copy(camera.projectionMatrix)
      .multiply(camera.matrixWorldInverse);
    parity = 1 - parity;
    hadHistory = true;

    return true;
  }

  return {
    run,
    getOutputTexture: () => outputTexture,
    getDebugTexture: () => debugTexture,
    invalidate: () => {
      hadHistory = false;
    },
  };
}
