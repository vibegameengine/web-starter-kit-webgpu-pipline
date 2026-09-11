import * as THREE from 'three/webgpu';
import { Layer } from '../../world/index.ts';
import type { LightmapRegion } from './chartPadding.ts';

export interface LightmapChart {
  mesh: THREE.Mesh;
  /** Index of the first atlas texel this mesh occupies (charts are counted in texels). */
  firstCell: number;
  cellCount: number;
}

export interface ChartPlacement {
  mesh: THREE.Mesh;
  page: number;
  region: LightmapRegion;
  centre: THREE.Vector3;
  extentU: number;
  extentV: number;
}

export interface LightmapLayout {
  charts: LightmapChart[];
  regions: LightmapRegion[];
  pageOfRegion: number[];
  pages: number;
  atlasHeight: number;
  placements: ChartPlacement[];
  /** Highest mip whose downsampling blocks cannot cross chart rectangles. */
  safeMip: number;
  /** Texels per atlas row/column. */
  gridSide: number;
  cellCount: number;
  /** Static world area that got a chart, in m². */
  mappedArea: number;
  /** Static world area that was refused a chart, in m². */
  refusedArea: number;
  /** Atlas resolution the density figures below were reported against. */
  atlasSize: number;
  /** Metres per texel the charts were laid out at. */
  metresPerTexel: number;
}

/**
 * Metres per texel past which this atlas is not worth baking.
 *
 * Not a quality target — a refusal. At 0.5 m/texel a texel is wider than a person and
 * nothing resembling a contact shadow, a foliage shadow or a colour bleed survives, so
 * a lightmap at that density is not a cheaper version of the GI, it is a different and
 * wrong image. The Cornell box measures 0.063; the 400 m landscape measured 1.634.
 */
const REFUSE_METRES_PER_TEXEL = 0.5;

/** Fraction of the atlas the packer aims to fill before it starts coarsening. */
const TARGET_FILL = 0.78;

const DEGENERATE_EXTENT = 1e-4;

const LAYER_GRID = 256;

const FOLD_SEPARATION_METRES = 0.25;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _uv = new THREE.Vector2();

/**
 * One rectangle in the atlas. Every chart is described the same way whatever produced
 * it, so the packer has one job: `extentU × extentV` metres go into `w × h` texels, and
 * `write` receives the placement and fills `uv1` for the vertices it owns.
 */
interface ChartRequest {
  mesh: THREE.Mesh;
  /** World extent of the chart along its two atlas axes, in metres. */
  extentU: number;
  extentV: number;
  area: number;
  centre: THREE.Vector3;
  /** Assigned by the layout pass. */
  w: number;
  h: number;
  x: number;
  y: number;
  page: number;
  /** Maps a vertex index to its position inside the chart, in metres from the corner. */
  local: (vertex: number, out: THREE.Vector2) => void;
  vertices: number[];
}

/**
 * Assigns lightmap UVs to every static mesh, one atlas for the whole scene.
 *
 * Two kinds of chart:
 *
 *   quads     — box-like geometry whose faces already carry a clean 0..1 UV per four
 *               vertices (BoxGeometry, the Cornell set). Each quad becomes one square
 *               chart, distortion-free.
 *   projected — anything else. Triangles are binned by the dominant axis of their
 *               world normal and each bin is projected onto the plane perpendicular to
 *               it. A heightfield gives one +Y chart with no distortion worth naming; a
 *               rock gives up to six charts whose only defect is a stretch on faces
 *               that lean past 45°, and an overlap where the surface folds back on
 *               itself along the same axis. Both are bounded and visible, unlike the
 *               failures a scene without any chart at all produces.
 *
 * Every chart is laid out at ONE density (`metresPerTexel`), found by packing: start
 * from the density that would fill `TARGET_FILL` of the atlas and coarsen until the
 * shelf packer succeeds. Rectangles are aligned to the coarsest supported mip;
 * vertices stay inside its first/last texel centres. Chart-local padding then makes
 * ordinary box-filtered mip levels safe without per-frame chart lookup tables.
 *
 *   NOT  — `InstancedMesh` has one `uv1` shared by every instance and a lightmap stores
 *          world-space radiance, so a shared chart would light every instance with the
 *          first one's lighting. Instanced meshes are refused a chart and say so; the
 *          runtime surfel path lights them.
 *   NOT  — `userData.lightmap === false` opts a mesh out (foliage, undersides): it
 *          stays in the tracer as an occluder and bouncer but is lit live.
 */
