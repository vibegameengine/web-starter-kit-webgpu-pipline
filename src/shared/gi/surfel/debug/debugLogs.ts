// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// --- Surfel debug configuration ----------------------------------

import { MAX_SURFELS, TOTAL_CELLS } from '../constants';

const DEBUG_SURFELS = true;
const DEBUG_SURFELS_INTERVAL = 15; // frames

// --- Central debug helper ----------------------------------------
export async function debugGridIntegrity(renderer, grid) {
  const offsetsAttr = grid.getCellOffsetsAttr();
  const listAttr = grid.getCellToSurfelAttr();
  if (!offsetsAttr || !listAttr) {
    console.warn('Grid not ready yet (no offsets or list).');
    return;
  }

  const [offsetsBuf, listBuf] = await Promise.all([
    renderer.getArrayBufferAsync(offsetsAttr),
    renderer.getArrayBufferAsync(listAttr),
  ]);

  const offsets = new Int32Array(offsetsBuf);
  const list = new Int32Array(listBuf);

  const cellCount = offsets.length - 1; // should equal TOTAL_CELLS
  const listLen = list.length;

  console.log('--- GRID INTEGRITY CHECK ---');
  console.log(
    `cells: ${cellCount}, TOTAL_CELLS constant: ${TOTAL_CELLS}, listLen: ${listLen}`,
  );

  let holes = 0;
  let overflows = 0;
  let badRanges = 0;

  // Optional: monotonicity check
  let nonMonotonic = 0;

  for (let i = 0; i < cellCount; i++) {
    const start = offsets[i];
    const nextStart = offsets[i + 1];
    const count = nextStart - start;

    if (nextStart < start) {
      console.log(
        `❌ Cell ${i}: negative count, start=${start}, next=${nextStart}`,
      );
      overflows++;
      continue;
    }

    if (i > 0 && start < offsets[i - 1]) {
      console.log(
        `❌ Offsets not monotonic at cell ${i}: prev=${offsets[i - 1]}, curr=${start}`,
      );
      nonMonotonic++;
    }

    // Range sanity vs list length
    if (start < 0 || nextStart < 0 || start > listLen || nextStart > listLen) {
      console.log(
        `❌ Cell ${i}: range [${start}, ${nextStart}) is out of list bounds [0, ${listLen})`,
      );
      badRanges++;
      continue;
    }

    for (let k = start; k < nextStart; k++) {
      if (list[k] === -1) holes++;
    }
  }

  // console.log(`Found ${holes} holes (list[k] === -1 inside valid ranges).`);
  // console.log(`Found ${overflows} cells with negative counts.`);
  // console.log(`Found ${badRanges} cells with out-of-range spans.`);
  // console.log(`Found ${nonMonotonic} non-monotonic offsets.`);
}

export async function debugOffsetsStats(renderer, grid) {
  const offsetsAttr = grid.getCellOffsetsAttr();
  const listAttr = grid.getCellToSurfelAttr();
  if (!offsetsAttr || !listAttr) return;

  const offsetsBuf = await renderer.getArrayBufferAsync(offsetsAttr);
  const offsets = new Int32Array(offsetsBuf);
  const cellCount = offsets.length - 1;

  const totalIntersections = offsets[cellCount];
  const listLen = listAttr.count;

  let maxCnt = 0;
  let maxCell = 0;
  let over32 = 0,
    over64 = 0,
    over128 = 0;

  for (let i = 0; i < cellCount; i++) {
    const cnt = offsets[i + 1] - offsets[i];
    if (cnt > maxCnt) {
      maxCnt = cnt;
      maxCell = i;
    }
    if (cnt > 32) over32++;
    if (cnt > 64) over64++;
    if (cnt > 128) over128++;
  }

  console.log('[Grid offsets]', {
    cellCount,
    totalIntersections,
    listLen,
    overflow: totalIntersections > listLen,
    maxCnt,
    maxCell,
    over32,
    over64,
    over128,
  });
}

