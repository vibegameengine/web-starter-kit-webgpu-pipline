// @ts-nocheck -- pool manipulation in TSL, mirroring lightmapSurfels.ts / surfelAllocatePass.
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
  storage,
  uniform,
  vec4,
} from 'three/tsl';

import {
  SLG_TOTAL_FLOATS,
  SURFEL_BASE_RADIUS,
  SURFEL_DEPTH_TEXELS,
} from '../surfel/constants.ts';
import {
  SurfelMoments,
  SurfelStruct,
  type SurfelPool,
} from '../surfel/surfelPool.ts';
import { gatherBvhGeometries } from '../surfel/sceneBvh.ts';
import { Mobility } from '../../world/index.ts';

/**
 * Surfels placed by walking the geometry, not by looking at it.
 *
 * The bake used to sweep an orbit camera around the static bounds and let
 * `surfelFindMissingPass` spawn from the resulting G-Buffers. That inherits the one
 * property of the runtime spawner that a bake must not have: it is a *visibility*
 * query. A camera cannot see into a concave corner, so a concave corner never gets a
 * surfel, and the measurement was unambiguous — the same wall region on the Cornell box
 * read `[53.5,79.1,58.2]` at a 6 s bake and `[87.6,118.0,87.2]` at 20 s, because the
 * hole only closed by throwing views at it until one happened to catch the corner.
 * Screen probes hide that on screen; they do not fill the cache, and everything that
 * reads the cache directly — the far field of the probe trace, the lightmap bake, the
 * multi-bounce term inside the integrator itself — still read a hole.
 *
 * The precedent is `lightmapSurfels.ts`, which already seeds from an atlas
 * rasterisation rather than a camera and proves the integrator has no camera coupling
 * at all: it reads `surfels[i].posb/normal` and traces. This does the same thing
 * without needing a UV unwrap, by area-sampling the triangles the BVH actually holds.
 *
 * Coverage is uniform in world space rather than matched to the surfel radius, which
 * grows with distance from the viewpoint. That is a deliberate simplification and the
 * honest limit of this pass: near the bake viewpoint it over-covers slightly, far from
 * it the reconstruction kernel is wider than the spacing and the extra surfels are
 * redundant rather than wrong. The alternative — spacing that tracks
 * `surfel_radius_for_pos` — bakes the viewpoint into the cache, and a cache that
 * depends on where the baker stood is the defect this pass exists to remove.
 */
export type GeometrySurfelSeeds = {
  positions: Float32Array;
  normals: Float32Array;
  count: number;
  spacing: number;
  area: number;
  triangles: number;
};

/**
 * Area-samples every static triangle and collapses the result onto a spatial hash.
 *
 * The hash cell is the spacing, and the key carries the dominant normal axis and its
 * sign as well as the cell. Without the normal term the two faces of a Cornell wall —
 * 8 cm apart, and the spacing is 30-odd — collapse into one surfel that faces one way
 * and leaves the other side of the wall permanently black.
 */