export function assignLightmapUvs(
  scene: THREE.Scene,
  options: { padding?: number; atlasSize?: number; filterMip?: number; maxPages?: number } = {},
): LightmapLayout {
  const atlasSize = options.atlasSize ?? 512;
  const safeMip = options.filterMip ?? Math.log2(atlasSize / Math.min(128, atlasSize / 2));
  if (!Number.isInteger(safeMip) || safeMip < 0 || safeMip > Math.log2(atlasSize) - 1) throw new Error('Invalid lightmap filter mip');
  const alignment = 2 ** safeMip;
  // At the coarsest mip a bilinear tap must still stay inside its own rectangle.
  // Extra base-level separation also isolates the baker's 3x3 denoiser.
  const inset = Math.max(1.5, alignment * .5, options.padding ?? 0);

  scene.updateMatrixWorld(true);

  const meshes: THREE.Mesh[] = [];
  let refusedArea = 0;
  let refusedInstances = 0;
  let refusedMeshes = 0;

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    if (!mesh.layers.isEnabled(Layer.GiStatic)) return;
    if (mesh.userData.lightmap === false) return;

    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      const instanced = mesh as THREE.InstancedMesh;
      refusedInstances += instanced.count;
      refusedMeshes++;
      const geometry = mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const size = geometry.boundingBox!.getSize(new THREE.Vector3());
      refusedArea +=
        2 * (size.x * size.y + size.y * size.z + size.z * size.x) * instanced.count;
      return;
    }

    meshes.push(mesh);
  });

  if (refusedMeshes > 0) {
    console.error(
      `[lightmap] ${refusedMeshes} InstancedMesh(es) carrying ${refusedInstances} ` +
        `instances (~${refusedArea.toFixed(0)} m²) were refused a lightmap chart. An ` +
        'InstancedMesh has ONE uv1 shared by every instance and a lightmap stores ' +
        'world-space radiance, so a shared chart would light every instance with the ' +
        "first one's lighting. They are left to the runtime surfel path.",
    );
  }

  const requests: ChartRequest[] = [];
  let mappedArea = 0;

  let degenerateIslands = 0;
  for (const mesh of meshes) {
    const mode = chartMode(mesh);
    const built = mode === 'quads' ? quadCharts(mesh) : projectedCharts(mesh);
    for (const chart of built.charts) requests.push(chart);
    mappedArea += built.area;
    degenerateIslands += built.degenerate;
  }
  if (degenerateIslands > 0) {
    console.warn(`[lightmap] ${degenerateIslands} island(s) project to a line and were refused a chart; they are lit live`);
  }

  if (requests.length === 0) {
    console.warn('[lightmap] nothing static could be charted; atlas will be empty');
    return {
      charts: [],
      regions: [],
      pageOfRegion: [],
      pages: 0,
      atlasHeight: atlasSize,
      placements: [],
      safeMip,
      gridSide: atlasSize,
      cellCount: 0,
      mappedArea: 0,
      refusedArea,
      atlasSize,
      metresPerTexel: 0,
    };
  }

  // @important The old loop coarsened `metresPerTexel` until the charts fitted one 512
  // atlas, which is the step the streaming design replaces: charts must not be shrunk to
  // fit a chosen atlas. Splitting folded bins raised the chart count and that loop
  // answered by taking the corridor from 0.1156 to 0.1856 m/texel, eight texels for a
  // whole bench seat. The atlas grows instead, up to `maxAtlasSize`.
  const maxPages = options.maxPages ?? 8;
  const metresPerTexel = Math.sqrt(mappedArea / (TARGET_FILL * atlasSize * atlasSize));
  const placed: ChartRequest[] = requests;
  for (const chart of placed) {
    chart.w = Math.max(2 * alignment, Math.ceil((chart.extentU / metresPerTexel + 2 * inset) / alignment) * alignment);
    chart.h = Math.max(2 * alignment, Math.ceil((chart.extentV / metresPerTexel + 2 * inset) / alignment) * alignment);
  }
  const pages = packPages(placed, atlasSize, alignment, maxPages);
  if (pages === 0) {
    throw new Error(`[lightmap] a single chart is larger than a ${atlasSize}² page at ${metresPerTexel.toFixed(4)} m/texel`);
  }
  const atlasHeight = atlasSize * pages;
  const measurable = new Set(placed.filter((chart) => coversTexelCentre(chart, inset)));
  const drawn = placed.filter((chart) => measurable.has(chart));
  const rehomed = requests.filter((chart) => !measurable.has(chart));

  // --- write uv1 ----------------------------------------------------------------
  const perMesh = new Map<THREE.Mesh, { uv1: Float32Array; bounds: Float32Array; chart: Float32Array; page: Float32Array; texels: number }>();
  const local = new THREE.Vector2();

  for (const [index, chart] of drawn.entries()) {
    const geometry = chart.mesh.geometry;
    const count = geometry.getAttribute('position').count;
    let entry = perMesh.get(chart.mesh);
    if (!entry) {
      entry = { uv1: new Float32Array(count * 2), bounds: new Float32Array(count * 4), chart: new Float32Array(count).fill(-1), page: new Float32Array(count).fill(-1), texels: 0 };
      perMesh.set(chart.mesh, entry);
    }
    entry.texels += chart.w * chart.h;

    const spanU = Math.max(chart.w - 2 * inset, 1e-3);
    const spanV = Math.max(chart.h - 2 * inset, 1e-3);
    const scaleU = chart.extentU > 1e-6 ? spanU / chart.extentU : 0;
    const scaleV = chart.extentV > 1e-6 ? spanV / chart.extentV : 0;
    const pageRow = chart.page * atlasSize;
    const filterBounds = [(chart.x + alignment * .5) / atlasSize, (pageRow + chart.y + alignment * .5) / atlasHeight,
      (chart.x + chart.w - alignment * .5) / atlasSize, (pageRow + chart.y + chart.h - alignment * .5) / atlasHeight];

    for (const vertex of chart.vertices) {
      chart.local(vertex, local);
      const u = chart.x + inset + local.x * scaleU;
      const v = pageRow + chart.y + inset + local.y * scaleV;
      entry.uv1[vertex * 2 + 0] = u / atlasSize;
      entry.uv1[vertex * 2 + 1] = v / atlasHeight;
      entry.chart[vertex] = index;
      entry.page[vertex] = chart.page;
      // Constant within each chart. All line-filter taps stay inside the
      // coarsest mip's texel centres, including when only fallback is resident.
      entry.bounds.set(filterBounds, vertex * 4);
    }
  }

  let homeless = 0;
  for (const sliver of rehomed) {
    const entry = perMesh.get(sliver.mesh);
    const host = nearestChart(drawn, sliver);
    if (!entry || !host) { homeless++; continue; }
    const hostRow = host.page * atlasSize;
    const u = (host.x + host.w * .5) / atlasSize;
    const v = (hostRow + host.y + host.h * .5) / atlasHeight;
    const filterBounds = [(host.x + alignment * .5) / atlasSize, (hostRow + host.y + alignment * .5) / atlasHeight,
      (host.x + host.w - alignment * .5) / atlasSize, (hostRow + host.y + host.h - alignment * .5) / atlasHeight];
    for (const vertex of sliver.vertices) {
      entry.uv1[vertex * 2 + 0] = u;
      entry.uv1[vertex * 2 + 1] = v;
      entry.bounds.set(filterBounds, vertex * 4);
      entry.chart[vertex] = drawn.indexOf(host);
      entry.page[vertex] = host.page;
    }
  }
  if (rehomed.length > 0) {
    console.warn(
      `[lightmap] ${rehomed.length} island(s) cover less than one texel at ` +
        `${metresPerTexel.toFixed(4)} m/texel; they read their nearest charted neighbour` +
        (homeless > 0 ? `, ${homeless} of them had none and are unlit` : ''),
    );
  }

  const charts: LightmapChart[] = [];
  let cursor = 0;
  for (const [mesh, entry] of perMesh) {
    mesh.geometry.setAttribute('uv1', new THREE.BufferAttribute(entry.uv1, 2));
    mesh.geometry.setAttribute('lightmapBounds', new THREE.BufferAttribute(entry.bounds, 4));
    mesh.geometry.setAttribute('lightmapChart', new THREE.BufferAttribute(entry.chart, 1));
    mesh.geometry.setAttribute('lightmapPage', new THREE.BufferAttribute(entry.page, 1));
    charts.push({ mesh, firstCell: cursor, cellCount: entry.texels });
    cursor += entry.texels;
  }

  console.log(
    `[lightmap] ${perMesh.size} meshes, ${requests.length} charts, ` +
      `${mappedArea.toFixed(1)} m² mapped, ${metresPerTexel.toFixed(4)} m/texel at ` +
      `${atlasSize}², ${((cursor / (atlasSize * atlasSize)) * 100).toFixed(0)}% of atlas used`,
  );

  if (metresPerTexel > REFUSE_METRES_PER_TEXEL) {
    console.error(
      `[lightmap] ${metresPerTexel.toFixed(3)} m/texel is past the ` +
        `${REFUSE_METRES_PER_TEXEL} m/texel this atlas is worth baking at. A texel now ` +
        'covers more ground than a person stands on, so no contact shadow and no colour ' +
        'bleed survives it. Raise ?lm= or take large surfaces out of the bake.',
    );
  }

  return {
    charts,
    regions: drawn.map(c => ({ x: c.x, y: c.page * atlasSize + c.y, width: c.w, height: c.h })),
    pageOfRegion: drawn.map(c => c.page),
    pages,
    atlasHeight,
    placements: drawn.map(c => ({ mesh: c.mesh, page: c.page, region: { x: c.x, y: c.page * atlasSize + c.y, width: c.w, height: c.h }, centre: c.centre, extentU: c.extentU, extentV: c.extentV })),
    safeMip,
    gridSide: atlasSize,
    cellCount: cursor,
    mappedArea,
    refusedArea,
    atlasSize,
    metresPerTexel,
  };
}

