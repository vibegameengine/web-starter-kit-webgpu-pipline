import * as THREE from 'three/webgpu';

import { Layer } from '../../shared/world/index.ts';
import type { SurfelGI } from '../../shared/gi/index.ts';
import {
  CASCADES,
  MAX_SURFELS,
  MAX_SURFELS_PER_CELL,
  SLG_TOTAL_FLOATS,
  SURFEL_BASE_RADIUS,
  SURFEL_CS,
  SURFEL_DEPTH_TEXELS,
  SURFEL_GRID_CELL_DIAMETER,
} from '../../shared/gi/surfel/constants.ts';
import { BYTES_PER_SURFEL } from '../../shared/gi/surfel/surfelPool.ts';

/**
 * `console.time('BVH Build')` is emitted by `shared/gi/surfel/sceneBvh.ts`, which is
 * owned by another agent and must not be edited. The duration it prints is exactly the
 * number this report needs, so it gets intercepted rather than re-derived: the original
 * console methods still run, nothing downstream changes, and the value lands somewhere
 * `__scale()` can read it.
 *
 * Installed at module evaluation time on purpose — the BVH is built during `boot()`,
 * long before anything calls `installScaleProbe`.
 */
const timings = new Map<string, number>();
const pending = new Map<string, number>();

(() => {
  if (typeof console === 'undefined') return;
  const originalTime = console.time?.bind(console);
  const originalTimeEnd = console.timeEnd?.bind(console);
  if (!originalTime || !originalTimeEnd) return;

  console.time = (label?: string) => {
    pending.set(label ?? 'default', performance.now());
    originalTime(label as string);
  };
  console.timeEnd = (label?: string) => {
    const key = label ?? 'default';
    const started = pending.get(key);
    if (started !== undefined) {
      timings.set(key, performance.now() - started);
      pending.delete(key);
    }
    originalTimeEnd(label as string);
  };
})();

export interface ScaleProbeContext {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  gi: SurfelGI;
  /** `cornell` or `large` — the report keys every row off this. */
  sceneName: string;
  /** Lightmap atlas edge in texels, as `main.ts` resolved it. */
  lightmapSize: number;
}

// The TSL-node-to-attribute unwrapping that used to live here is gone: `gi.bvhStats`
// reports the byte breakdown from inside the module that owns the buffers, so this
// file no longer has to know what shape a StorageBufferNode is.

function triangleCountOf(geometry: THREE.BufferGeometry): number {
  if (geometry.index) return geometry.index.count / 3;
  const position = geometry.getAttribute('position');
  return position ? position.count / 3 : 0;
}

/** Area-weighted percentile over samples already sorted by `value`. */
function weightedPercentile(
  sorted: { value: number; weight: number }[],
  fraction: number,
): number {
  const total = sorted.reduce((sum, s) => sum + s.weight, 0);
  if (total <= 0) return 0;
  let seen = 0;
  for (const sample of sorted) {
    seen += sample.weight;
    if (seen >= total * fraction) return sample.value;
  }
  return sorted[sorted.length - 1]?.value ?? 0;
}

interface SceneCensus {
  meshes: number;
  instancedMeshes: number;
  instances: number;
  materials: number;
  materialsWithMap: number;
  /** Triangles the raster pass draws, counting every instance. */
  rasterTriangles: number;
  /** Triangles `createSceneBVH` merges today: one copy per Mesh. */
  singleCopyTriangles: number;
  /** Triangles a correct instance-aware builder would have to merge. */
  instanceAwareTriangles: number;
  alphaTestedMeshes: number;
  bounds: { min: number[]; max: number[]; size: number[]; diagonal: number };
}

