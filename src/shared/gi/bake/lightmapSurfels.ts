// @ts-nocheck -- pool manipulation in TSL, mirroring surfelAllocatePass / surfelPreparePass.
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  atomicAdd,
  atomicMax,
  float,
  instanceIndex,
  int,
  ivec2,
  storage,
  texture,
  textureStore,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

import {
  SLG_TOTAL_FLOATS,
  SURFEL_DEPTH_TEXELS,
} from '../surfel/constants.ts';
import {
  SurfelMoments,
  SurfelStruct,
  type SurfelPool,
} from '../surfel/surfelPool.ts';
import type { LightmapGBuffer } from './lightmapGBuffer.ts';

/**
 * Turns webgiya's runtime surfel GI into a bake, by changing where surfels come from
 * and nothing else.
 *
 * Upstream spawns surfels from the *screen* G-Buffer: `surfelFindMissingPass` walks
 * screen tiles, reconstructs world position from depth through the camera matrices,
 * and asks the hash grid whether that spot is already covered. Every part of that is
 * camera-shaped, which is why upstream's GI is a residency structure and not a bake —
 * and it is the one link in the chain that cannot be reused here.
 *
 * The *integrator* has no such coupling. It reads `surfels[i].posb/normal` and traces;
 * it neither knows nor cares that the position came from a screen. So this module
 * seeds the pool from the lightmap atlas instead — one surfel per covered texel, at
 * that texel's world position and normal — and then webgiya's own passes run
 * unmodified: guided sampling, MSME, radial-depth, `lookupSurfelGI` multi-bounce.
 *
 * The seeding itself is deliberately the same write `surfelAllocatePass` performs when
 * it spawns: same free-list pop, same high-water mark, same `posb`/`normal`/`age`,
 * same cleared depth tile and guiding state. A surfel born here is indistinguishable
 * from one born on screen — which is the entire point, because it means the light in
 * the atlas is webgiya's light, arrived at by webgiya's code.
 *
 * Reading the atlas back out is then trivial: a texel's irradiance is
 * `moments[itsSurfel].irradiance`. No radius, no hash lookup, no Mahalanobis weight,
 * no leak gate — the resolve exists to *reconstruct* a value at a point that has no
 * surfel of its own, and here every point has one by construction.
 */