export function sampleStaticSurfaces(
  scene: THREE.Object3D,
  materialIdByUUID: Map<string, number>,
  options: { budget?: number; spacing?: number } = {},
): GeometrySurfelSeeds {
  const { budget = 32768, spacing: targetSpacing = SURFEL_BASE_RADIUS * 1.25 } =
    options;

  scene.updateMatrixWorld(true);

  // The same gather the static BVH performs, with the same instance expansion, so the
  // surfels stand on exactly the triangles the rays can hit. Anything else and the
  // cache would hold radiance for surfaces the tracer does not have.
  const gathered = gatherBvhGeometries(scene, {
    materialIdByUUID,
    label: 'geoseed',
    include: (mesh) => mesh.userData.mobility !== Mobility.Movable,
  });

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  // Pass one: total world area, so the spacing can be solved for rather than guessed.
  let area = 0;
  let triangles = 0;
  for (const entry of gathered.entries) {
    const pos = entry.template.getAttribute('position');
    const index = entry.template.index;
    const triCount = index.count / 3;
    triangles += triCount;
    for (let t = 0; t < triCount; t++) {
      a.fromBufferAttribute(pos, index.getX(t * 3)).applyMatrix4(entry.matrix);
      b.fromBufferAttribute(pos, index.getX(t * 3 + 1)).applyMatrix4(entry.matrix);
      c.fromBufferAttribute(pos, index.getX(t * 3 + 2)).applyMatrix4(entry.matrix);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      area += ab.cross(ac).length() * 0.5;
    }
  }

  // Spacing is set by the reconstruction kernel, not by the budget: surfels closer
  // together than `SURFEL_BASE_RADIUS` are averaged into each other by `lookupSurfelGI`
  // anyway, so a finer grid buys nothing and spends the pool. The budget only takes
  // over when the world is too large for that density to fit — `sqrt(area / budget)` is
  // the spacing at which it exactly fills the allowance — and then it coarsens rather
  // than truncates, because a bake that covers half the world at full density is the
  // coverage hole this pass exists to close.
  const spacing = Math.max(targetSpacing, Math.sqrt(area / Math.max(1, budget)));
  const cell = spacing;

  const seen = new Set<string>();
  const outPos: number[] = [];
  const outNor: number[] = [];

  const push = (p: THREE.Vector3, n: THREE.Vector3) => {
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    let axis = 0;
    if (ay >= ax && ay >= az) axis = 1;
    else if (az >= ax && az >= ay) axis = 2;
    const sign = (axis === 0 ? n.x : axis === 1 ? n.y : n.z) >= 0 ? 1 : 0;

    const key =
      `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)},` +
      `${Math.floor(p.z / cell)},${axis}${sign}`;
    if (seen.has(key)) return;
    seen.add(key);
    outPos.push(p.x, p.y, p.z);
    outNor.push(n.x, n.y, n.z);
  };

  const point = new THREE.Vector3();

  for (const entry of gathered.entries) {
    const pos = entry.template.getAttribute('position');
    const nor = entry.template.getAttribute('normal');
    const index = entry.template.index;
    const triCount = index.count / 3;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(entry.matrix);

    for (let t = 0; t < triCount; t++) {
      const i0 = index.getX(t * 3);
      const i1 = index.getX(t * 3 + 1);
      const i2 = index.getX(t * 3 + 2);

      a.fromBufferAttribute(pos, i0).applyMatrix4(entry.matrix);
      b.fromBufferAttribute(pos, i1).applyMatrix4(entry.matrix);
      c.fromBufferAttribute(pos, i2).applyMatrix4(entry.matrix);

      normal.fromBufferAttribute(nor, i0).applyMatrix3(normalMatrix).normalize();
      if (normal.lengthSq() < 0.5) {
        // Degenerate vertex normal: fall back to the geometric one, because a surfel
        // with a zero normal is a surfel whose whole hemisphere is the wrong way up.
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        normal.copy(ab.cross(ac)).normalize();
      }

      ab.subVectors(b, a);
      ac.subVectors(c, a);
      const triArea = new THREE.Vector3().crossVectors(ab, ac).length() * 0.5;

      // At least one sample per triangle regardless of size. A triangle smaller than
      // the spacing is still a surface, and the hash below throws away the duplicates
      // that a whole mesh of them produces.
      const wanted = Math.max(1, Math.ceil(triArea / (spacing * spacing)));

      for (let s = 0; s < wanted; s++) {
        // Stratified by a 2D golden-ratio sequence rather than by a random number:
        // a bake that produces a different surfel set on every run cannot be compared
        // against itself, and every measurement in this project is a comparison.
        const u1 = (s * 0.7548776662466927) % 1;
        const u2 = (s * 0.5698402909980532) % 1;
        const su = Math.sqrt(u1);
        const w1 = 1 - su;
        const w2 = su * (1 - u2);
        const w3 = su * u2;

        point.set(
          a.x * w1 + b.x * w2 + c.x * w3,
          a.y * w1 + b.y * w2 + c.y * w3,
          a.z * w1 + b.z * w2 + c.z * w3,
        );
        push(point, normal);
      }
    }
  }

  const count = outPos.length / 3;
  console.log(
    `[geoseed] ${triangles} static triangles, ${area.toFixed(0)} m² → ` +
      `${count} surfel seeds at ${spacing.toFixed(3)} m spacing`,
  );

  return {
    positions: new Float32Array(outPos),
    normals: new Float32Array(outNor),
    count,
    spacing,
    area,
    triangles,
  };
}

const DEPTH_TILE = SURFEL_DEPTH_TEXELS * SURFEL_DEPTH_TEXELS;

/**
 * Writes a seed list into the pool.
 *
 * The write is byte-for-byte what `surfelAllocatePass` performs when it spawns from the
 * screen: same free-list pop, same high-water mark, same cleared depth tile and guiding
 * state. A surfel born here is indistinguishable from one born on screen, which is the
 * point — the light that ends up in it is webgiya's light, reached by webgiya's code.
 */
