// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// surfelHashGrid.ts
import * as THREE from 'three/webgpu';
import {
  Fn,
  storage,
  float,
  int,
  uint,
  instanceIndex,
  atomicAdd,
  workgroupArray,
  workgroupBarrier,
  localId,
  workgroupId,
  Loop,
  bitAnd,
  If,
  min,
  max,
  instancedArray,
  abs,
  floor,
  clamp,
  log2,
  ceil,
  vec3,
  ivec3,
  uvec4,
  uniform,
  length,
  select,
  struct,
  dot,
  atomicStore,
} from 'three/tsl';
import { SurfelStruct, type SurfelPool } from './surfelPool';

import {
  CASCADES,
  MAX_SURFELS_PER_CELL,
  OFFSETS_AND_LIST_START,
  SURFEL_BASE_RADIUS,
  SURFEL_CS,
  SURFEL_GRID_CELL_DIAMETER,
  SURFEL_NORMAL_DIRECTION_SQUISH,
  SURFEL_TTL,
  TOTAL_CELLS,
} from './constants';

export type SurfelHashGrid = {
  build: (
    renderer: THREE.WebGPURenderer,
    pool: SurfelPool,
    camera: THREE.PerspectiveCamera,
  ) => void;
  getOffsetsAndListAttr: () => THREE.StorageBufferAttribute | null;
  getSegmentSumAttr: () => THREE.StorageBufferAttribute | null;
};

const SurfelGridMinMax = struct({
  c0_min: 'uvec4',
  c0_max: 'uvec4',
  c1_min: 'uvec4',
  c1_max: 'uvec4',
  cascadeCount: 'uint',
});

// surfel_binning_shader.hlsl in original implementation
export const get_surfel_grid_box_min_max = Fn(([pRel]: [THREE.Node]) => {
  // 1. Calculate Radius
  // Note: surfel_radius_for_pos expects dist from camera.
  // Since pRel is already (pos - snapped grid origin), we pass vec3(0) as the origin.
  const radius = surfel_radius_for_pos(pRel, vec3(0));

  // 2. Bounding Box (Relative)
  const boxMin = pRel.sub(radius);
  const boxMax = pRel.add(radius);

  const gridMin = surfel_pos_to_grid_coord(boxMin);
  const gridMax = surfel_pos_to_grid_coord(boxMax);
  const centerCoord = surfel_pos_to_grid_coord(pRel);

  // 3. Cascade Hysteresis Logic
  const cf = surfel_grid_coord_to_cascade_float(centerCoord);

  // Calculate both potential cascades (+/- 0.2 hysteresis)
  const c0 = surfel_cascade_float_to_cascade(cf.sub(0.2));
  const c1 = surfel_cascade_float_to_cascade(cf.add(0.2));

  // 4. Compute Bounds for Cascade 0
  const minC0 = surfel_grid_coord_within_cascade(gridMin, c0);
  const maxC0 = surfel_grid_coord_within_cascade(gridMax, c0);

  // 5. Compute Bounds for Cascade 1
  const minC1 = surfel_grid_coord_within_cascade(gridMin, c1);
  const maxC1 = surfel_grid_coord_within_cascade(gridMax, c1);

  // Clamp helper
  const limit = int(SURFEL_CS).sub(1);
  const clampToGrid = (v: THREE.Node) => clamp(v, ivec3(0), ivec3(limit));

  // 6. Pack Result
  const result = SurfelGridMinMax({
    c0_min: uvec4(
      uint(clampToGrid(minC0).x),
      uint(clampToGrid(minC0).y),
      uint(clampToGrid(minC0).z),
      c0,
    ),
    c0_max: uvec4(
      uint(clampToGrid(maxC0).x),
      uint(clampToGrid(maxC0).y),
      uint(clampToGrid(maxC0).z),
      c0,
    ),
    c1_min: uvec4(
      uint(clampToGrid(minC1).x),
      uint(clampToGrid(minC1).y),
      uint(clampToGrid(minC1).z),
      c1,
    ),
    c1_max: uvec4(
      uint(clampToGrid(maxC1).x),
      uint(clampToGrid(maxC1).y),
      uint(clampToGrid(maxC1).z),
      c1,
    ),
    cascadeCount: select(c0.notEqual(c1), 2, 1),
  });

  return result;
});