/**
 * @important The bake rasterises charts on the GPU, so a chart that covers no texel
 * CENTRE is never measured and `padLightmapCharts` refuses to invent its light. Area is
 * not enough: a 1.5 x 4.5 m island of bevel slivers on the corridor's Plane002_1 has
 * area above a texel and still rasterises nothing.
 */
function coversTexelCentre(chart: ChartRequest, inset: number): boolean {
  if (chart.vertices.length % 3 !== 0) return true;
  const spanU = Math.max(chart.w - 2 * inset, 1e-3);
  const spanV = Math.max(chart.h - 2 * inset, 1e-3);
  const scaleU = chart.extentU > 1e-6 ? spanU / chart.extentU : 0;
  const scaleV = chart.extentV > 1e-6 ? spanV / chart.extentV : 0;
  const u = [0, 0, 0];
  const v = [0, 0, 0];
  for (let triangle = 0; triangle + 2 < chart.vertices.length; triangle += 3) {
    for (let corner = 0; corner < 3; corner++) {
      chart.local(chart.vertices[triangle + corner], _uv);
      u[corner] = chart.x + inset + _uv.x * scaleU;
      v[corner] = chart.y + inset + _uv.y * scaleV;
    }
    const twice = (u[1] - u[0]) * (v[2] - v[0]) - (u[2] - u[0]) * (v[1] - v[0]);
    if (Math.abs(twice) < 1e-9) continue;
    for (let y = Math.floor(Math.min(v[0], v[1], v[2])); y <= Math.ceil(Math.max(v[0], v[1], v[2])); y++) {
      for (let x = Math.floor(Math.min(u[0], u[1], u[2])); x <= Math.ceil(Math.max(u[0], u[1], u[2])); x++) {
        const px = x + .5;
        const py = y + .5;
        const a = ((u[1] - px) * (v[2] - py) - (u[2] - px) * (v[1] - py)) / twice;
        const b = ((u[2] - px) * (v[0] - py) - (u[0] - px) * (v[2] - py)) / twice;
        if (a > 1e-6 && b > 1e-6 && 1 - a - b > 1e-6) return true;
      }
    }
  }
  return false;
}