export function createGeometrySeeder(pool: SurfelPool, capacityHint: number) {
  const seedPos = new THREE.StorageBufferAttribute(
    new Float32Array(Math.max(1, capacityHint) * 4),
    4,
  );
  const seedNor = new THREE.StorageBufferAttribute(
    new Float32Array(Math.max(1, capacityHint) * 4),
    4,
  );

  const U_FRAME = uniform(0);
  const U_SEED_COUNT = uniform(0);

  let node: THREE.ComputeNode | null = null;

  function upload(seeds: GeometrySurfelSeeds): number {
    const room = Math.floor(seedPos.array.length / 4);
    const count = Math.min(seeds.count, room);
    if (count < seeds.count) {
      console.warn(
        `[geoseed] the seed buffer holds ${room} and ${seeds.count} were sampled; ` +
          `${seeds.count - count} surfaces will have no surfel of their own and will be ` +
          'reconstructed from their neighbours instead.',
      );
    }
    const p = seedPos.array as Float32Array;
    const n = seedNor.array as Float32Array;
    for (let i = 0; i < count; i++) {
      p[i * 4 + 0] = seeds.positions[i * 3 + 0];
      p[i * 4 + 1] = seeds.positions[i * 3 + 1];
      p[i * 4 + 2] = seeds.positions[i * 3 + 2];
      p[i * 4 + 3] = 1;
      n[i * 4 + 0] = seeds.normals[i * 3 + 0];
      n[i * 4 + 1] = seeds.normals[i * 3 + 1];
      n[i * 4 + 2] = seeds.normals[i * 3 + 2];
      n[i * 4 + 3] = 0;
    }
    p.fill(0, count * 4);
    seedPos.needsUpdate = true;
    seedNor.needsUpdate = true;
    U_SEED_COUNT.value = count;
    return count;
  }

  function run(renderer: THREE.WebGPURenderer, seeds: GeometrySurfelSeeds): number {
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
      return 0;
    }

    const uploaded = upload(seeds);
    if (uploaded === 0) return 0;

    const capacity = surfelAttr.count;

    if (!node) {
      const surfels = storage(surfelAttr, SurfelStruct, capacity);
      const poolBuf = storage(poolAttr, 'int', capacity);
      const moments = storage(momentsAttr, SurfelMoments, capacity * 2);
      const guiding = storage(guidingAttr, 'float', guidingAttr.count);
      const surfelDepth = storage(surfelDepthAttr, 'vec4', surfelDepthAttr.count);
      const posBuf = storage(seedPos, 'vec4', Math.floor(seedPos.array.length / 4));
      const norBuf = storage(seedNor, 'vec4', Math.floor(seedNor.array.length / 4));

      node = Fn(() => {
        const tid = int(instanceIndex);

        If(tid.lessThan(int(U_SEED_COUNT)), () => {
          const slot = atomicAdd(poolAlloc.element(0), int(1));

          If(slot.lessThan(int(capacity)), () => {
            const sid = poolBuf.element(slot);
            atomicMax(poolMax.element(0), sid.add(int(1)));

            const surfel = surfels.element(sid);
            surfel.get('posb').assign(vec4(posBuf.element(tid).xyz, float(U_FRAME)));
            surfel.get('normal').assign(norBuf.element(tid).xyz.normalize());
            surfel.get('age').assign(int(0));

            const depthBase = sid.mul(int(DEPTH_TILE));
            Loop(int(DEPTH_TILE), ({ i }) => {
              surfelDepth.element(depthBase.add(i)).assign(vec4(0, 0, 0, 0));
            });

            const slgBase = sid.mul(int(SLG_TOTAL_FLOATS));
            Loop(int(SLG_TOTAL_FLOATS), ({ i }) => {
              guiding.element(slgBase.add(i)).assign(float(0));
            });

            Loop(int(2), ({ i }) => {
              const m = moments.element(sid.add(i.mul(int(capacity))));
              m.get('irradiance').assign(vec4(0, 0, 0, 0));
              m.get('msmeData0').assign(vec4(0, 0, 0, 0));
              m.get('msmeData1').assign(vec4(0, 0, 0, 0));
              m.get('guiding').assign(vec4(0, 0, 0, 0));
              m.get('hit').assign(vec4(0, 0, 0, 0));
            });
          });
        });
      })()
        .compute(Math.floor(seedPos.array.length / 4))
        .setName('Geometry surfel seed');
    }

    U_FRAME.value = renderer.info.frame;
    renderer.compute(node);
    return uploaded;
  }

  return { run };
}