// Helper: Position -> Integer Grid Coordinate
export const surfel_pos_to_grid_coord = Fn(([pos]: [THREE.Node]) => {
  return floor(pos.div(SURFEL_GRID_CELL_DIAMETER)).toIVec3();
});

// Helper: Grid Coordinate -> Cascade Level (float)
const surfel_grid_coord_to_cascade_float = Fn(([coord]: [THREE.Node]) => {
  const fcoord = coord.toVec3().add(0.5);
  const max_c = max(abs(fcoord.x), max(abs(fcoord.y), abs(fcoord.z)));
  return log2(max_c.div(float(SURFEL_CS).div(2.0)));
});

// Helper: Float Cascade -> Uint Cascade
const surfel_cascade_float_to_cascade = Fn(([c_float]: [THREE.Node]) => {
  const maxCascade = float(CASCADES - 1);
  return uint(clamp(ceil(max(0.0, c_float)), 0.0, maxCascade));
});

// Helper: Shift coordinate based on cascade level
const surfel_grid_coord_within_cascade = Fn(
  ([coord, cascade]: [THREE.Node, THREE.Node]) => {
    return coord.shiftRight(ivec3(cascade)).add(int(SURFEL_CS).div(2));
  },
);

// Main: Calculate Center of a Grid Cell (World Space)
export const surfel_grid_coord_center = Fn(
  ([coord, eye_pos]: [THREE.Node, THREE.Node]) => {
    // coord: uvec4 (x, y, z, cascade)
    // eye_pos: vec3

    // We convert uvec3 to vec3 for float math
    const gridPos = coord.xyz.toVec3().add(0.5).sub(float(SURFEL_CS).div(2.0));

    const posInCascade = gridPos.mul(SURFEL_GRID_CELL_DIAMETER);

    // We compute the cascade scale factor (2^cascade)
    const cascadeScale = float(uint(1).shiftLeft(coord.w));

    return eye_pos.add(posInCascade.mul(cascadeScale));
  },
);

// Main: Calculate C4 (Cascade Coordinate) from Grid Coord
export const surfel_grid_coord_to_c4 = Fn(([coord]: [THREE.Node]) => {
  const cf = surfel_grid_coord_to_cascade_float(coord);
  const cascade = surfel_cascade_float_to_cascade(cf);
  const ucoord = surfel_grid_coord_within_cascade(coord, cascade);

  // Clamp to valid grid range (0 .. CS-1)
  const clamped = clamp(ucoord, ivec3(0), ivec3(int(SURFEL_CS).sub(1)));
  return uvec4(clamped.x, clamped.y, clamped.z, cascade);
});

// Main: Hash a C4 Coordinate
export const surfel_grid_c4_to_hash = Fn(([c4]: [THREE.Node]) => {
  // We use explicit uint math here to avoid float precision issues
  const x = c4.x;
  const y = c4.y.mul(uint(SURFEL_CS));
  const z = c4.z.mul(uint(SURFEL_CS)).mul(uint(SURFEL_CS));
  const w = c4.w.mul(uint(SURFEL_CS)).mul(uint(SURFEL_CS)).mul(uint(SURFEL_CS));
  return x.add(y).add(z).add(w);
});

export const surfel_grid_coord_to_hash = Fn(([coord]: [THREE.Node]) => {
  return surfel_grid_c4_to_hash(surfel_grid_coord_to_c4(coord));
});

export const surfel_radius_for_pos = Fn(
  ([pos, camPos]: [THREE.Node, THREE.Node]) => {
    const dist = length(pos.sub(camPos));
    const cascadeRadius = float(SURFEL_GRID_CELL_DIAMETER)
      .mul(SURFEL_CS)
      .mul(0.5); // like SURFEL_GRID_CASCADE_RADIUS
    // return 0.1;
    return float(SURFEL_BASE_RADIUS).mul(
      max(float(1.0), dist.div(cascadeRadius)),
    );
  },
);