function censusScene(scene: THREE.Scene): SceneCensus {
  const materials = new Set<string>();
  let materialsWithMap = 0;
  let meshes = 0;
  let instancedMeshes = 0;
  let instances = 0;
  let rasterTriangles = 0;
  let singleCopyTriangles = 0;
  let alphaTestedMeshes = 0;
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();

  scene.updateMatrixWorld(true);
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh & { isInstancedMesh?: boolean; count?: number };
    if (!mesh.isMesh || !mesh.visible) return;

    const triangles = triangleCountOf(mesh.geometry);
    const count = mesh.isInstancedMesh ? (mesh.count ?? 1) : 1;

    meshes++;
    if (mesh.isInstancedMesh) {
      instancedMeshes++;
      instances += count;
    }
    rasterTriangles += triangles * count;
    singleCopyTriangles += triangles;

    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of mats) {
      if (!material) continue;
      if (!materials.has(material.uuid)) {
        materials.add(material.uuid);
        if ((material as THREE.MeshStandardMaterial).map) materialsWithMap++;
      }
      if ((material as THREE.Material).alphaTest > 0) {
        alphaTestedMeshes++;
        break;
      }
    }

    meshBox.setFromObject(mesh);
    if (!meshBox.isEmpty()) box.union(meshBox);
  });

  const size = new THREE.Vector3();
  if (!box.isEmpty()) box.getSize(size);

  return {
    meshes,
    instancedMeshes,
    instances,
    materials: materials.size,
    materialsWithMap,
    rasterTriangles,
    singleCopyTriangles,
    // Every instance contributes its own copy once the builder respects
    // `instanceMatrix`; that is the number the BVH would actually have to hold.
    instanceAwareTriangles: rasterTriangles,
    alphaTestedMeshes,
    bounds: {
      min: box.isEmpty() ? [0, 0, 0] : box.min.toArray(),
      max: box.isEmpty() ? [0, 0, 0] : box.max.toArray(),
      size: size.toArray(),
      diagonal: size.length(),
    },
  };
}

/**
 * Lightmap texel density, measured off the UVs actually written into the geometry.
 *
 * Nothing about this reads the unwrapper. It compares world-space triangle area against
 * that triangle's area in the `uv1` domain, which is the definition of texel density
 * and is therefore true whatever the unwrapper did — including when the unwrapper's
 * per-face-quad assumption is wrong, which is precisely the case on a heightfield.
 */
