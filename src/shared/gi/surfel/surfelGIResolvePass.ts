// @ts-nocheck -- based on jure/webgiya, with hybrid ownership and coverage validity.
// src/surfelGIResolvePass.ts
import * as THREE from 'three/webgpu';
import {
  Fn,
  storage,
  texture,
  uniform,
  float,
  int,
  vec2,
  vec3,
  vec4,
  instanceIndex,
  getViewPosition,
  Loop,
  min,
  If,
  uint,
  abs,
  dot,
  max,
  smoothstep,
  textureStore,
  ivec2,
  atomicMax,
  clamp,
  saturate,
  wgslFn,
} from 'three/tsl';
import { SurfelMoments, SurfelStruct, type SurfelPool } from './surfelPool';
import { bindSurfelAnchors } from './surfelAnchors';
import {
  snap_to_surfel_grid_origin,
  surfel_grid_c4_to_hash,
  surfel_grid_coord_to_c4,
  surfel_pos_to_grid_coord,
  surfel_radius_for_pos,
  type SurfelHashGrid,
} from './surfelHashGrid';
import {
  FADE_FRAMES,
  OFFSETS_AND_LIST_START,
  RESOLVE_CELL_SCAN_CAP,
  RESOLVE_FETCH_CAP,
  SURFEL_IMPORTANCE_DIRECT_MAX,
  SURFEL_IMPORTANCE_INDIRECT_MAX,
  SURFEL_NORMAL_DIRECTION_SQUISH,
  SURFEL_RADIUS_OVERSCALE,
  TARGET_SAMPLE_COUNT,
} from './constants';
import { giKnobs } from './knobs';
import {
  surfelRadialDepthOcclusion,
  U_OCCLUSION_PARAMS,
} from './surfelRadialDepth';
import { radiusBasedEpsilon } from './surfelIntegratePass';

// @ts-ignore Fn is mistyped
export const resolveIrradiance = Fn(
  ({
    sid,
    worldPos,
    pixNormal,
    surfels,
    moments,
    U_FRAME,
    U_MOMENTS_OFFSET,
    U_CAM_POS,
    U_OCCLUSION_PARAMS,
    surfelDepth,
    freshWeight = float(0),
  }) => {
    const s = surfels.element(sid);
    const sPos = s.get('posb').xyz;
    const sNor = s.get('normal');
    let momentsIndex = uint(sid).add(uint(U_MOMENTS_OFFSET));

    // birth frame from posb.w
    const birthFrame = s.get('posb').w;
    const sinceBirth = float(U_FRAME).sub(birthFrame);

    let m = moments.element(momentsIndex);
    let sIrr = m.get('irradiance').xyz;
    const samples = m.get('irradiance').w;

    const sRad = surfel_radius_for_pos(sPos, U_CAM_POS).mul(
      SURFEL_RADIUS_OVERSCALE,
    );
    const eps = radiusBasedEpsilon(sRad);
    const sPosWithOffset = sPos.add(sNor.mul(eps));
    const dV = worldPos.sub(sPosWithOffset);
    const distLen = dV.length();

    // Directional weight (Surfel normal vs Pixel normal)
    // Indirect light generally flows along the normal
    const weightDir = max(float(0.0), dot(sNor, pixNormal));

    // Spatial weight (Mahalanobis distance squished by normal)
    const dotN = abs(dot(dV, sNor));
    const squishFactor = float(1.0).add(
      dotN.mul(SURFEL_NORMAL_DIRECTION_SQUISH),
    );
    const mahalanobisDist = distLen.mul(squishFactor);

    // Smooth falloff
    const weightGeom = smoothstep(sRad, float(0.0), mahalanobisDist);
    const wFinal = weightGeom.mul(weightDir).toVar();

    // TODO: Tweak
    // Integration precedes gather, so a newborn already carries a real sample.
    // Give it a low, nonzero relative weight on moving receivers; zero would
    // discard all illumination on a newly exposed surface for its first frame.
    const fade = saturate(sinceBirth.div(float(FADE_FRAMES))).max(freshWeight);
    const conf = saturate(samples.div(float(TARGET_SAMPLE_COUNT))); //(or some smaller target)
    wFinal.mulAssign(fade.mul(conf));

    // ----------------------------------------------------------
    // [RADIAL DEPTH] Occlusion gate (prevents cross-surface leaks)
    // direction is from surfel -> shaded point
    // ----------------------------------------------------------
    If(wFinal.greaterThan(float(0.0)), () => {
      const dirWS = dV.div(max(float(1e-6), distLen));
      const occ = surfelRadialDepthOcclusion({
        surfelIndex: uint(sid),
        dirWS: dirWS,
        normalWS: sNor,
        dist: distLen,
        pixelNormal: pixNormal,
        sRad: sRad,
        dV: dV,
        params: U_OCCLUSION_PARAMS,
      });

      wFinal.mulAssign(occ);
    });

    return vec4(sIrr.xyz.mul(wFinal), wFinal);
  },
);