export const surfel_intersects_grid_coord = Fn(
  ([surfelWorldPos, normal, radius, c4, gridOrigin]: [
    THREE.Node,
    THREE.Node,
    THREE.Node,
    THREE.Node,
    THREE.Node,
  ]) => {
    // 1. Get Cell Center in World Space
    const cellCenterWorld = surfel_grid_coord_center(c4, gridOrigin);

    // 2. Calculate Cell Radius
    const cascadeScale = float(1).mul(int(1).shiftLeft(int(c4.w)));
    const cellRadius = float(SURFEL_GRID_CELL_DIAMETER)
      .mul(0.5)
      .mul(cascadeScale);

    // 3. Get vector from Cell Center to Surfel (World Space subtraction)
    const cellLocalPos = surfelWorldPos.sub(cellCenterWorld);

    // 4. Clamp to box (The rest is identical logic, just on the resulting vector)
    const closestPoint = clamp(cellLocalPos, cellRadius.negate(), cellRadius);
    const posOffset = cellLocalPos.sub(closestPoint);

    // 5. Mahalanobis "Squish" Check
    const distLen = length(posOffset);
    const dotNormal = abs(dot(posOffset, normal));
    const mahalanobisDist = distLen.mul(
      float(1.0).add(dotNormal.mul(SURFEL_NORMAL_DIRECTION_SQUISH)),
    );

    return mahalanobisDist.lessThan(radius);
  },
);