function nearestChart(charts: ChartRequest[], sliver: ChartRequest): ChartRequest | null {
  let best: ChartRequest | null = null;
  let bestDistance = Infinity;
  for (const chart of charts) {
    if (chart.mesh !== sliver.mesh) continue;
    const distance = chart.centre.distanceToSquared(sliver.centre);
    if (distance < bestDistance) { bestDistance = distance; best = chart; }
  }
  return best;
}

function chartMode(mesh: THREE.Mesh): 'quads' | 'projected' {
  const forced = mesh.userData.lightmapCharts as string | undefined;
  if (forced === 'quads' || forced === 'projected') return forced;
  const geometry = mesh.geometry;
  const uv = geometry.getAttribute('uv');
  // BoxGeometry: 24 vertices in groups of four, each group one face with a 0..1 UV.
  if (geometry.type === 'BoxGeometry' && uv && uv.count % 4 === 0) return 'quads';
  return 'projected';
}

/** One square chart per four consecutive vertices, keyed on the face's own 0..1 UV. */
function quadCharts(mesh: THREE.Mesh): { charts: ChartRequest[]; area: number; degenerate: number } {
  const geometry = mesh.geometry;
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const charts: ChartRequest[] = [];
  let area = 0;

  for (let base = 0; base + 3 < position.count; base += 4) {
    _a.fromBufferAttribute(position, base).applyMatrix4(mesh.matrixWorld);
    _b.fromBufferAttribute(position, base + 1).applyMatrix4(mesh.matrixWorld);
    _c.fromBufferAttribute(position, base + 2).applyMatrix4(mesh.matrixWorld);
    const d = new THREE.Vector3()
      .fromBufferAttribute(position, base + 3)
      .applyMatrix4(mesh.matrixWorld);
    const quadArea =
      0.5 * _e1.subVectors(_b, _a).cross(_e2.subVectors(_c, _a)).length() +
      0.5 * _e1.subVectors(_c, d).cross(_e2.subVectors(_b, d)).length();
    area += quadArea;
    const side = Math.sqrt(Math.max(quadArea, 1e-8));
    charts.push({
      mesh,
      extentU: side,
      extentV: side,
      area: quadArea,
      centre: new THREE.Vector3().add(_a).add(_b).add(_c).add(d).multiplyScalar(.25),
      w: 1,
      h: 1,
      x: 0,
      y: 0,
      page: 0,
      vertices: [base, base + 1, base + 2, base + 3],
      local: (vertex, out) => out.set(uv.getX(vertex) * side, uv.getY(vertex) * side),
    });
  }
  return { charts, area, degenerate: 0 };
}