function measureLightmapDensity(
  scene: THREE.Scene,
  atlasSize: number,
): {
  atlasSize: number;
  meshesWithUv1: number;
  meshesWithoutUv1: number;
  instancedMeshesShareUv1: number;
  /** Per instanced layer: what one shared chart is actually asked to light. */
  sharedCharts: {
    name: string;
    instances: number;
    /** Surface area of every instance summed, in m². */
    worldAreaAllInstancesM2: number;
    /** The one chart's share of the atlas, in texels. */
    texels: number;
    metresPerTexel: number;
  }[];
  trianglesSampled: number;
  worldAreaM2: number;
  uv1AreaFraction: number;
  metresPerTexelAggregate: number;
  metresPerTexelMedian: number;
  metresPerTexelP95: number;
} {
  const samples: { value: number; weight: number }[] = [];
  const sharedCharts: {
    name: string;
    instances: number;
    worldAreaAllInstancesM2: number;
    texels: number;
    metresPerTexel: number;
  }[] = [];
  let worldArea = 0;
  let uvArea = 0;
  let meshesWithUv1 = 0;
  let meshesWithoutUv1 = 0;
  let instancedShared = 0;
  let trianglesSampled = 0;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh & { isInstancedMesh?: boolean; count?: number };
    if (!mesh.isMesh || !mesh.visible) return;
    if (!mesh.layers.isEnabled(Layer.GiStatic)) return;

    const geometry = mesh.geometry;
    const uv1 = geometry.getAttribute('uv1');
    const position = geometry.getAttribute('position');
    if (!position) return;
    if (!uv1) {
      meshesWithoutUv1++;
      return;
    }
    meshesWithUv1++;

    const index = geometry.index;
    const triangles = index ? index.count / 3 : position.count / 3;
    // Sampling stride: a 130 k-triangle terrain does not need every triangle to
    // establish a density distribution, and readback latency is not the budget here.
    const stride = Math.max(1, Math.floor(triangles / 20000));

    let meshUvArea = 0;
    let meshWorldArea = 0;

    for (let t = 0; t < triangles; t += stride) {
      const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

      a.fromBufferAttribute(position as THREE.BufferAttribute, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(position as THREE.BufferAttribute, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(position as THREE.BufferAttribute, i2).applyMatrix4(mesh.matrixWorld);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      const triWorld = cross.crossVectors(ab, ac).length() * 0.5;

      const u0x = uv1.getX(i0);
      const u0y = uv1.getY(i0);
      const u1x = uv1.getX(i1);
      const u1y = uv1.getY(i1);
      const u2x = uv1.getX(i2);
      const u2y = uv1.getY(i2);
      const triUv =
        Math.abs((u1x - u0x) * (u2y - u0y) - (u2x - u0x) * (u1y - u0y)) * 0.5;

      // Weight by the stride so a sampled mesh still contributes its true area.
      worldArea += triWorld * stride;
      uvArea += triUv * stride;
      meshWorldArea += triWorld * stride;
      meshUvArea += triUv * stride;
      trianglesSampled++;

      if (triUv > 0 && triWorld > 0) {
        const texels = triUv * atlasSize * atlasSize;
        samples.push({ value: Math.sqrt(triWorld / texels), weight: triWorld * stride });
      }
    }

    // An InstancedMesh has exactly one `uv1`, so every instance samples the same
    // atlas texels. That is not a density loss, it is a category error: a lightmap
    // stores *world-space* radiance, and four thousand grass clusters standing in
    // four thousand different places cannot share one. The number below is what the
    // shared chart would have to represent if the bake were taken at its word.
    if (mesh.isInstancedMesh && (mesh.count ?? 1) > 1 && meshUvArea > 0) {
      instancedShared++;
      const instanced = mesh as unknown as THREE.InstancedMesh;
      const instanceMatrix = new THREE.Matrix4();
      const combined = new THREE.Matrix4();
      let allInstanceArea = 0;
      for (let i = 0; i < (mesh.count ?? 0); i++) {
        instanced.getMatrixAt(i, instanceMatrix);
        combined.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
        for (let t = 0; t < triangles; t += stride) {
          const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
          const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
          const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
          a.fromBufferAttribute(position as THREE.BufferAttribute, i0).applyMatrix4(combined);
          b.fromBufferAttribute(position as THREE.BufferAttribute, i1).applyMatrix4(combined);
          c.fromBufferAttribute(position as THREE.BufferAttribute, i2).applyMatrix4(combined);
          ab.subVectors(b, a);
          ac.subVectors(c, a);
          allInstanceArea += cross.crossVectors(ab, ac).length() * 0.5 * stride;
        }
      }
      const texels = meshUvArea * atlasSize * atlasSize;
      sharedCharts.push({
        name: mesh.name || mesh.uuid,
        instances: mesh.count ?? 0,
        worldAreaAllInstancesM2: allInstanceArea,
        texels,
        metresPerTexel: texels > 0 ? Math.sqrt(allInstanceArea / texels) : Infinity,
      });
    }
  });

  samples.sort((x, y) => x.value - y.value);

  return {
    atlasSize,
    meshesWithUv1,
    meshesWithoutUv1,
    instancedMeshesShareUv1: instancedShared,
    sharedCharts,
    trianglesSampled,
    worldAreaM2: worldArea,
    uv1AreaFraction: uvArea,
    metresPerTexelAggregate:
      uvArea > 0 ? Math.sqrt(worldArea / (uvArea * atlasSize * atlasSize)) : Infinity,
    metresPerTexelMedian: weightedPercentile(samples, 0.5),
    metresPerTexelP95: weightedPercentile(samples, 0.95),
  };
}

/**
 * Per-surfel byte cost, reconstructed from the allocations in
 * `shared/gi/surfel/surfelPool.ts`.
 *
 * Reconstructed rather than read, because the pool exposes its buffers only as TSL
 * nodes and several of them (the atomics) are not exposed at all. Every term below is
 * one `new Float32Array(capacity * k)` in `ensureCapacity`, so the arithmetic is
 * checkable against that function line by line — and it has to be, because this is the
 * single biggest fixed cost in the system and the number nobody has written down.
 */