export function createSurfelHashGrid(): SurfelHashGrid {
  const totalCells = TOTAL_CELLS;

  const WORKGROUP_SIZE = 512;
  const SEGMENT_SIZE = WORKGROUP_SIZE * 2;

  // Buffers
  // let cellOffsetsAttr: THREE.StorageBufferAttribute | null = null;
  // let cellCountsAtomic: THREE.StorageBufferNode | null = null;
  // let cellToSurfelAttr: THREE.StorageBufferAttribute | null = null;
  // let cellToSurfelCapacity = 0;

  // This is the buffer needed to contain both cellOffsets and cellToSurfel
  // Those concepts are merged together as we're looking to reduce buffer count
  let offsetsAndListAttr: THREE.StorageBufferAttribute | null = null;
  let offsetsAndListAtomic: THREE.StorageBufferNode | null = null;
  let offsetsAndListCapacity = 0;

  let segmentSumAttr: THREE.StorageBufferAttribute | null = null;
  let segments = 0;

  // Compute Nodes (Cached)
  let computeClear: THREE.ComputeNode | null = null;
  let computeCount: THREE.ComputeNode | null = null;
  let computeScanSeg: THREE.ComputeNode | null = null;
  let computeCollectSeg: THREE.ComputeNode | null = null;
  let computeSegPrefix: THREE.ComputeNode | null = null;
  let computeMerge: THREE.ComputeNode | null = null;
  let computeSlot: THREE.ComputeNode | null = null;

  // Uniforms (Dynamic Data)
  const U_CAM_POS = uniform(new THREE.Vector3());
  const U_GRID_ORIGIN = uniform(new THREE.Vector3()); // NEW: snapped grid origin

  function discardPipelines() {
    computeClear = null;
    computeCount = null;
    computeScanSeg = null;
    computeCollectSeg = null;
    computeSegPrefix = null;
    computeMerge = null;
    computeSlot = null;
  }

  function ensure() {
    let buffersRecreated = false;

    const headerSize = totalCells + 1;
    const listSize = (totalCells + 1) * MAX_SURFELS_PER_CELL;
    const needed = headerSize + listSize;

    if (!offsetsAndListAttr || offsetsAndListCapacity < needed) {
      offsetsAndListCapacity = needed;
      const arr = new Int32Array(offsetsAndListCapacity);
      arr.fill(-1); // -1 for surfel list, offsets will be overwritten
      const inst = instancedArray(arr, 'int');
      offsetsAndListAtomic = inst.toAtomic();
      offsetsAndListAttr = inst.value as THREE.StorageBufferAttribute;
      buffersRecreated = true;
    }

    segments = Math.max(1, Math.ceil((totalCells + 1) / SEGMENT_SIZE));
    if (!segmentSumAttr || segmentSumAttr.count !== segments) {
      segmentSumAttr = new THREE.StorageBufferAttribute(
        new Int32Array(segments),
        1,
      );
      buffersRecreated = true;
    }

    // If we reallocated buffers, the old compute nodes point to dead memory. Rebuild them.
    if (buffersRecreated) {
      console.log('Recreated grid buffers (needed:', needed);
      discardPipelines();
    }
  }

  function build(
    renderer: THREE.WebGPURenderer,
    pool: SurfelPool,
    camera: THREE.PerspectiveCamera,
  ) {
    const surfelAttr = pool.getSurfelAttr();
    const poolMax = pool.getPoolMaxAtomic();
    const poolAlloc = pool.getPoolAllocAtomic();
    if (!surfelAttr || !poolMax || !poolAlloc) return;

    ensure(); // Might invalidate pipelines if buffers resized

    // Update Uniforms (Cheap)
    U_CAM_POS.value.copy(camera.position);
    snap_to_surfel_grid_origin(U_GRID_ORIGIN.value, camera.position);

    // // CPU Resets
    // if (cellToSurfelAttr) {
    //   // NOTE: In a production renderer you might move this clear to a GPU pass too
    //   (cellToSurfelAttr.array as Int32Array).fill(-1);
    //   cellToSurfelAttr.needsUpdate = true;
    // }
    // if (segmentSumAttr) {
    //   (segmentSumAttr.array as Int32Array).fill(0);
    //   segmentSumAttr.needsUpdate = true;
    // }

    // Lazy Init Pipelines
    if (!computeClear) {
      const capacity = surfelAttr.count;

      const surfels = storage(surfelAttr, SurfelStruct, capacity);
      const offsetsAndList = storage(
        offsetsAndListAtomic!.value,
        'int',
        offsetsAndListAtomic?.value.count,
      );
      // const list = storage(cellToSurfelAttr!, 'int', cellToSurfelAttr!.count);
      const segSums = segmentSumAttr
        ? storage(segmentSumAttr, 'int', segments)
        : null;

      // 1. Clear Offsets
      computeClear = Fn(() => {
        const i = int(instanceIndex);
        If(i.lessThan(int(totalCells + 1)), () => {
          offsetsAndList.element(i).assign(int(0));
        });
      })()
        .compute(Math.max(1, totalCells + 1))
        .setName('Grid Clear');

      // 2. Count
      computeCount = Fn(() => {
        const i = int(instanceIndex);
        const total = atomicAdd(poolMax.element(0), int(0));
        const inRange = i.lessThan(total);
        const alive = inRange.and(
          surfels.element(i).get('age').lessThan(int(SURFEL_TTL)),
        );

        If(alive, () => {
          const surfel = surfels.element(i);
          const posb = surfel.get('posb');
          const normal = surfel.get('normal');
          // 1. World Space Position
          const worldPos = posb.xyz;

          // 2. Relative Position (Still needed for finding Grid Indices)
          const pRel = worldPos.sub(U_GRID_ORIGIN);
          // const radius = surfel_radius_for_pos(pRel, vec3(0)).toVar();
          const radius = surfel_radius_for_pos(worldPos, U_CAM_POS).toVar();

          // Get Index Bounds (Using pRel)
          const box = get_surfel_grid_box_min_max(pRel).toVar();
          // Loop Cascades
          Loop(
            {
              start: int(0),
              end: int(box.get('cascadeCount')),
              type: 'int',
              name: 'ci',
            },
            ({ ci }) => {
              const isC1 = ci.equal(1);
              const currentMin = select(
                isC1,
                box.get('c1_min'),
                box.get('c0_min'),
              );
              const currentMax = select(
                isC1,
                box.get('c1_max'),
                box.get('c0_max'),
              );

              // Loop Grid X/Y/Z
              Loop(
                {
                  start: int(currentMin.z),
                  end: int(currentMax.z).add(1),
                  name: 'z',
                  type: 'int',
                },
                ({ z }) => {
                  Loop(
                    {
                      start: int(currentMin.y),
                      end: int(currentMax.y).add(1),
                      name: 'y',
                      type: 'int',
                    },
                    ({ y }) => {
                      Loop(
                        {
                          start: int(currentMin.x),
                          end: int(currentMax.x).add(1),
                          name: 'x',
                          type: 'int',
                        },
                        ({ x }) => {
                          const cIdx = currentMin.w;
                          const c4 = uvec4(uint(x), uint(y), uint(z), cIdx);

                          // 3. Check Intersection using WORLD SPACE inputs
                          const intersects = surfel_intersects_grid_coord(
                            worldPos, // World Pos
                            normal,
                            radius,
                            c4,
                            U_GRID_ORIGIN, // Camera World Pos
                          );

                          If(intersects, () => {
                            const hash = surfel_grid_c4_to_hash(c4).toInt();
                            atomicAdd(
                              offsetsAndListAtomic!.element(hash),
                              int(1),
                            );
                          });
                        },
                      );
                    },
                  );
                },
              );
            },
          );
        });
      })()
        .compute(capacity)
        .setName('Grid Count');

      // 3. Scan Passes

      const shared = workgroupArray('int', SEGMENT_SIZE);
      const STEP_COUNT = Math.log2(WORKGROUP_SIZE) + 1;

      computeScanSeg = Fn(() => {
        const lid = localId.x.toInt();
        const seg = workgroupId.x.toInt();
        const base = seg.mul(int(SEGMENT_SIZE));
        const idx2 = lid.mul(int(2));
        const g0 = base.add(idx2);
        const g1 = g0.add(int(1));
        const in0 = g0.lessThan(int(totalCells + 1));
        const in1 = g1.lessThan(int(totalCells + 1));
        shared
          .element(idx2)
          .assign(in0.select(offsetsAndList.element(g0), int(0)));
        shared
          .element(idx2.add(int(1)))
          .assign(in1.select(offsetsAndList.element(g1), int(0)));
        workgroupBarrier();
        Loop(
          { start: int(0), end: int(STEP_COUNT), type: 'int', name: 'step' },
          ({ step }) => {
            const mask = int(1).shiftLeft(step).sub(int(1));
            const rd = lid
              .shiftRight(step)
              .shiftLeft(step.add(int(1)))
              .add(mask);
            const wr = rd.add(int(1)).add(bitAnd(lid, mask));
            const ok = rd
              .lessThan(int(SEGMENT_SIZE))
              .and(wr.lessThan(int(SEGMENT_SIZE)));
            If(ok, () => {
              // Snapshot the READ value into a register variable.
              const neighborVal = shared.element(rd).toVar();
              shared.element(wr).addAssign(neighborVal);
            });
            workgroupBarrier();
          },
        );
        If(in0, () => {
          offsetsAndList.element(g0).assign(shared.element(idx2));
        });
        If(in1, () => {
          offsetsAndList.element(g1).assign(shared.element(idx2.add(int(1))));
        });
      })()
        .computeKernel([WORKGROUP_SIZE, 1, 1])
        .setName('Grid Scan Seg');

      computeCollectSeg = Fn(() => {
        const seg = int(instanceIndex);
        const base = seg.mul(int(SEGMENT_SIZE));
        const last = base.add(int(SEGMENT_SIZE - 1));
        const clampLast = min(last, int(totalCells));
        If(seg.lessThan(int(segments)), () => {
          segSums!.element(seg).assign(offsetsAndList.element(clampLast));
        });
      })()
        .compute(segments)
        .setName('Grid Collect Seg');

      computeSegPrefix = Fn(() => {
        If(localId.x.equal(0), () => {
          let accum = int(0);
          Loop(int(segments), ({ i }) => {
            accum.addAssign(segSums!.element(i));
            segSums!.element(i).assign(accum);
          });
        });
      })()
        .compute(1)
        .setName('Grid Seg Prefix');

      computeMerge = Fn(() => {
        const idx = int(instanceIndex);
        const inRange = idx.lessThan(int(totalCells + 1));
        const seg = idx.div(int(SEGMENT_SIZE));
        const hasPrev = seg.greaterThan(int(0));
        const prevSum = hasPrev.select(
          segSums!.element(seg.sub(int(1))),
          int(0),
        );
        If(inRange.and(hasPrev), () => {
          offsetsAndList
            .element(idx)
            .assign(offsetsAndList.element(idx).add(prevSum));
        });
      })()
        .compute(Math.max(1, totalCells + 1))
        .setName('Grid Merge');

      // 4. Slot
      computeSlot = Fn(() => {
        const i = int(instanceIndex);
        const total = atomicAdd(poolMax.element(0), int(0));
        const inRange = i.lessThan(total);
        const alive = inRange.and(
          surfels.element(i).get('age').lessThan(int(SURFEL_TTL)),
        );

        If(alive, () => {
          const surfel = surfels.element(i);
          const posb = surfel.get('posb');

          // 1. Get Normal
          const normal = surfel.get('normal');

          // 2. World Space Position
          const worldPos = posb.xyz;

          // 3. Relative Position (For Grid Indices)
          const pRel = worldPos.sub(U_GRID_ORIGIN);

          // 4. Radius Calculation (Needed for intersection)
          // Note: surfel_radius_for_pos expects distance from camera, which is length(pRel)
          const radius = surfel_radius_for_pos(worldPos, U_CAM_POS).toVar();

          // 5. Get Multi-Cascade Bounds
          const box = get_surfel_grid_box_min_max(pRel).toVar();

          // 6. Loop Cascades
          Loop(
            {
              start: int(0),
              end: int(box.get('cascadeCount')),
              type: 'int',
              name: 'ci',
            },
            ({ ci }) => {
              const isC1 = ci.equal(1);
              const currentMin = select(
                isC1,
                box.get('c1_min'),
                box.get('c0_min'),
              );
              const currentMax = select(
                isC1,
                box.get('c1_max'),
                box.get('c0_max'),
              );

              Loop(
                {
                  start: int(currentMin.z),
                  end: int(currentMax.z).add(1),
                  name: 'z',
                  type: 'int',
                },
                ({ z }) => {
                  Loop(
                    {
                      start: int(currentMin.y),
                      end: int(currentMax.y).add(1),
                      name: 'y',
                      type: 'int',
                    },
                    ({ y }) => {
                      Loop(
                        {
                          start: int(currentMin.x),
                          end: int(currentMax.x).add(1),
                          name: 'x',
                          type: 'int',
                        },
                        ({ x }) => {
                          const cIdx = currentMin.w;
                          const c4 = uvec4(uint(x), uint(y), uint(z), cIdx);

                          // 7. Intersection Check
                          const intersects = surfel_intersects_grid_coord(
                            worldPos, // World Pos
                            normal,
                            radius,
                            c4,
                            U_GRID_ORIGIN,
                          );

                          If(intersects, () => {
                            const hash = surfel_grid_c4_to_hash(c4);

                            // 8. Atomic Decrement Strategy
                            // 'endPlusOne' is the value BEFORE subtraction.
                            // Example: Offset is 10. Atomic returns 10. Memory becomes 9.
                            // We write to index (10 - 1) = 9.
                            const endPlusOne = atomicAdd(
                              offsetsAndListAtomic!.element(hash),
                              int(-1),
                            );
                            const writeIdx = endPlusOne.sub(int(1));

                            // Safety Check
                            const absoluteIdx = int(OFFSETS_AND_LIST_START).add(
                              writeIdx,
                            );
                            const idxOK = writeIdx
                              .greaterThanEqual(int(0))
                              .and(
                                absoluteIdx.lessThan(
                                  int(offsetsAndListAttr!.count),
                                ),
                              );

                            If(idxOK, () => {
                              atomicStore(
                                offsetsAndListAtomic!.element(absoluteIdx),
                                i,
                              );
                            });
                          });
                        },
                      );
                    },
                  );
                },
              );
            },
          );
        });
      })()
        .compute(capacity)
        .setName('Grid Slot');
    }

    // --- Dispatch Cached Nodes ---
    renderer.compute(computeClear!);
    renderer.compute(computeCount!);
    // 1. Local Scan
    renderer.compute(computeScanSeg!, [segments, 1, 1]);
    // 2. Collect sums of each segment
    renderer.compute(computeCollectSeg!);
    // 3. Compute summed segments
    renderer.compute(computeSegPrefix!);
    // 4. Apply summed segments to offsets
    renderer.compute(computeMerge!);
    renderer.compute(computeSlot!);
  }

  function getOffsetsAndListAttr() {
    return offsetsAndListAttr;
  }
  function getSegmentSumAttr() {
    return segmentSumAttr;
  }

  return {
    getSegmentSumAttr,
    build,
    getOffsetsAndListAttr,
  };
}