export async function debugSurfelSystem(
  renderer: WebGPURenderer,
  surfelPool: SurfelPool,
  grid: SurfelHashGrid,
  findMissingPass: SurfelFindMissingPass,
) {
  if (!DEBUG_SURFELS) return;

  const frame = renderer.info.frame;

  // debugGridIntegrity(renderer, grid)

  // Only log every N frames
  if (frame % DEBUG_SURFELS_INTERVAL !== 0) return;
  // return;
  const surfelAttr = surfelPool.getSurfelAttr();
  const tileAllocAttr = findMissingPass.getTileAllocAttr();
  const offsetsAttr = grid.getCellOffsetsAttr();
  const execAttr = surfelPool.getDebugExecAttr(); // Get buffer

  if (!surfelAttr) return;

  // --- Read back life + surfel buffers (this reuses your old logic) ---
  const promises: Promise<ArrayBuffer>[] = [
    renderer.getArrayBufferAsync(surfelAttr),
  ];

  if (tileAllocAttr) {
    promises.push(renderer.getArrayBufferAsync(tileAllocAttr));
  }

  const [surfelBuf, tileBuf] = await Promise.all(promises);

  const surfels = new Float32Array(surfelBuf); // [posX,posY,posZ,R, norX,norY,norZ,ageint]
  const surfelsI32 = new Int32Array(surfelBuf);
  const capacity = surfels.length / 8;

  let aliveCount = 0; // life < SURFEL_LIFE_RECYCLE
  let recycleFlagCount = 0; // life == SURFEL_LIFE_RECYCLE
  let recycledCount = 0; // life == SURFEL_LIFE_RECYCLED

  // STATS TRACKING
  let minAge = 999999999;
  let maxAge = -999999999;
  let weirdAges = 0;
  const sampleAges = [];
  const samplePositions = [];
  const sampleNormals = [];

  for (let i = 0; i < capacity; i++) {
    // 8 ints per surfel. Index 7 is Age.
    const ageVal = surfelsI32[i * 8 + 7];

    // Check for the "Recycled" flag
    if (ageVal === SURFEL_LIFE_RECYCLE) {
      recycleFlagCount++;
    } else if (ageVal === SURFEL_LIFE_RECYCLED) {
      recycledCount++;
    } else {
      // IT IS ALIVE
      aliveCount++;

      if (ageVal < minAge) minAge = ageVal;
      if (ageVal > maxAge) maxAge = ageVal;

      const positionX = surfels[i * 8].toFixed(2);
      const positionY = surfels[i * 8 + 1].toFixed(2);
      const positionZ = surfels[i * 8 + 2].toFixed(2);

      const normalX = surfels[i * 8 + 4].toFixed(2);
      const normalY = surfels[i * 8 + 5].toFixed(2);
      const normalZ = surfels[i * 8 + 6].toFixed(2);

      // Grab a few samples
      if (sampleAges.length < 128) {
        sampleAges.push(ageVal);
        samplePositions.push([positionX, positionY, positionZ]);
        sampleNormals.push([normalX, normalY, normalZ]);
      }

      // Sanity Check: Age should be 0..100
      // If it's effectively random garbage (huge ints), it proves memory corruption
      if (ageVal < 0 || ageVal > 1000) {
        weirdAges++;
      }
    }
  }

  // console.log('--- POOL HEALTH ---');
  // console.log(`Alive: ${aliveCount}, Recycled: ${recycledCount}, Flagged: ${recycleFlagCount}`);
  // console.log(`Age Range: [${minAge}, ${maxAge}]`);
  // console.log(`Weird/Corrupt Ages (>1000 or <0): ${weirdAges}`);
  // console.log(`Sample Ages:`, sampleAges);
  // console.log(`Sample Pos:`, JSON.stringify(samplePositions));
  // console.log(`Sample Nor:`, JSON.stringify(sampleNormals));

  let minR = Number.POSITIVE_INFINITY;
  let maxR = 0;

  // --- Spawn request stats (reuses your tileAllocAttr logic) ---
  let spawnTiles = 0;
  let spawnTilesUndefined = 0;
  let totalInts = 0;
  let despawnTiles = 0;
  if (tileAllocAttr && tileBuf) {
    const tileAlloc = new Int32Array(tileBuf);
    // tileAlloc.length is the absolute truth of how many integers you have
    totalInts = tileAlloc.length;

    // We step by 2 because your data is [spawnFlag, cellIndex, spawnFlag, cellIndex...]
    for (let i = 0; i < totalInts; i += 2) {
      const flag = tileAlloc[i];
      // const cellIndex = tileAlloc[i+1]; // If you needed the cell index

      if (flag === undefined) {
        spawnTilesUndefined++;
      } else if (flag == 1) {
        spawnTiles++;
      } else if (flag == -1) {
        despawnTiles++;
      }
    }
  }

  // --- Optional: validate grid vs alive counter (reuses your old check) ---
  let validationInfo: string | null = null;
  if (offsetsAttr && surfelPool.getAliveAtomic) {
    const [gridBuf, aliveBuf] = await Promise.all([
      renderer.getArrayBufferAsync(offsetsAttr),
      renderer.getArrayBufferAsync(surfelPool.getAliveAtomic()!.value),
    ]);

    const gridCounts = new Int32Array(gridBuf);
    const totalAlive = new Int32Array(aliveBuf)[0];

    // Last entry of the pre-scan counts often holds the sum (as you noted)
    const totalGridCount = gridCounts[gridCounts.length - 1];
    const ratio = totalAlive > 0 ? totalGridCount / totalAlive : 0;
    // console.log(gridCounts)

    validationInfo = `GPU Alive: ${totalAlive} | Grid Sum: ${totalGridCount} | Ratio: ${ratio.toFixed(
      2,
    )}`;

    if (validationInfo) {
      console.log('[Validation: Count]', validationInfo);
    }

    // if (ratio > 8.0) {
    //   console.log(
    //     '❌ CRITICAL: surfels are being counted in too many cells! Check loop logic.'
    //   );
    // } else {
    //   console.log(
    //     '✅ Count Pass seems sane (Ratio < 8). High cell counts are likely just high surfel density.'
    //   );
    // }
  }

  // --- Pretty logging ----------------------------------------------------
  console.log(`%c[Surfel] frame=${frame}`, 'color:#0ff;font-weight:bold');

  console.log('Pool / Life:', {
    capacity,
    alive: aliveCount,
    recycleFlag: recycleFlagCount,
    recycled: recycledCount,
    aliveRatio: capacity > 0 ? (aliveCount / capacity).toFixed(3) : 'n/a',
  });

  if (totalInts > 0) {
    console.log('Spawn tiles:', {
      requested: spawnTiles,
      spawnTilesUndefined: spawnTilesUndefined,
      totalInts,
      spawnRatio: (spawnTiles / (totalInts / 2)).toFixed(3),
      despawnTiles: despawnTiles,
    });
  }

  const poolAllocBuf = await renderer.getArrayBufferAsync(
    surfelPool.getPoolAllocAtomic().value,
  );
  const allocCount = new Int32Array(poolAllocBuf)[0];
  console.log('Pool Alloc Count:', allocCount, '/', MAX_SURFELS);
}