function surfelPoolBytes(capacity: number): {
  capacity: number;
  bytesPerSurfel: number;
  breakdown: Record<string, number>;
  totalGpuBytes: number;
  /** The JS-side typed arrays are kept alive alongside the GPU buffers. */
  totalHostBytes: number;
} {
  const breakdown: Record<string, number> = {
    // posb.xyzw + normal.xyz + age, 8 floats
    surfelStruct: 8 * 4,
    // free-list stack, one int per slot
    poolStack: 1 * 4,
    // 20 floats of moments, double-buffered
    moments: 20 * 4 * 2,
    touched: 1 * 4,
    guiding: SLG_TOTAL_FLOATS * 4,
    debugExec: 1 * 4,
    radialDepth: SURFEL_DEPTH_TEXELS * SURFEL_DEPTH_TEXELS * 4 * 4,
  };
  const bytesPerSurfel = Object.values(breakdown).reduce((s, v) => s + v, 0);

  // The pool now exports its own total. This breakdown is the only thing that says
  // *where* the bytes go, so it is kept — but it is no longer allowed to disagree
  // silently with the allocation it claims to describe.
  if (bytesPerSurfel !== BYTES_PER_SURFEL) {
    console.error(
      `[scale] the per-surfel breakdown in scaleProbe.ts sums to ${bytesPerSurfel} B but ` +
        `surfelPool.ts allocates ${BYTES_PER_SURFEL} B. A buffer was added or removed and ` +
        'this table was not updated; every pool number below is wrong by the difference.',
    );
  }

  return {
    capacity,
    bytesPerSurfel: BYTES_PER_SURFEL,
    breakdown,
    totalGpuBytes: BYTES_PER_SURFEL * capacity,
    totalHostBytes: BYTES_PER_SURFEL * capacity,
  };
}

/**
 * Installs `window.__scale()`.
 *
 * Deliberately alongside `__probe()` and `__surfels()` rather than replacing them:
 * those two are what the webgiya A/B harness reads, and a scale run must not perturb
 * the comparison that the rest of the build is validated against.
 */
