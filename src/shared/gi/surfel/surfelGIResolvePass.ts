// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
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
import { createScreenProbePass } from '../probe/screenProbePass.ts';
import { probeSettings, probeTextures } from '../probe/settings.ts';
import { createReflectPass } from '../reflect/reflectPass.ts';

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
    const fade = saturate(sinceBirth.div(float(FADE_FRAMES))); // (e.g., 4–16 frames)
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
 * LOCAL CHANGE vs upstream: this factory now owns two final gathers, not one.
 *
 * Upstream's is below and unaltered — hash the pixel into one grid cell, average
 * the surfels it holds, emit black when it holds none. That last clause is the
 * whole problem: an empty cell produced `vec3(0)` with alpha 1, which is a hard
 * cell-shaped patch rather than a falloff, and no amount of loosening the
 * visibility gate fixes it because the cell really is empty. Surfels are spawned
 * from a G-Buffer and a concave corner is never in one.
 *
 * The answer is Lumen's, and it is a tier rather than a tweak: screen probes,
 * placed in screen space (so coverage holes cannot exist), tracing the near field
 * for real (so contact-scale shadowing exists at all) and falling back to the
 * surfel cache beyond a short-ray budget (so the cache is used as what it is, a
 * world-space radiance cache). It lives in `gi/probe/` and is constructed here
 * because this is the one place in the pipeline handed both the hash grid and the
 * pool it needs to read.
 *
 * Both write RGBA16F at full screen resolution and `getOutputTexture()` names
 * whichever is active, so the composite in `render/frameGraph.ts` is unchanged.
 */
export function createSurfelGIResolvePass(
  grid: SurfelHashGrid,
  pool: SurfelPool,
) {
  // Output Texture (RGBA16F)
  let outputTexture: THREE.Texture | null = null;
  let activeTexture: THREE.Texture | null = null;

  const probes = createScreenProbePass(grid, pool);
  // Constructed here for the same reason the probes are: this factory is the one place
  // in the pipeline handed both the hash grid and the surfel pool, and the specular
  // gather reads the cache exactly as the diffuse one does. It does not write into
  // `activeTexture` — reflections are a separate term in the composite, not a different
  // opinion about the same one — so nothing below this line branches on it.
  const reflections = createReflectPass(grid, pool);

  // Uniforms
  const U_PROJ_INV = uniform(new THREE.Matrix4());
  const U_CAM_WORLD = uniform(new THREE.Matrix4());
  const U_CAM_POS = uniform(new THREE.Vector3());
  const U_RESOLVE_OFFSET = uniform(0);
  const U_FRAME = uniform(0);

  const U_GRID_ORIGIN = uniform(new THREE.Vector3());

  let computeNode: THREE.ComputeNode | null = null;
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
      probeTextures.legacy = outputTexture;
      computeNode = null; // Rebuild compute graph on resize
    }
  }

  function run(
    renderer: THREE.WebGPURenderer,
    camera: THREE.PerspectiveCamera,
    gbuffer: { target: THREE.RenderTarget },
  ) {
    const probeRan = probeSettings.enabled
      ? probes.run(renderer, camera, gbuffer)
      : false;

    // Before the early return below, deliberately: reflections are orthogonal to which
    // diffuse gather won. They are also independent of the probes entirely — `?probes=0`
    // must still get a mirror — so this is not nested inside that branch.
    reflections.run(renderer, camera, gbuffer);

    // The legacy gather still runs when the probes are off, and when a split pane
    // is pointed at it so the two can be judged against each other in one frame.
    // Nothing else keeps it alive: it is the reference, not a fallback.
    if (probeRan && !probeSettings.compare) {
      activeTexture = probes.getOutputTexture();
      return;
    }

    const width = gbuffer.target.width;
    const height = gbuffer.target.height;
    resize(width, height);

    if (!outputTexture) return;

    // Update uniforms
    U_PROJ_INV.value.copy(camera.projectionMatrixInverse);
    U_CAM_WORLD.value.copy(camera.matrixWorld);
    U_CAM_POS.value.copy(camera.position);
    U_FRAME.value = renderer.info.frame;
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
        const valid = depth.lessThan(0.999).and(depth.greaterThan(0.0));

        const outColor = vec4(0).toVar();

        If(valid, () => {
          const encN = texture(texNormal, uv).xyz;
          const pixNormal = encN.mul(2.0).sub(1.0).normalize();

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
            // Basic bounds check
            If(
              sid.greaterThanEqual(int(0)).and(sid.lessThan(int(capacity))),
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

    activeTexture = probeRan ? probes.getOutputTexture() : outputTexture;
  }

  return {
    run,
    getOutputTexture: () => activeTexture ?? outputTexture,
    /** Upstream's gather, kept addressable so a split pane can show it. */
    getLegacyTexture: () => outputTexture,
    getProbeDebugTexture: () => probes.getDebugTexture(),
    getReflectTexture: () => reflections.getOutputTexture(),
    invalidateProbeHistory: () => {
      probes.invalidate();
      reflections.invalidate();
    },
  };
}
