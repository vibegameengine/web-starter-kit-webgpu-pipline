import * as THREE from 'three/webgpu';
import { Layer } from '../../world/index.ts';
import type { LightmapRegion } from './chartPadding.ts';

export interface LightmapChart {
  mesh: THREE.Mesh;
  /** Index of the first atlas texel this mesh occupies (charts are counted in texels). */
  firstCell: number;
  cellCount: number;
}

export interface LightmapLayout {
  charts: LightmapChart[];
  regions: LightmapRegion[];
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

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _n = new THREE.Vector3();

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
  /** Assigned by the layout pass. */
  w: number;
  h: number;
  x: number;
  y: number;
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
  options: { padding?: number; atlasSize?: number; filterMip?: number } = {},
): LightmapLayout {
  const { atlasSize = 512 } = options;
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

  for (const mesh of meshes) {
    const mode = chartMode(mesh);
    const built = mode === 'quads' ? quadCharts(mesh) : projectedCharts(mesh);
    for (const chart of built.charts) requests.push(chart);
    mappedArea += built.area;
  }

  if (requests.length === 0) {
    console.warn('[lightmap] nothing static could be charted; atlas will be empty');
    return {
      charts: [],
      regions: [],
      safeMip,
      gridSide: atlasSize,
      cellCount: 0,
      mappedArea: 0,
      refusedArea,
      atlasSize,
      metresPerTexel: 0,
    };
  }

  // --- density search ---------------------------------------------------------
  let metresPerTexel = Math.sqrt(mappedArea / (TARGET_FILL * atlasSize * atlasSize));
  let packed = false;
  for (let attempt = 0; attempt < 40 && !packed; attempt++) {
    for (const chart of requests) {
      chart.w = Math.max(2 * alignment, Math.ceil((chart.extentU / metresPerTexel + 2 * inset) / alignment) * alignment);
      chart.h = Math.max(2 * alignment, Math.ceil((chart.extentV / metresPerTexel + 2 * inset) / alignment) * alignment);
    }
    packed = shelfPack(requests, atlasSize);
    if (!packed) metresPerTexel *= 1.07;
  }
  if (!packed) {
    throw new Error(
      `[lightmap] could not pack ${requests.length} charts into a ${atlasSize}² atlas`,
    );
  }

  // --- write uv1 ----------------------------------------------------------------
  const perMesh = new Map<THREE.Mesh, { uv1: Float32Array; bounds: Float32Array; texels: number }>();
  const local = new THREE.Vector2();

  for (const chart of requests) {
    const geometry = chart.mesh.geometry;
    const count = geometry.getAttribute('position').count;
    let entry = perMesh.get(chart.mesh);
    if (!entry) {
      entry = { uv1: new Float32Array(count * 2), bounds: new Float32Array(count * 4), texels: 0 };
      perMesh.set(chart.mesh, entry);
    }
    entry.texels += chart.w * chart.h;

    const spanU = Math.max(chart.w - 2 * inset, 1e-3);
    const spanV = Math.max(chart.h - 2 * inset, 1e-3);
    const scaleU = chart.extentU > 1e-6 ? spanU / chart.extentU : 0;
    const scaleV = chart.extentV > 1e-6 ? spanV / chart.extentV : 0;
    const filterBounds = [(chart.x + alignment * .5) / atlasSize, (chart.y + alignment * .5) / atlasSize,
      (chart.x + chart.w - alignment * .5) / atlasSize, (chart.y + chart.h - alignment * .5) / atlasSize];

    for (const vertex of chart.vertices) {
      chart.local(vertex, local);
      const u = chart.x + inset + local.x * scaleU;
      const v = chart.y + inset + local.y * scaleV;
      entry.uv1[vertex * 2 + 0] = u / atlasSize;
      entry.uv1[vertex * 2 + 1] = v / atlasSize;
      // Constant within each chart. All line-filter taps stay inside the
      // coarsest mip's texel centres, including when only fallback is resident.
      entry.bounds.set(filterBounds, vertex * 4);
    }
  }

  const charts: LightmapChart[] = [];
  let cursor = 0;
  for (const [mesh, entry] of perMesh) {
    mesh.geometry.setAttribute('uv1', new THREE.BufferAttribute(entry.uv1, 2));
    mesh.geometry.setAttribute('lightmapBounds', new THREE.BufferAttribute(entry.bounds, 4));
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
    regions: requests.map(c => ({ x: c.x, y: c.y, width: c.w, height: c.h })),
    safeMip,
    gridSide: atlasSize,
    cellCount: cursor,
    mappedArea,
    refusedArea,
    atlasSize,
    metresPerTexel,
  };
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
function quadCharts(mesh: THREE.Mesh): { charts: ChartRequest[]; area: number } {
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
      w: 1,
      h: 1,
      x: 0,
      y: 0,
      vertices: [base, base + 1, base + 2, base + 3],
      local: (vertex, out) => out.set(uv.getX(vertex) * side, uv.getY(vertex) * side),
    });
  }
  return { charts, area };
}

