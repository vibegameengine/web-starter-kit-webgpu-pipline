import { PAGE_GUTTER } from './pagePool.ts';
import { CELL, type AtlasDemand } from './workingAtlas.ts';
import type { DemandFeedback } from './feedback.ts';

export interface DemandPlan {
  demands: AtlasDemand[];
  visible: number;
  wantedCells: number;
  grantedCells: number;
  coarsened: number;
  rootOnly: number;
}

interface PoolShape {
  lastMip: (chart: number) => number;
  sizeOf: (chart: number, mip: number) => { width: number; height: number };
  capacityCells: number;
}

/**
 * @important The plan is made of what the frame actually read. Every chart in it asked for
 * its level itself, from the derivatives of its own UV in the material, so a surface seen
 * edge-on, through a window or in a mirror asks for exactly what it needs and a surface
 * nobody sampled asks for nothing. The walk this replaces took every chart in the scene,
 * tested it against the frustum and guessed its level from the distance to the camera -
 * the one construction the design names three times as the thing not to repeat.
 *
 * Space is still the scarce thing, and it is spent in two passes. The first gives every
 * chart that was read the coarsest level BETTER than its root - the root is already pinned
 * in the atlas, so granting `lastMip` would spend a cell and a copy to deliver the pixel
 * the chart already reads. The second refines one mip at a time down the shortfall order,
 * so the surface that is furthest from the detail it asked for gets the room first.
 */
export function planAtlas(feedback: DemandFeedback, pool: PoolShape): DemandPlan {
  const wanted: { chart: number; mip: number; shortfall: number }[] = [];
  for (const [chart, requested] of feedback.requests.entries()) {
    const mip = feedback.requested(chart);
    if (mip === null) continue;
    wanted.push({ chart, mip: Math.min(mip, pool.lastMip(chart)), shortfall: pool.lastMip(chart) - requested });
  }
  wanted.sort((a, b) => b.shortfall - a.shortfall);

  let wantedCells = 0;
  for (const entry of wanted) wantedCells += cellsFor(pool.sizeOf(entry.chart, entry.mip));

  const granted = new Map<number, number>();
  let grantedCells = 0;
  for (const entry of wanted) {
    const mip = Math.max(entry.mip, pool.lastMip(entry.chart) - 1);
    const cells = cellsFor(pool.sizeOf(entry.chart, mip));
    if (grantedCells + cells > pool.capacityCells) continue;
    granted.set(entry.chart, mip);
    grantedCells += cells;
  }

  for (let refining = true; refining; ) {
    refining = false;
    for (const entry of wanted) {
      const mip = granted.get(entry.chart);
      if (mip === undefined || mip <= entry.mip) continue;
      const cost = cellsFor(pool.sizeOf(entry.chart, mip - 1)) - cellsFor(pool.sizeOf(entry.chart, mip));
      if (grantedCells + cost > pool.capacityCells) continue;
      granted.set(entry.chart, mip - 1);
      grantedCells += cost;
      refining = true;
    }
  }

  const demands: AtlasDemand[] = [];
  let coarsened = 0;
  let rootOnly = 0;
  for (const [rank, entry] of wanted.entries()) {
    const mip = granted.get(entry.chart);
    if (mip === undefined) { rootOnly++; continue; }
    coarsened += mip - entry.mip;
    demands.push({ chart: entry.chart, mip, rank });
  }
  return { demands, visible: wanted.length, wantedCells, grantedCells, coarsened, rootOnly };
}

function cellsFor(size: { width: number; height: number }): number {
  return Math.ceil((size.width + 2 * PAGE_GUTTER) / CELL) * Math.ceil((size.height + 2 * PAGE_GUTTER) / CELL);
}