/**
 * Bins triangles by dominant world-normal axis and projects each bin onto the plane
 * perpendicular to it. Converts the geometry to non-indexed first, because a vertex
 * shared between two bins would need two different `uv1` values.
 */
function projectedCharts(mesh: THREE.Mesh): { charts: ChartRequest[]; area: number; degenerate: number } {
  if (mesh.geometry.index) mesh.geometry = mesh.geometry.toNonIndexed();
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const world = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    _a.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    world[i * 3] = _a.x;
    world[i * 3 + 1] = _a.y;
    world[i * 3 + 2] = _a.z;
  }

  const live: number[] = [];
  let area = 0;
  for (let tri = 0; tri + 2 < position.count; tri += 3) {
    _a.fromArray(world, tri * 3);
    _b.fromArray(world, (tri + 1) * 3);
    _c.fromArray(world, (tri + 2) * 3);
    _n.crossVectors(_e1.subVectors(_b, _a), _e2.subVectors(_c, _a));
    const triArea = 0.5 * _n.length();
    if (triArea < 1e-10) continue;
    area += triArea;
    live.push(tri, tri + 1, tri + 2);
  }

  const charts: ChartRequest[] = [];
  let degenerate = 0;
  for (const island of connectedIslands(live, world)) {
    for (const chart of chartsForIsland(mesh, island, world)) {
      if (chart.extentU < DEGENERATE_EXTENT || chart.extentV < DEGENERATE_EXTENT) { degenerate++; continue; }
      charts.push(chart);
    }
  }
  return { charts, area, degenerate };
}

/**
 * @important One connected surface, one chart, on its OWN plane. Binning by the six world
 * axes cuts a curved bench into slivers along the 45 degree lines, and each sliver became
 * a minimum 8x8 chart with four usable texels, so neighbouring pieces of one smooth
 * surface carried means that differed 14-fold and the frame showed a hard seam across the
 * curve. A component only falls back to axis bins when it folds onto itself in its own
 * projection, which is what a closed box does and a bench does not.
 */