/**
 * Bins triangles by dominant world-normal axis and projects each bin onto the plane
 * perpendicular to it. Converts the geometry to non-indexed first, because a vertex
 * shared between two bins would need two different `uv1` values.
 */
function projectedCharts(mesh: THREE.Mesh): { charts: ChartRequest[]; area: number } {
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

  // axis bins: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z
  const bins: number[][] = [[], [], [], [], [], []];
  let area = 0;
  for (let tri = 0; tri + 2 < position.count; tri += 3) {
    _a.fromArray(world, tri * 3);
    _b.fromArray(world, (tri + 1) * 3);
    _c.fromArray(world, (tri + 2) * 3);
    _n.crossVectors(_e1.subVectors(_b, _a), _e2.subVectors(_c, _a));
    const triArea = 0.5 * _n.length();
    if (triArea < 1e-10) continue;
    area += triArea;
    const ax = Math.abs(_n.x);
    const ay = Math.abs(_n.y);
    const az = Math.abs(_n.z);
    let bin: number;
    if (ay >= ax && ay >= az) bin = _n.y >= 0 ? 2 : 3;
    else if (ax >= az) bin = _n.x >= 0 ? 0 : 1;
    else bin = _n.z >= 0 ? 4 : 5;
    bins[bin].push(tri, tri + 1, tri + 2);
  }

  // Plane axes per bin: (u, v) component indices of the world position.
  const planeAxes: Array<[number, number]> = [
    [2, 1], // ±X: z, y
    [2, 1],
    [0, 2], // ±Y: x, z
    [0, 2],
    [0, 1], // ±Z: x, y
    [0, 1],
  ];

  const charts: ChartRequest[] = [];
  for (let bin = 0; bin < 6; bin++) {
    const vertices = bins[bin];
    if (vertices.length === 0) continue;
    const [iu, iv] = planeAxes[bin];
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (const vertex of vertices) {
      const u = world[vertex * 3 + iu];
      const v = world[vertex * 3 + iv];
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    charts.push({
      mesh,
      extentU: maxU - minU,
      extentV: maxV - minV,
      w: 1,
      h: 1,
      x: 0,
      y: 0,
      vertices,
      local: (vertex, out) =>
        out.set(world[vertex * 3 + iu] - minU, world[vertex * 3 + iv] - minV),
    });
  }
  return { charts, area };
}

/** Shelf packer: rows of charts sorted by height, tallest first. Exact enough here. */
function shelfPack(charts: ChartRequest[], side: number): boolean {
  const order = charts.slice().sort((p, q) => q.h - p.h || q.w - p.w);
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const chart of order) {
    if (chart.w > side || chart.h > side) return false;
    if (x + chart.w > side) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    if (y + chart.h > side) return false;
    chart.x = x;
    chart.y = y;
    x += chart.w;
    rowHeight = Math.max(rowHeight, chart.h);
  }
  return true;
}