export function installScaleProbe(context: ScaleProbeContext): void {
  const { renderer, scene, camera, gi, sceneName, lightmapSize } = context;

  const globals = window as unknown as Record<string, unknown>;
  globals.__scaleScene = sceneName;

  globals.__scale = async () => {
    const census = censusScene(scene);

    // `gi.bvhStats` replaces what used to be a reach through TypeScript `private` at
    // runtime to read `gi.bvh`. That worked — `private` is compile-time only — and would
    // have started reporting zero, silently, the first time the field was renamed. The
    // bundle itself is still fetched through the public getter for the diffuse texture.
    const stats = gi.bvhStats;
    const bundle = gi.getSceneBvh();

    const bvhBytes = stats?.breakdown ?? null;
    const bvhTotal = stats?.bytes ?? 0;
    const bvhTriangles = stats?.triangles ?? 0;

    const diffuseTex = bundle?.diffuseArrayTex as THREE.Texture | undefined;
    const image = diffuseTex?.image as
      | { width?: number; height?: number; depth?: number }
      | undefined;
    const layerSize = image?.width ?? 0;
    const layers = image?.depth ?? 0;
    const mipmapped = diffuseTex ? diffuseTex.generateMipmaps === true : false;
    // A chain costs a third again on top of the base level, and reporting only the base
    // would make adding mips look free.
    const mipLevels = mipmapped && layerSize > 0 ? Math.floor(Math.log2(layerSize)) + 1 : 1;
    const diffuseBytes = Math.round(
      layers * layerSize * layerSize * 4 * (mipmapped ? 4 / 3 : 1),
    );

    // `renderer.info` is the only per-frame cost signal available here. Frame time
    // measured off requestAnimationFrame is display-locked and therefore an upper
    // bound only; draw calls and the timestamps (when the inspector has turned
    // trackTimestamp on) are the parts that actually move with scene size.
    const info = renderer.info as unknown as {
      render?: Record<string, number>;
      compute?: Record<string, number>;
      memory?: Record<string, number>;
    };

    const surfelStats = await gi.readSurfelStats(renderer);
    const pool = surfelPoolBytes(surfelStats?.capacity ?? MAX_SURFELS);

    // Cascade c spans ±(SURFEL_CS/2 · cellDiameter · 2^c) around the camera; the
    // outermost cascade is therefore the whole clipmap's reach.
    const cascadeHalfExtent = (SURFEL_CS / 2) * SURFEL_GRID_CELL_DIAMETER;
    const gridHalfExtent = cascadeHalfExtent * 2 ** (CASCADES - 1);

    return {
      scene: sceneName,
      counts: census,
      bvh: {
        built: !!stats,
        buildMs: stats?.buildMs ?? timings.get('BVH Build') ?? null,
        triangles: bvhTriangles,
        nodes: stats?.nodes ?? 0,
        bytes: bvhBytes,
        totalBytes: bvhTotal,
        // What the tracer would hold with no far tier and no budget, against what it
        // does hold. Proxied triangles are represented; dropped ones are not there at all.
        fullDetailTriangles: stats?.fullDetail ?? bvhTriangles,
        proxiedTriangles: stats?.proxied ?? 0,
        droppedTriangles: stats?.dropped ?? 0,
        // The gap the instancing bug opens: what got traced vs what got drawn.
        trianglesMissedByInstancing: census.rasterTriangles - bvhTriangles,
        fractionTraced:
          census.rasterTriangles > 0 ? bvhTriangles / census.rasterTriangles : 0,
      },
      diffuseArray: {
        layers,
        layerSize,
        mipLevels,
        bytesPerLayer: Math.round(layerSize * layerSize * 4 * (mipmapped ? 4 / 3 : 1)),
        totalBytes: diffuseBytes,
        uniqueMaterials: census.materials,
        materialsWithMap: census.materialsWithMap,
        mipmapped,
      },
      surfelPool: {
        ...pool,
        alive: surfelStats?.alive ?? 0,
        pinned: surfelStats?.pinned ?? 0,
        live: surfelStats?.live ?? 0,
        recycled: surfelStats?.recycled ?? 0,
        utilisation: surfelStats ? surfelStats.alive / surfelStats.capacity : 0,
        liveBytes: (surfelStats?.alive ?? 0) * pool.bytesPerSurfel,
      },
      surfelGrid: {
        cascades: CASCADES,
        cellsPerCascadeEdge: SURFEL_CS,
        cellDiameterM: SURFEL_GRID_CELL_DIAMETER,
        maxSurfelsPerCell: MAX_SURFELS_PER_CELL,
        innerCascadeHalfExtentM: cascadeHalfExtent,
        outerCascadeHalfExtentM: gridHalfExtent,
        /** Surfel world radius at a few distances, from `surfel_radius_for_pos`. */
        radiusAtM: [10, 50, 100, 200, 400].map((d) => ({
          distance: d,
          radius: SURFEL_BASE_RADIUS * Math.max(1, d / cascadeHalfExtent),
        })),
        /** How far the scene extends past the clipmap, from the current camera. */
        sceneDiagonalM: census.bounds.diagonal,
        cameraPos: camera.position.toArray(),
      },
      lightmap: measureLightmapDensity(scene, lightmapSize),
      renderer: {
        drawCalls: info.render?.drawCalls ?? null,
        renderTriangles: info.render?.triangles ?? null,
        computeCalls: info.compute?.calls ?? null,
        renderTimestampMs: info.render?.timestamp ?? null,
        computeTimestampMs: info.compute?.timestamp ?? null,
        geometries: info.memory?.geometries ?? null,
        textures: info.memory?.textures ?? null,
      },
    };
  };
}