function chartsForIsland(mesh: THREE.Mesh, island: number[], world: Float32Array): ChartRequest[] {
  const basis = islandBasis(island, world);
  if (basis && !foldsOnItself(island, world, basis)) return [basisChart(mesh, island, world, basis)];

  const bins: number[][] = [[], [], [], [], [], []];
  for (let tri = 0; tri + 2 < island.length; tri += 3) {
    _a.fromArray(world, island[tri] * 3);
    _b.fromArray(world, island[tri + 1] * 3);
    _c.fromArray(world, island[tri + 2] * 3);
    _n.crossVectors(_e1.subVectors(_b, _a), _e2.subVectors(_c, _a));
    const ax = Math.abs(_n.x);
    const ay = Math.abs(_n.y);
    const az = Math.abs(_n.z);
    const bin = ay >= ax && ay >= az ? (_n.y >= 0 ? 2 : 3) : ax >= az ? (_n.x >= 0 ? 0 : 1) : (_n.z >= 0 ? 4 : 5);
    bins[bin].push(island[tri], island[tri + 1], island[tri + 2]);
  }
  const planeAxes: Array<[number, number]> = [[2, 1], [2, 1], [0, 2], [0, 2], [0, 1], [0, 1]];
  const charts: ChartRequest[] = [];
  for (let bin = 0; bin < 6; bin++) {
    if (bins[bin].length === 0) continue;
    const [iu, iv] = planeAxes[bin];
    for (const piece of connectedIslands(bins[bin], world)) {
      charts.push(islandChart(mesh, piece, world, iu, iv));
    }
  }
  return charts;
}

interface ChartBasis { u: THREE.Vector3; v: THREE.Vector3; n: THREE.Vector3 }

function islandBasis(island: number[], world: Float32Array): ChartBasis | null {
  const normal = new THREE.Vector3();
  for (let tri = 0; tri + 2 < island.length; tri += 3) {
    _a.fromArray(world, island[tri] * 3);
    _b.fromArray(world, island[tri + 1] * 3);
    _c.fromArray(world, island[tri + 2] * 3);
    normal.add(_n.crossVectors(_e1.subVectors(_b, _a), _e2.subVectors(_c, _a)));
  }
  if (normal.lengthSq() < 1e-12) return null;
  normal.normalize();
  const seed = Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(seed, normal).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u).normalize();
  return { u, v, n: normal };
}

function foldsOnItself(island: number[], world: Float32Array, basis: ChartBasis): boolean {
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  const point = new THREE.Vector3();
  const project = (vertex: number) => {
    point.fromArray(world, vertex * 3);
    return { u: point.dot(basis.u), v: point.dot(basis.v), depth: point.dot(basis.n) };
  };
  for (const vertex of island) {
    const p = project(vertex);
    if (p.u < minU) minU = p.u;
    if (p.u > maxU) maxU = p.u;
    if (p.v < minV) minV = p.v;
    if (p.v > maxV) maxV = p.v;
  }
  const spanU = Math.max(maxU - minU, 1e-6);
  const spanV = Math.max(maxV - minV, 1e-6);
  const grid = new Float32Array(LAYER_GRID * LAYER_GRID).fill(Number.NaN);
  for (let tri = 0; tri + 2 < island.length; tri += 3) {
    let depth = 0;
    let cellMinX = LAYER_GRID, cellMaxX = -1, cellMinY = LAYER_GRID, cellMaxY = -1;
    for (let corner = 0; corner < 3; corner++) {
      const p = project(island[tri + corner]);
      depth += p.depth / 3;
      const x = Math.min(LAYER_GRID - 1, Math.max(0, Math.floor(((p.u - minU) / spanU) * LAYER_GRID)));
      const y = Math.min(LAYER_GRID - 1, Math.max(0, Math.floor(((p.v - minV) / spanV) * LAYER_GRID)));
      cellMinX = Math.min(cellMinX, x); cellMaxX = Math.max(cellMaxX, x);
      cellMinY = Math.min(cellMinY, y); cellMaxY = Math.max(cellMaxY, y);
    }
    for (let y = cellMinY; y <= cellMaxY; y++) {
      for (let x = cellMinX; x <= cellMaxX; x++) {
        const held = grid[y * LAYER_GRID + x];
        if (!Number.isNaN(held) && Math.abs(held - depth) > FOLD_SEPARATION_METRES) return true;
        grid[y * LAYER_GRID + x] = depth;
      }
    }
  }
  return false;
}

