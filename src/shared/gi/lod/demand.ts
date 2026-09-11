import * as THREE from 'three/webgpu';
import type { ChartPlacement } from '../bake/lightmapUv.ts';
import { PAGE_GUTTER } from './pagePool.ts';
import { CELL, type AtlasDemand } from './workingAtlas.ts';


export interface DemandPlan {
  demands: AtlasDemand[];
  visible: number;
  wantedCells: number;
  grantedCells: number;
  coarsened: number;
}

/**
 * @important Space is the scarce thing, not distance. The nearest chart is served its
 * finest mip first and the budget is spent down the priority order, so a chart that is
 * far away is coarsened — or left on its root — because the close one took the room.
 * Sorting by distance alone would fill the atlas with whatever happened to be iterated
 * first and leave the surface under the camera reading a 1-texel average.
 */
export function planAtlas(
  placements: ChartPlacement[],
  camera: THREE.PerspectiveCamera,
  viewportHeight: number,
  options: { metresPerTexel: number; lastMip: (chart: number) => number; sizeOf: (chart: number, mip: number) => { width: number; height: number }; capacityCells: number },
): DemandPlan {
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const pixelsPerRadian = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  const sphere = new THREE.Sphere();

  const wanted: { chart: number; mip: number; priority: number }[] = [];
  for (const [chart, placement] of placements.entries()) {
    const radius = 0.5 * Math.hypot(placement.extentU, placement.extentV);
    sphere.center.copy(placement.centre);
    sphere.radius = radius;
    if (!frustum.intersectsSphere(sphere)) continue;
    const distance = Math.max(camera.position.distanceTo(placement.centre) - radius, 1e-2);
    const pixelsPerTexel = (options.metresPerTexel / distance) * pixelsPerRadian;
    const mip = THREE.MathUtils.clamp(Math.round(-Math.log2(Math.max(pixelsPerTexel, 1e-6))), 0, options.lastMip(chart));
    wanted.push({ chart, mip, priority: pixelsPerTexel / Math.max(distance, 1e-2) });
  }
  wanted.sort((a, b) => b.priority - a.priority);

  const demands: AtlasDemand[] = [];
  let grantedCells = 0;
  let wantedCells = 0;
  let coarsened = 0;
  for (const entry of wanted) {
    wantedCells += cellsFor(options.sizeOf(entry.chart, entry.mip));
    let mip = entry.mip;
    let cells = cellsFor(options.sizeOf(entry.chart, mip));
    while (grantedCells + cells > options.capacityCells && mip < options.lastMip(entry.chart)) {
      mip++;
      cells = cellsFor(options.sizeOf(entry.chart, mip));
      coarsened++;
    }
    if (grantedCells + cells > options.capacityCells) continue;
    grantedCells += cells;
    demands.push({ chart: entry.chart, mip, priority: entry.priority });
  }
  return { demands, visible: wanted.length, wantedCells, grantedCells, coarsened };
}

function cellsFor(size: { width: number; height: number }): number {
  return Math.ceil((size.width + 2 * PAGE_GUTTER) / CELL) * Math.ceil((size.height + 2 * PAGE_GUTTER) / CELL);
}