/**
 * Hash-grid final gather. Hybrid skips baked receivers and pinned samples;
 * FindMissing shares the same spatial, directional and visibility weights.
 * Alpha distinguishes missing coverage from valid dark illumination.
 */
export function createSurfelGIResolvePass(
  grid: SurfelHashGrid,
  pool: SurfelPool,
) {
  // Output Texture (RGBA16F)
  let outputTexture: THREE.Texture | null = null;
  let activeTexture: THREE.Texture | null = null;

  // Uniforms
  const U_PROJ_INV = uniform(new THREE.Matrix4());
  const U_CAM_WORLD = uniform(new THREE.Matrix4());
  const U_CAM_POS = uniform(new THREE.Vector3());
  const U_RESOLVE_OFFSET = uniform(0);
  const U_FRAME = uniform(0);
  /**
   * 1 while the lightmap owns the statics, so the gather drops pinned atlas surfels.
   * Set per frame from the pinned atlas state; 0 is upstream's behaviour, in which
   * every surfel in the cell counts and there are no pinned ones to worry about.
   */
  const U_SKIP_PINNED = uniform(0);
  // @important 1 drops rigid receivers from the gather. GI normal alpha is 1 for baked, 0 for unbound and a negative receiver id for rigid, so movers are the negative half.
  const U_SKIP_RIGID = uniform(0);
  // @important 1 drops unbound receivers, whose alpha is exactly 0: baked is 1, rigid is a negative id.
  const U_SKIP_UNBOUND = uniform(0);

  const U_GRID_ORIGIN = uniform(new THREE.Vector3());

  let computeNode: THREE.ComputeNode | null = null;
  let lastAnchorAttr = null;
  /**
   * LOCAL CHANGE vs upstream: upstream's `maxFetchPerPixel = 64` is now the `?resolvecap=1`
   * path, not the default. Read once here rather than per frame because the compute graph
   * is built once and a URL does not change under it.
   */
  const maxFetchPerPixel = giKnobs.deterministicResolve()
    ? RESOLVE_CELL_SCAN_CAP
    : RESOLVE_FETCH_CAP;

  function resize(width: number, height: number) {
    if (
      !outputTexture ||
      outputTexture.image.width !== width ||
      outputTexture.image.height !== height
    ) {
      outputTexture = new THREE.StorageTexture(width, height);
      outputTexture.type = THREE.HalfFloatType;
      // @ts-ignore
      outputTexture.format = THREE.RGBAFormat;
      computeNode = null; // Rebuild compute graph on resize
    }
  }

  function run(
    renderer: THREE.WebGPURenderer,
    camera: THREE.PerspectiveCamera,
    gbuffer: { target: THREE.RenderTarget },
    options: { skipPinned?: boolean; skipRigid?: boolean; skipUnbound?: boolean } = {},
  ) {
    const width = gbuffer.target.width;
    const height = gbuffer.target.height;
    resize(width, height);

    if (!outputTexture) return;

    // Update uniforms
    U_PROJ_INV.value.copy(camera.projectionMatrixInverse);
    U_CAM_WORLD.value.copy(camera.matrixWorld);
    U_CAM_POS.value.copy(camera.position);
    U_FRAME.value = renderer.info.frame;
    U_SKIP_PINNED.value = options.skipPinned ? 1 : 0;
    U_SKIP_RIGID.value = options.skipRigid ? 1 : 0;
    U_SKIP_UNBOUND.value = options.skipUnbound ? 1 : 0;
    const { writeOffset } = pool.getOffsets();
    U_RESOLVE_OFFSET.value = writeOffset; // Because we want the fresh values

    snap_to_surfel_grid_origin(U_GRID_ORIGIN.value, camera.position);

    // Bindings
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
    )
      return;

    // Build compute shader
    if (lastAnchorAttr !== pool.getAnchorAttr()) {
      computeNode?.dispose(); computeNode = null; lastAnchorAttr = pool.getAnchorAttr();
    }
    if (!computeNode) {
      const capacity = surfelAttr.count;
      const surfels = storage(surfelAttr, SurfelStruct, capacity).setAccess(
        'readOnly',
      );
      const moments = storage(
        momentsAttr,
        SurfelMoments,
        capacity * 2,
      ).setAccess('readOnly'); // The calculated light from integration
      const anchors = bindSurfelAnchors(pool);
      const offsetsAndList = storage(
        offsetsAndListAttr,
        'int',
        offsetsAndListAttr.count,
      )
        .setAccess('readOnly')
        .setName('offsetsAndList');
      const surfelDepthBufferRO = storage(
        surfelDepthAttr,
        'vec4',
        surfelDepthAttr.count,
      )
        .setAccess('readOnly')
        .setName('surfelDepth');

      // Oook...
      const includeBuffer = wgslFn(
        /* wgsl */ `
          fn include_buffer(
          ) -> i32 {
            return 0;
          }
        `,
        [surfelDepthBufferRO],
      );

      computeNode = Fn(() => {
        const zero = includeBuffer();
        const tid = int(instanceIndex).add(zero);
        const W = int(width);

        const x = tid.mod(W);
        const y = tid.div(W);

        const uv = vec2(
          x.toFloat().add(0.5).div(float(width)),
          y.toFloat().add(0.5).div(float(height)),
        );

        // 1. Reconstruct World Position & Normal from G-Buffer
        const depth = texture(texDepth, uv).r;
        const valid = depth.lessThan(0.999).and(depth.greaterThan(0.0))
          .and(U_SKIP_PINNED.lessThan(0.5).or(texture(texNormal, uv).w.lessThan(0.5)))
          .and(U_SKIP_RIGID.lessThan(0.5).or(texture(texNormal, uv).w.greaterThanEqual(0.0)))
          .and(U_SKIP_UNBOUND.lessThan(0.5).or(texture(texNormal, uv).w.lessThan(0.0).or(texture(texNormal, uv).w.greaterThanEqual(0.5))));

        const outColor = vec4(0).toVar();

        If(valid, () => {
          const encN = texture(texNormal, uv).xyz;
          const pixNormal = encN.mul(2.0).sub(1.0).normalize();
          const owner = texture(texNormal, uv).w.negate().max(0).round();

          const viewPos = getViewPosition(uv, depth, U_PROJ_INV);
          const worldPos = U_CAM_WORLD.mul(vec4(viewPos, 1.0)).xyz;

          // 2. Spatial Hash Lookup
          const pRel = worldPos.sub(U_GRID_ORIGIN);
          const gridCoord = surfel_pos_to_grid_coord(pRel);
          const c4 = surfel_grid_coord_to_c4(gridCoord);
          const rawHash = surfel_grid_c4_to_hash(c4);
          const cellIdx = rawHash.toInt();

          const start = offsetsAndList.element(cellIdx);
          const end = offsetsAndList.element(cellIdx.add(int(1)));
          const count = end.sub(start).max(int(0));
          // Whole cell by default. `count` is exact — the slot pass decrements each cell's
          // offset back down to its own start, so `end - start` is that cell's population
          // and never runs off the list — and summing all of it is what makes this pass a
          // function of the cache rather than of the atomics: the accumulator below is a
          // sum, and a sum does not care which order the entries arrived in. The old cap
          // is one flag away and is the only thing here that reintroduces an ordering.
          const capped = min(int(maxFetchPerPixel), count);

          // 3. Accumulate Light
          const sumLight = vec3(0).toVar();
          const sumWeight = float(0).toVar();

          const bestContrib = float(0.0).toVar();
          const bestSid = int(0).toVar();

          Loop(capped, ({ i }) => {
            const sid = offsetsAndList.element(
              int(OFFSETS_AND_LIST_START).add(start).add(i),
            );
            // Pinned surfels are skipped when the lightmap owns the statics.
            //
            // `?dynsurfel=1` pins the atlas into the pool and keeps the lifecycle alive
            // for movers, so the grid then holds two populations that mean different
            // things: atlas texels, whose radiance is *already* in the baked lightmap the
            // material samples, and live surfels on Movable geometry, which nothing else
            // lights. Summing both double-counts the statics — and worse, the atlas
            // entries sit at lightmap texel centres rather than where a screen pixel
            // hashes, so the gather over them comes back as holes: the black patches
            // across the ceiling, walls and floor in the `?split=gi` pane. Dropping them
            // here leaves the statics to the lightmap and the movers to the cache, which
            // is the split the whole mode exists for.
            const notPinned = U_SKIP_PINNED.lessThan(0.5).or(
              surfels.element(sid).get('age').greaterThanEqual(int(0)),
            );
            const anchor = anchors.position(sid);
            const sameOwner = owner.equal(0).or(anchor.w.equal(owner)
              .and(anchors.normal(sid).w.equal(surfels.element(sid).get('posb').w)));
            // Basic bounds check
            If(
              sid
                .greaterThanEqual(int(0))
                .and(sid.lessThan(int(capacity)))
                .and(notPinned).and(sameOwner),
                // Only probes attached to this rigid receiver can shade it.
              () => {
                // @ts-ignore Fn is mistyped
                const irr = resolveIrradiance({
                  sid,
                  surfels,
                  moments,
                  pixNormal,
                  worldPos,
                  U_FRAME,
                  U_MOMENTS_OFFSET: U_RESOLVE_OFFSET,
                  U_CAM_POS,
                  U_OCCLUSION_PARAMS,
                  surfelDepth: surfelDepthBufferRO,
                  freshWeight: U_SKIP_PINNED.div(float(FADE_FRAMES)),
                });

                If(irr.w.greaterThan(bestContrib), () => {
                  bestContrib.assign(irr.w);
                  bestSid.assign(sid);
                });

                sumLight.addAssign(irr.xyz); // Color
                sumWeight.addAssign(irr.w); // Weight
              },
            );
          });

          // 4. Normalize
          //
          // The alpha this writes is a coverage flag, not a constant. This pass already
          // has an encoding for "no data" — every pixel whose depth fails the test above
          // leaves `outColor` at vec4(0), including its alpha — and a cell that yielded no
          // weight is the same statement: nothing in the cache speaks for this pixel. It
          // used to write alpha 1 with rgb 0, which is the opposite claim, "I looked and
          // the answer is black", and that is what turned a coverage hole into a hard
          // cell-shaped patch instead of something a consumer could choose to fill.
          //
          // Summing the whole cell should make the zero branch unreachable from selection
          // — a cell with any usable surfel in it now always contributes — but "should" is
          // not a guarantee for a genuinely empty cell, and a branch that asserts black is
          // not something to leave loaded on the strength of an argument. The composite in
          // render/frameGraph.ts adds `gi * albedo`, so zero alpha there is inert today;
          // the point is that the hole is now labelled rather than disguised.
          const invW = float(1.0).div(max(float(1e-5), sumWeight));
          const covered = sumWeight.greaterThan(float(1e-5));
          outColor.assign(
            vec4(sumLight.mul(invW), covered.select(float(1.0), float(0.0))),
          );

          // Range: 50 to 100
          const dominance = bestContrib.div(sumWeight.add(float(1e-5)));

          If(
            bestSid
              .greaterThanEqual(int(0))
              .and(dominance.greaterThan(float(0.5))),
            () => {
              // Map 0..1 to 0..50, then add 50.
              const impRange = float(
                SURFEL_IMPORTANCE_DIRECT_MAX - SURFEL_IMPORTANCE_INDIRECT_MAX,
              ); // 50
              const base = float(SURFEL_IMPORTANCE_INDIRECT_MAX); // 50
              const importance = clamp(
                int(base.add(dominance.mul(impRange))),
                0,
                100,
              );
              atomicMax(touchedAtomic.element(bestSid), importance);
            },
          );

          If(
            bestSid
              .greaterThanEqual(int(0))
              .and(bestContrib.greaterThan(float(0.05))),
            () => {
              // Small, coverage-driven keepalive (doesn't depend on brightness)
              atomicMax(touchedAtomic.element(bestSid), int(2));
            },
          );
        });

        // Write to texture
        textureStore(outputTexture!, ivec2(x, y), outColor);
      })()
        .compute(width * height)
        .setName('Surfel GI Resolve');
    }

    renderer.compute(computeNode);

    activeTexture = outputTexture;
  }

  return {
    run,
    getOutputTexture: () => activeTexture ?? outputTexture,
    getLegacyTexture: () => outputTexture,
  };
}