function basisChart(mesh: THREE.Mesh, island: number[], world: Float32Array, basis: ChartBasis): ChartRequest {
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  const centre = new THREE.Vector3();
  const point = new THREE.Vector3();
  for (const vertex of island) {
    point.fromArray(world, vertex * 3);
    const u = point.dot(basis.u);
    const v = point.dot(basis.v);
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
    centre.addScaledVector(point, 1 / island.length);
  }
  let projected = 0;
  for (let tri = 0; tri + 2 < island.length; tri += 3) {
    const corners = [0, 1, 2].map((corner) => {
      point.fromArray(world, island[tri + corner] * 3);
      return { u: point.dot(basis.u), v: point.dot(basis.v) };
    });
    projected += Math.abs(
      (corners[1].u - corners[0].u) * (corners[2].v - corners[0].v) -
      (corners[2].u - corners[0].u) * (corners[1].v - corners[0].v),
    ) * .5;
  }
  return {
    mesh,
    extentU: maxU - minU,
    extentV: maxV - minV,
    area: projected,
    centre,
    w: 1,
    h: 1,
    x: 0,
    y: 0,
    page: 0,
    vertices: island,
    local: (vertex, out) => {
      point.fromArray(world, vertex * 3);
      out.set(point.dot(basis.u) - minU, point.dot(basis.v) - minV);
    },
  };
}

/**
 * @important A bin is every triangle whose normal leans the same way, which is not one
 * surface: the two ends of a bench both face +X, and one shared projection puts them on
 * the same texels, so each is lit by the other. Measured on `?scene=corridor&cam=bench`
 * before this split: 108 of the bench's 346 atlas texels carried two surfaces up to
 * 1.47 m apart, the floor 12055 of 12521 up to 18 m apart (`scripts/_lm_overlap.mjs`).
 */
function connectedIslands(vertices: number[], world: Float32Array): number[][] {
  const parent = new Map<number, number>();
  const find = (vertex: number): number => {
    let root = vertex;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let step = vertex; step !== root; ) { const next = parent.get(step)!; parent.set(step, root); step = next; }
    return root;
  };

  const owner = new Map<string, number>();
  for (let triangle = 0; triangle < vertices.length; triangle += 3) {
    const head = vertices[triangle];
    if (!parent.has(head)) parent.set(head, head);
    for (let corner = 0; corner < 3; corner++) {
      const vertex = vertices[triangle + corner];
      const key = `${Math.round(world[vertex * 3] * 1e4)},${Math.round(world[vertex * 3 + 1] * 1e4)},${Math.round(world[vertex * 3 + 2] * 1e4)}`;
      const seen = owner.get(key);
      if (seen === undefined) { owner.set(key, head); continue; }
      const a = find(head);
      const b = find(seen);
      if (a !== b) parent.set(b, a);
    }
  }

  const islands = new Map<number, number[]>();
  for (let triangle = 0; triangle < vertices.length; triangle += 3) {
    const root = find(vertices[triangle]);
    let group = islands.get(root);
    if (!group) { group = []; islands.set(root, group); }
    group.push(vertices[triangle], vertices[triangle + 1], vertices[triangle + 2]);
  }
  return [...islands.values()];
}

function projectedArea(vertices: number[], world: Float32Array, iu: number, iv: number): number {
  let area = 0;
  for (let triangle = 0; triangle + 2 < vertices.length; triangle += 3) {
    const [a, b, c] = [vertices[triangle], vertices[triangle + 1], vertices[triangle + 2]];
    area += Math.abs(
      (world[b * 3 + iu] - world[a * 3 + iu]) * (world[c * 3 + iv] - world[a * 3 + iv]) -
      (world[c * 3 + iu] - world[a * 3 + iu]) * (world[b * 3 + iv] - world[a * 3 + iv]),
    ) * .5;
  }
  return area;
}