export function snap_to_surfel_grid_origin(
  out: THREE.Vector3,
  pos: THREE.Vector3,
) {
  const s = SURFEL_GRID_CELL_DIAMETER;
  out.set(
    Math.floor(pos.x / s) * s + 0.001,
    Math.floor(pos.y / s) * s + 0.001,
    Math.floor(pos.z / s) * s + 0.001,
  );
  // out.copy(pos); // DEBUG
  return out;
}

/* Parallel implementation - not needed right now

// 1. LOCAL SCAN (Downsweep)
        // Scans independent chunks of 1024 items.
        const shared = workgroupArray('int', SEGMENT_SIZE);
        const STEP_COUNT = Math.log2(WORKGROUP_SIZE) + 1;

        computeScanSeg = Fn(() => {
            const lid = localId.x.toInt();
            const seg = workgroupId.x.toInt();
            const base = seg.mul(int(SEGMENT_SIZE));
            const idx2 = lid.mul(int(2));
            const g0 = base.add(idx2);
            const g1 = g0.add(int(1));
            
            // Bounds checks
            const in0 = g0.lessThan(int(totalCells + 1));
            const in1 = g1.lessThan(int(totalCells + 1));
            
            // Load to shared memory
            shared.element(idx2).assign(in0.select(offsets.element(g0), int(0)));
            shared.element(idx2.add(int(1))).assign(in1.select(offsets.element(g1), int(0)));
            workgroupBarrier();

            // Parallel Reduction Tree
            Loop({ start: int(0), end: int(STEP_COUNT), type: 'int', name: 'step' }, ({ step }) => {
                const mask = int(1).shiftLeft(step).sub(int(1));
                const rd = lid.shiftRight(step).shiftLeft(step.add(int(1))).add(mask);
                const wr = rd.add(int(1)).add(bitAnd(lid, mask));
                const ok = rd.lessThan(int(SEGMENT_SIZE)).and(wr.lessThan(int(SEGMENT_SIZE)));
                If(ok, () => {
                  const neighborVal = shared.element(rd).toVar();
                  shared.element(wr).addAssign(neighborVal);
                });
                workgroupBarrier();
            });

            // Write back
            If(in0, () => { offsets.element(g0).assign(shared.element(idx2))});
            If(in1, () => { offsets.element(g1).assign(shared.element(idx2.add(int(1))))});
        })().computeKernel([WORKGROUP_SIZE, 1, 1]).setName('Grid Scan Seg');


        // 2. COLLECT SUMS
        // Grabs the last value of each chunk to prepare for the top-level scan.
        computeCollectSeg = Fn(() => {
            const seg  = int(instanceIndex);
            const base = seg.mul(int(SEGMENT_SIZE));
            const last = base.add(int(SEGMENT_SIZE - 1));
            const clampLast = min(last, int(totalCells));              
            If(seg.lessThan(int(segments)), () => {
                segSums!.element(seg).assign(offsets.element(clampLast));
            });
        })().compute(segments).setName('Grid Collect Seg');


        // 3. TOP-LEVEL SCAN (The Parallel Replacement)
        // Instead of a serial loop, we use the same parallel logic as step 1, 
        // but on the smaller 'segSums' array.
        const PREFIX_WG_SIZE = 256; // Enough to cover 512 segments
        const sharedSeg = workgroupArray('int', PREFIX_WG_SIZE * 2); 

        computeSegPrefix = Fn(() => {
            const tid = localId.x.toInt();
            const idx0 = tid.mul(2);
            const idx1 = tid.mul(2).add(1);

            // Cooperative Load
            const val0 = idx0.lessThan(int(segments)).select(segSums!.element(idx0), int(0));
            const val1 = idx1.lessThan(int(segments)).select(segSums!.element(idx1), int(0));
            sharedSeg.element(idx0).assign(val0);
            sharedSeg.element(idx1).assign(val1);
            workgroupBarrier();

            // Parallel Scan
            const numSteps = Math.ceil(Math.log2(PREFIX_WG_SIZE * 2));
            Loop({ start: int(0), end: int(numSteps), type: 'int', name: 'step' }, ({ step }) => {
                const mask = int(1).shiftLeft(step).sub(1);
                const rd   = tid.shiftRight(step).shiftLeft(step.add(1)).add(mask);
                const wr   = rd.add(1).add(tid.bitAnd(mask));
                If(rd.lessThan(int(PREFIX_WG_SIZE * 2)).and(wr.lessThan(int(PREFIX_WG_SIZE * 2))), () => {
                    const v = sharedSeg.element(rd).toVar();
                    sharedSeg.element(wr).addAssign(v);
                });
                workgroupBarrier();
            });

            // Write Back
            If(idx0.lessThan(int(segments)), () => {
              segSums!.element(idx0).assign(sharedSeg.element(idx0))
            });
            If(idx1.lessThan(int(segments)), () => {
              segSums!.element(idx1).assign(sharedSeg.element(idx1))
            });

        })().computeKernel([PREFIX_WG_SIZE, 1, 1]).setName('Grid Seg Prefix (Parallel)');


        // 4. MERGE (Upsweep)
        // Adds the top-level prefix sums back into the main array blocks.
        computeMerge = Fn(() => {
            const idx     = int(instanceIndex);
            const inRange = idx.lessThan(int(totalCells + 1));
            const seg     = idx.div(int(SEGMENT_SIZE));
            const hasPrev = seg.greaterThan(int(0));
            const prevSum = hasPrev.select(segSums!.element(seg.sub(int(1))), int(0));
            If(inRange.and(hasPrev), () => {
                offsets.element(idx).assign(offsets.element(idx).add(prevSum));
            });
        })().compute(Math.max(1, totalCells + 1)).setName('Grid Merge');

        // 4. Slot
        computeSlot = Fn(() => {
          const i = int(instanceIndex);
          const total = atomicAdd(poolMax.element(0), int(0));
          const inRange = i.lessThan(total);
          const alive = inRange.and(surfels.element(i).get('age').lessThan(int(SURFEL_TTL)));

          If(alive, () => {
              const surfel = surfels.element(i);
              const posb = surfel.get('posb');
              
              // 1. Get Normal
              const normal = surfel.get('normal'); 

              // 2. World Space Position
              const worldPos = posb.xyz; 

              // 3. Relative Position (For Grid Indices)
              const pRel = worldPos.sub(U_CAM_POS);
              
              // 4. Radius Calculation (Needed for intersection)
              // Note: surfel_radius_for_pos expects distance from camera, which is length(pRel)
              const radius = surfel_radius_for_pos(pRel, vec3(0)).toConst();

              // 5. Get Multi-Cascade Bounds
              const box = get_surfel_grid_box_min_max(pRel).toConst();

              // 6. Loop Cascades
              Loop({ start: int(0), end: int(box.get('cascadeCount')), type: 'int', name: 'ci' }, ({ ci }) => {
                  const isC1 = ci.equal(1);
                  const currentMin = select(isC1, box.get('c1_min'), box.get('c0_min'));
                  const currentMax = select(isC1, box.get('c1_max'), box.get('c0_max'));

                  Loop({ start: int(currentMin.z), end: int(currentMax.z).add(1), name: 'z', type: 'int' }, ({ z }) => {
                      Loop({ start: int(currentMin.y), end: int(currentMax.y).add(1), name: 'y', type: 'int' }, ({ y }) => {
                          Loop({ start: int(currentMin.x), end: int(currentMax.x).add(1), name: 'x', type: 'int' }, ({ x }) => {
                              
                              const cIdx = currentMin.w;
                              const c4 = uvec4(uint(x), uint(y), uint(z), cIdx);

                              // 7. Intersection Check
                              const intersects = surfel_intersects_grid_coord(
                                  worldPos,    // World Pos
                                  normal,
                                  radius,
                                  c4,
                                  U_CAM_POS    // Camera World Pos
                              );

                              If(intersects, () => {
                                  const hash = surfel_grid_c4_to_hash(c4);
                                  const cellIdx = hash;
                                  
                                  // 8. Atomic Decrement Strategy
                                  // InterlockedAdd(..., -1, result)
                                  // "result" is the value BEFORE subtraction. 
                                  // Example: Offset is 10. Atomic returns 10. Memory becomes 9.
                                  // We write to index (10 - 1) = 9.
                                  const endPlusOne = atomicAdd(cellCountsAtomic!.element(cellIdx), int(-1));
                                  const writeIdx = endPlusOne.sub(int(1));
                                  
                                  // Safety Check
                                  const idxOK = writeIdx.greaterThanEqual(int(0)).and(writeIdx.lessThan(int(cellToSurfelAttr!.count)));
                                  
                                  If(idxOK, () => {
                                      list.element(writeIdx).assign(i);
                                  });
                              });
                          });
                      });
                  });
              });
          });
        })().compute(capacity).setName('Grid Slot');
    }

*/