export function createLightmapSurfels(pool: SurfelPool, size: number) {
  const texelCount = size * size;
  const DEPTH_TILE = SURFEL_DEPTH_TEXELS * SURFEL_DEPTH_TEXELS;

  /** texel -> surfel index, or -1 where no chart covers the texel. */
  const texelSurfelAttr = new THREE.StorageBufferAttribute(
    new Int32Array(texelCount),
    1,
  );
  /**
   * The atlas in a plain buffer, double-height so filtering can ping-pong.
   *
   * w encodes what the texel is: 1 = a real surfel wrote it, 0.5 = filled by
   * dilation, 0 = nothing. The distinction matters twice — the filter must not
   * average real radiance with invented gutter values, and the statistics must not
   * count invented texels as covered.
   */
  const atlasAttr = new THREE.StorageBufferAttribute(
    new Float32Array(texelCount * 2 * 4),
    4,
  );

  const lightmap = new THREE.StorageTexture(size, size);
  lightmap.type = THREE.HalfFloatType;
  lightmap.format = THREE.RGBAFormat;
  lightmap.minFilter = THREE.LinearFilter;
  lightmap.magFilter = THREE.LinearFilter;

  const U_FRAME = uniform(0);
  const U_READ_OFFSET = uniform(0);
  const U_SRC = uniform(0);
  const U_DST = uniform(0);
  /** How far off a texel's own plane a neighbour may sit and still be averaged in. */
  const U_PLANE_EPS = uniform(0.02);

  let seedNode: THREE.ComputeNode | null = null;
  let writeNode: THREE.ComputeNode | null = null;
  let denoiseNode: THREE.ComputeNode | null = null;
  let dilateNode: THREE.ComputeNode | null = null;
  let blitNode: THREE.ComputeNode | null = null;
  let half = 0;
  let seeded = 0;

  /**
   * One surfel per covered atlas texel.
   *
   * Runs once. Surfels seeded here are never aged (the age pass is a lifecycle for
   * screen coverage and has no meaning for an atlas), so they live for the whole bake
   * and the pool never recycles them out from under it.
   */
  function seed(
    renderer: THREE.WebGPURenderer,
    gbuffer: LightmapGBuffer,
  ): boolean {
    const surfelAttr = pool.getSurfelAttr();
    const poolAttr = pool.getPoolAttr();
    const momentsAttr = pool.getMomentsAttr();
    const guidingAttr = pool.getGuidingAttr();
    const surfelDepthAttr = pool.getSurfelDepthAttr();
    const poolAlloc = pool.getPoolAllocAtomic();
    const poolMax = pool.getPoolMaxAtomic();
    if (
      !surfelAttr ||
      !poolAttr ||
      !momentsAttr ||
      !guidingAttr ||
      !surfelDepthAttr ||
      !poolAlloc ||
      !poolMax
    ) {
      return false;
    }

    const capacity = surfelAttr.count;

    if (!seedNode) {
      const surfels = storage(surfelAttr, SurfelStruct, capacity);
      const poolBuf = storage(poolAttr, 'int', capacity);
      const moments = storage(momentsAttr, SurfelMoments, capacity * 2);
      const guiding = storage(guidingAttr, 'float', guidingAttr.count);
      const surfelDepth = storage(surfelDepthAttr, 'vec4', surfelDepthAttr.count);
      const texelSurfel = storage(texelSurfelAttr, 'int', texelCount);

      const positionTex = texture(gbuffer.position);
      const normalTex = texture(gbuffer.normal);

      seedNode = Fn(() => {
        const tid = int(instanceIndex);
        const x = tid.mod(int(size));
        const y = tid.div(int(size));
        const uv = vec2(
          x.toFloat().add(0.5).div(float(size)),
          y.toFloat().add(0.5).div(float(size)),
        );

        texelSurfel.element(tid).assign(int(-1));

        const posSample = positionTex.sample(uv);

        If(posSample.w.greaterThan(0.5), () => {
          // Same free-list pop the allocate pass performs, so these surfels occupy
          // real pool slots and the runtime allocator cannot hand them out twice.
          const slot = atomicAdd(poolAlloc.element(0), int(1));

          If(slot.lessThan(int(capacity)), () => {
            const sid = poolBuf.element(slot);
            atomicMax(poolMax.element(0), sid.add(int(1)));

            const surfel = surfels.element(sid);
            surfel.get('posb').assign(vec4(posSample.xyz, float(U_FRAME)));
            surfel.get('normal').assign(normalTex.sample(uv).xyz.normalize());
            surfel.get('age').assign(int(0));

            // [RADIAL DEPTH] clear this surfel's tile — allocate does the same.
            const depthBase = sid.mul(int(DEPTH_TILE));
            Loop(int(DEPTH_TILE), ({ i }) => {
              surfelDepth.element(depthBase.add(i)).assign(vec4(0, 0, 0, 0));
            });

            // [SLG] no parent to inherit guiding from, so start blind: the
            // integrator falls back to cosine sampling until the lobes learn.
            const slgBase = sid.mul(int(SLG_TOTAL_FLOATS));
            Loop(int(SLG_TOTAL_FLOATS), ({ i }) => {
              guiding.element(slgBase.add(i)).assign(float(0));
            });

            // Both halves of the double buffer, or the first swap shows garbage.
            Loop(int(2), ({ i }) => {
              const m = moments.element(sid.add(i.mul(int(capacity))));
              m.get('irradiance').assign(vec4(0, 0, 0, 0));
              m.get('msmeData0').assign(vec4(0, 0, 0, 0));
              m.get('msmeData1').assign(vec4(0, 0, 0, 0));
              m.get('guiding').assign(vec4(0, 0, 0, 0));
              m.get('hit').assign(vec4(0, 0, 0, 0));
            });

            texelSurfel.element(tid).assign(sid);
          });
        });
      })()
        .compute(texelCount)
        .setName('Lightmap surfel seed');
    }

    U_FRAME.value = renderer.info.frame;
    renderer.compute(seedNode);
    return true;
  }

  /**
   * Copies each texel's surfel irradiance into the atlas.
   *
   * `readOffset`, not `writeOffset`: the bake loop swaps the moments buffer at the end
   * of every iteration exactly as `update()` does, so after the final swap the
   * converged half is the one the *next* integration would read.
   */
  function writeAtlas(
    renderer: THREE.WebGPURenderer,
    gbuffer: LightmapGBuffer,
    options: { denoise?: number; dilate?: number; planeEpsilon?: number } = {},
  ): boolean {
    const momentsAttr = pool.getMomentsAttr();
    const surfelAttr = pool.getSurfelAttr();
    if (!momentsAttr || !surfelAttr) return false;

    const { denoise = 2, dilate = 4, planeEpsilon = 0.02 } = options;
    const capacity = surfelAttr.count;

    if (!writeNode) {
      const moments = storage(momentsAttr, SurfelMoments, capacity * 2).setAccess(
        'readOnly',
      );
      const texelSurfel = storage(texelSurfelAttr, 'int', texelCount).setAccess(
        'readOnly',
      );
      const atlas = storage(atlasAttr, 'vec4', texelCount * 2);
      const positionTex = texture(gbuffer.position);
      const normalTex = texture(gbuffer.normal);

      const texelUv = (x: ReturnType<typeof int>, y: ReturnType<typeof int>) =>
        vec2(
          x.toFloat().add(0.5).div(float(size)),
          y.toFloat().add(0.5).div(float(size)),
        );

      writeNode = Fn(() => {
        const tid = int(instanceIndex);
        const sid = texelSurfel.element(tid);
        const out = vec4(0, 0, 0, 0).toVar();

        If(sid.greaterThanEqual(int(0)), () => {
          const m = moments.element(sid.add(int(U_READ_OFFSET)));
          out.assign(vec4(m.get('irradiance').xyz, float(1)));
        });

        atlas.element(tid.add(int(U_DST))).assign(out);
      })()
        .compute(texelCount)
        .setName('Lightmap atlas write');

      // Bilateral blur across the atlas.
      //
      // This is the half of the pipeline the runtime gets for free and a bake does
      // not: `surfelGIResolvePass` averages up to 64 surfels per *pixel*, which is a
      // spatial denoiser hiding inside the reconstruction. A bake reads exactly one
      // surfel per texel, so every texel's Monte-Carlo variance survives into the
      // image — and bilinear magnification (a 512 atlas at 57% utilisation gives a
      // wall face ~110 texels across, stretched over ~700 screen pixels) turns that
      // per-texel variance into 6-pixel blotches.
      //
      // Neighbours are rejected by plane distance and normal, not by chart id, so no
      // chart bookkeeping is needed and texels from a different surface can never
      // bleed in — which is the failure a plain box blur on an atlas always produces.
      denoiseNode = Fn(() => {
        const tid = int(instanceIndex);
        const x = tid.mod(int(size));
        const y = tid.div(int(size));
        const self = atlas.element(tid.add(int(U_SRC)));

        If(self.w.lessThan(0.75), () => {
          atlas.element(tid.add(int(U_DST))).assign(self);
        }).Else(() => {
          const uv = texelUv(x, y);
          const p0 = positionTex.sample(uv).xyz;
          const n0 = normalTex.sample(uv).xyz.normalize();

          const sum = self.xyz.toVar();
          const count = float(1).toVar();

          Loop(int(9), ({ i }) => {
            const dx = i.mod(int(3)).sub(int(1));
            const dy = i.div(int(3)).sub(int(1));
            const nx = x.add(dx);
            const ny = y.add(dy);

            If(
              dx
                .equal(int(0))
                .and(dy.equal(int(0)))
                .not()
                .and(nx.greaterThanEqual(int(0)))
                .and(nx.lessThan(int(size)))
                .and(ny.greaterThanEqual(int(0)))
                .and(ny.lessThan(int(size))),
              () => {
                const j = ny.mul(int(size)).add(nx);
                const s = atlas.element(j.add(int(U_SRC)));
                If(s.w.greaterThan(0.75), () => {
                  const uvj = texelUv(nx, ny);
                  const pj = positionTex.sample(uvj).xyz;
                  const nj = normalTex.sample(uvj).xyz.normalize();
                  // Same surface: facing the same way, and lying on the same plane.
                  If(
                    n0
                      .dot(nj)
                      .greaterThan(0.9)
                      .and(pj.sub(p0).dot(n0).abs().lessThan(U_PLANE_EPS)),
                    () => {
                      sum.addAssign(s.xyz);
                      count.addAssign(1);
                    },
                  );
                });
              },
            );
          });

          atlas
            .element(tid.add(int(U_DST)))
            .assign(vec4(sum.div(count), float(1)));
        });
      })()
        .compute(texelCount)
        .setName('Lightmap denoise');

      // Gutter fill. Bilinear sampling at a chart border reaches outside the chart;
      // without this it reaches into zeros and every chart edge renders as a dark
      // seam. Filled texels are marked 0.5 so a later pass can spread them further
      // without the statistics ever counting them as baked.
      dilateNode = Fn(() => {
        const tid = int(instanceIndex);
        const x = tid.mod(int(size));
        const y = tid.div(int(size));
        const self = atlas.element(tid.add(int(U_SRC)));

        If(self.w.greaterThan(0.25), () => {
          atlas.element(tid.add(int(U_DST))).assign(self);
        }).Else(() => {
          const sum = vec3(0, 0, 0).toVar();
          const count = float(0).toVar();

          Loop(int(9), ({ i }) => {
            const dx = i.mod(int(3)).sub(int(1));
            const dy = i.div(int(3)).sub(int(1));
            const nx = x.add(dx);
            const ny = y.add(dy);
            If(
              nx
                .greaterThanEqual(int(0))
                .and(nx.lessThan(int(size)))
                .and(ny.greaterThanEqual(int(0)))
                .and(ny.lessThan(int(size))),
              () => {
                const s = atlas.element(ny.mul(int(size)).add(nx).add(int(U_SRC)));
                If(s.w.greaterThan(0.25), () => {
                  sum.addAssign(s.xyz);
                  count.addAssign(1);
                });
              },
            );
          });

          If(count.greaterThan(0), () => {
            atlas
              .element(tid.add(int(U_DST)))
              .assign(vec4(sum.div(count), float(0.5)));
          }).Else(() => {
            atlas.element(tid.add(int(U_DST))).assign(vec4(0, 0, 0, 0));
          });
        });
      })()
        .compute(texelCount)
        .setName('Lightmap dilate');

      blitNode = Fn(() => {
        const tid = int(instanceIndex);
        const v = atlas.element(tid.add(int(U_SRC)));
        textureStore(
          lightmap,
          ivec2(tid.mod(int(size)), tid.div(int(size))),
          vec4(v.xyz, float(1)),
        );
      })()
        .compute(texelCount)
        .setName('Lightmap blit');
    }

    U_READ_OFFSET.value = pool.getOffsets().readOffset;
    U_PLANE_EPS.value = planeEpsilon;

    // Ping-pong through the two halves; `half` always names the one holding the
    // current result, which is what readStats and the blit must both read.
    half = 0;
    U_DST.value = 0;
    renderer.compute(writeNode);

    const step = (node: THREE.ComputeNode) => {
      U_SRC.value = half * texelCount;
      half = 1 - half;
      U_DST.value = half * texelCount;
      renderer.compute(node);
    };

    for (let i = 0; i < denoise; i++) step(denoiseNode!);
    for (let i = 0; i < dilate; i++) step(dilateNode!);

    U_SRC.value = half * texelCount;
    renderer.compute(blitNode!);
    return true;
  }

  /**
   * Counts what actually landed in the atlas.
   *
   * A lightmap fails silently by construction: never-written and written-black look
   * identical on screen. These numbers are what separate them.
   */
  async function readStats(renderer: THREE.WebGPURenderer): Promise<{
    lit: number;
    filled: number;
    total: number;
    black: number;
    meanLuma: number;
    maxLuma: number;
  }> {
    const buffer = await renderer.getArrayBufferAsync(atlasAttr);
    const data = new Float32Array(buffer);
    // Only the half holding the current result, and only texels a real surfel
    // wrote: dilated gutter texels carry w = 0.5 and are invented, not measured.
    const base = half * texelCount * 4;
    let lit = 0;
    let filled = 0;
    let black = 0;
    let sum = 0;
    let max = 0;
    for (let t = 0; t < texelCount; t++) {
      const i = base + t * 4;
      if (data[i + 3] < 0.25) continue;
      if (data[i + 3] < 0.75) {
        filled++;
        continue;
      }
      lit++;
      const luma =
        0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (luma <= 1e-5) black++;
      sum += luma;
      if (luma > max) max = luma;
    }
    return {
      lit,
      filled,
      total: texelCount,
      black,
      meanLuma: lit ? sum / lit : 0,
      maxLuma: max,
    };
  }

  /** How many texels claimed a surfel. Zero means the seed never ran. */
  async function countSeeded(renderer: THREE.WebGPURenderer): Promise<number> {
    const buffer = await renderer.getArrayBufferAsync(texelSurfelAttr);
    const data = new Int32Array(buffer);
    seeded = 0;
    for (let i = 0; i < data.length; i++) if (data[i] >= 0) seeded++;
    return seeded;
  }

  return { lightmap, seed, writeAtlas, readStats, countSeeded };
}