function islandChart(mesh: THREE.Mesh, vertices: number[], world: Float32Array, iu: number, iv: number): ChartRequest {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  const centre = new THREE.Vector3();
  for (const vertex of vertices) {
    const u = world[vertex * 3 + iu];
    const v = world[vertex * 3 + iv];
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
    centre.x += world[vertex * 3] / vertices.length;
    centre.y += world[vertex * 3 + 1] / vertices.length;
    centre.z += world[vertex * 3 + 2] / vertices.length;
  }
  return {
    mesh,
    extentU: maxU - minU,
    extentV: maxV - minV,
    area: projectedArea(vertices, world, iu, iv),
    centre,
    w: 1,
    h: 1,
    x: 0,
    y: 0,
    page: 0,
    vertices,
    local: (vertex, out) => out.set(world[vertex * 3 + iu] - minU, world[vertex * 3 + iv] - minV),
  };
}

/**
 * @important Bottom-left skyline, not shelves. The shelf packer left 48% of the atlas
 * empty and the density search answered that by coarsening the whole scene: the corridor
 * settled at 0.1856 m/texel with 52% of the atlas used, which gave the bench eight
 * texels for its entire seat and neighbouring charts whose means differed 14-fold.
 */
/**
 * @important Pages, not a bigger atlas and not a coarser scene. Splitting folded bins
 * raised the chart count; coarsening the density to fit one 512 atlas took the corridor
 * to 0.1856 m/texel and left a whole bench seat on eight texels, and growing a single
 * atlas to 2048 broke the probe bake's readback. The density is fixed and pages are
 * added until every chart has a home.
 */
function packPages(charts: ChartRequest[], side: number, alignment: number, maxPages: number): number {
  let remaining = charts;
  let page = 0;
  while (remaining.length > 0 && page < maxPages) {
    const fitted: ChartRequest[] = [];
    remaining = packOnePage(remaining, side, alignment, fitted);
    if (fitted.length === 0) return 0;
    for (const chart of fitted) chart.page = page;
    page++;
  }
  return remaining.length === 0 ? page : 0;
}

function packOnePage(charts: ChartRequest[], side: number, alignment: number, fitted: ChartRequest[]): ChartRequest[] {
  const order = charts.slice().sort((p, q) => q.h - p.h || q.w - p.w);
  const skyline: { x: number; y: number; width: number }[] = [{ x: 0, y: 0, width: side }];
  const rejected: ChartRequest[] = [];
  for (const chart of order) {
    if (chart.w > side || chart.h > side) return [];
    const spot = lowestFit(skyline, chart.w, chart.h, side, alignment);
    if (!spot) { rejected.push(chart); continue; }
    chart.x = spot.x;
    chart.y = spot.y;
    raiseSkyline(skyline, spot.x, spot.y + chart.h, chart.w);
    fitted.push(chart);
  }
  return rejected;
}

function lowestFit(skyline: { x: number; y: number; width: number }[], width: number, height: number, side: number, alignment: number):
  { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  for (let index = 0; index < skyline.length; index++) {
    const x = Math.ceil(skyline[index].x / alignment) * alignment;
    if (x + width > side) continue;
    let y = 0;
    let covered = 0;
    for (let scan = index; scan < skyline.length && covered < width + (x - skyline[index].x); scan++) {
      y = Math.max(y, skyline[scan].y);
      covered += skyline[scan].width;
    }
    if (covered < width) continue;
    y = Math.ceil(y / alignment) * alignment;
    if (y + height > side) continue;
    if (!best || y < best.y || (y === best.y && x < best.x)) best = { x, y };
  }
  return best;
}

function raiseSkyline(skyline: { x: number; y: number; width: number }[], x: number, top: number, width: number): void {
  const inserted = { x, y: top, width };
  const next: typeof skyline = [];
  for (const segment of skyline) {
    const endSegment = segment.x + segment.width;
    const endInserted = x + width;
    if (endSegment <= x || segment.x >= endInserted) { next.push(segment); continue; }
    if (segment.x < x) next.push({ x: segment.x, y: segment.y, width: x - segment.x });
    if (endSegment > endInserted) next.push({ x: endInserted, y: segment.y, width: endSegment - endInserted });
  }
  next.push(inserted);
  next.sort((a, b) => a.x - b.x);
  skyline.length = 0;
  skyline.push(...next);
}
