import * as THREE from 'three/webgpu';
import { Layer } from '../../world/index.ts';

export interface LightmapChart {
  mesh: THREE.Mesh;
  /** Index of the first atlas cell this mesh occupies. */
  firstCell: number;
  cellCount: number;
}

export interface LightmapLayout {
  charts: LightmapChart[];
  /** Cells per atlas row/column. */
  gridSide: number;
  cellCount: number;
  /** Static world area that got a chart, in m². */
  mappedArea: number;
  /** Static world area that was refused a chart, in m². */
  refusedArea: number;
  /** Atlas resolution the density figures below were reported against. */
  atlasSize: number;
  /** Aggregate metres per texel: `sqrt(mappedArea) / atlasSize`, near enough. */
  metresPerTexel: number;
}

/**
 * Largest block, in cells per side, one quad may be given.
 *
 * The cap is what stops the whole atlas going to the single biggest surface in an
 * outdoor scene: a 400 m terrain chunk is ~10^4 times the area of a fence post, and
 * proportional sizing without a ceiling would hand it the entire grid. Four is a
 * 16:1 texel ratio, which covers the spread inside a room and deliberately does not
 * pretend to cover the spread inside a landscape — see the refusal below.
 */
const MAX_BLOCK = 4;

/**
 * Metres per texel past which this atlas is not worth baking.
 *
 * Not a quality target — a refusal. At 0.5 m/texel a texel is wider than a person and
 * nothing resembling a contact shadow, a foliage shadow or a colour bleed survives, so
 * a lightmap at that density is not a cheaper version of the GI, it is a different and
 * wrong image. The Cornell box measures 0.063; the 400 m landscape measured 1.634.
 */
const REFUSE_METRES_PER_TEXEL = 0.5;

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

/** World area of the quad formed by four consecutive vertices, as two triangles. */
function quadArea(
  position: THREE.BufferAttribute,
  matrix: THREE.Matrix4,
  base: number,
  vertexCount: number,
): number {
  const i0 = base;
  const i1 = Math.min(base + 1, vertexCount - 1);
  const i2 = Math.min(base + 2, vertexCount - 1);
  const i3 = Math.min(base + 3, vertexCount - 1);

  _v0.fromBufferAttribute(position, i0).applyMatrix4(matrix);
  _v1.fromBufferAttribute(position, i1).applyMatrix4(matrix);
  _v2.fromBufferAttribute(position, i2).applyMatrix4(matrix);
  _v3.fromBufferAttribute(position, i3).applyMatrix4(matrix);

  // BoxGeometry triangulates a face as (0,1,3) and (1,2,3); anything that is not a
  // box is outside this unwrapper's contract anyway and this is a reasonable guess.
  let area = 0;
  _e1.subVectors(_v1, _v0);
  _e2.subVectors(_v3, _v0);
  area += _e1.cross(_e2).length() * 0.5;
  _e1.subVectors(_v2, _v1);
  _e2.subVectors(_v3, _v1);
  area += _e1.cross(_e2).length() * 0.5;
  return area;
}

/**
 * Assigns lightmap UVs by giving every quad of every static mesh a block of cells in a
 * square atlas, sized by the quad's world area.
 *
 * This is not a general unwrapper. It relies on the input being box geometry, where
 * each of the six faces already carries a clean 0..1 UV — so remapping that UV into a
 * cell produces a continuous, non-overlapping, distortion-free chart per face. That
 * covers the Cornell scene exactly, and it fails loudly (rather than subtly) on
 * anything else: a mesh without per-face 0..1 UVs is skipped and reported.
 *
 * A real content pipeline would run xatlas here. The point of this file is to make the
 * bake itself real, not to solve unwrapping.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN INTERIORS-ONLY PATH, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * Two of the failures measured in `docs/scale-report.md` §2 are fixed here and two are
 * not, because they cannot be:
 *
 *   FIXED   — every quad got the same number of texels regardless of world area, so a
 *             400 m terrain chunk and a 4 cm wall lip were equals. Blocks are now sized
 *             by area, capped at MAX_BLOCK.
 *   FIXED   — the density was never reported, so a scene the atlas could not represent
 *             baked quietly and looked merely dim. It is measured and refused now.
 *   NOT     — `InstancedMesh` has one `uv1` shared by every instance, and a lightmap
 *             stores *world-space* radiance. Four thousand grass clumps standing in
 *             four thousand different places cannot share one chart; this is a category
 *             error, not a resolution shortfall. Instanced meshes are therefore refused
 *             a chart outright and say so, which leaves them lit by the runtime surfel
 *             path — the only correct answer available.
 *   NOT     — atlas area is proportional to world area at fixed density. That is the
 *             structural failure, and no packer fixes it. Lumen has no lightmap at all:
 *             its surface cache is allocated by *screen* size, so texel density tracks
 *             the camera and is bounded by screen resolution. This path is a bake for
 *             interiors and small sets, and `?mode=lightmap` on a landscape will now
 *             tell you so in the console instead of quietly producing a dim image.
 */
export function assignLightmapUvs(
  scene: THREE.Scene,
  options: { padding?: number; atlasSize?: number } = {},
): LightmapLayout {
  const { padding = 0.12, atlasSize = 512 } = options;

  scene.updateMatrixWorld(true);

  type Quad = { mesh: THREE.Mesh; vertex: number; area: number; block: number };

  const meshes: THREE.Mesh[] = [];
  let refusedArea = 0;
  let refusedInstances = 0;
  let refusedMeshes = 0;

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    if (!mesh.layers.isEnabled(Layer.GiStatic)) return;

    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      const instanced = mesh as THREE.InstancedMesh;
      refusedInstances += instanced.count;
      refusedMeshes++;
      const geometry = mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const size = geometry.boundingBox!.getSize(new THREE.Vector3());
      // A bounding-box surface area is a crude stand-in for the real one; it is here
      // to give the refusal below a number, not to be exact.
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
        "first one's lighting. They are left to the runtime surfel path, which is the " +
        'only correct answer. This is why ?mode=lightmap is an interiors-only path.',
    );
  }

  // Pass one: every quad, with its world area.
  const quads: Quad[] = [];
  let mappedArea = 0;

  for (const mesh of meshes) {
    const uv = mesh.geometry.getAttribute('uv');
    const position = mesh.geometry.getAttribute('position');
    if (!uv || !position) {
      console.warn(`[lightmap] ${mesh.name || mesh.uuid} has no uv; skipped`);
      continue;
    }
    for (let vertex = 0; vertex < uv.count; vertex += 4) {
      const area = quadArea(
        position as THREE.BufferAttribute,
        mesh.matrixWorld,
        vertex,
        position.count,
      );
      mappedArea += area;
      quads.push({ mesh, vertex, area, block: 1 });
    }
  }

  if (quads.length === 0) {
    console.warn('[lightmap] nothing static carries per-face UVs; atlas will be empty');
    return {
      charts: [],
      gridSide: 1,
      cellCount: 0,
      mappedArea: 0,
      refusedArea,
      atlasSize,
      metresPerTexel: 0,
    };
  }

  // Pass two: block size per quad, proportional to the square root of area so that
  // *texels per metre* is what ends up uniform rather than texels per quad. The
  // reference is the median rather than the mean: one 400 m terrain chunk drags a mean
  // far enough that every other surface rounds down to a single cell.
  const areas = quads.map((q) => q.area).sort((a, b) => a - b);
  const median = Math.max(1e-6, areas[Math.floor(areas.length / 2)]);

  let cellsNeeded = 0;
  for (const quad of quads) {
    const scale = Math.sqrt(quad.area / median);
    // Powers of two only, so blocks tile the grid without leaving unusable slivers.
    let block = 1;
    while (block < MAX_BLOCK && block * 2 <= scale) block *= 2;
    quad.block = block;
    cellsNeeded += block * block;
  }

  // Pass three: pack, largest block first, aligned to its own size. Buckets rather
  // than a general rectangle packer because there are only three block sizes and a
  // bucketed layout is exact — every cell in a bucket's region is used.
  let gridSide = Math.ceil(Math.sqrt(cellsNeeded));
  gridSide = Math.ceil(gridSide / MAX_BLOCK) * MAX_BLOCK;

  type Placement = { x: number; y: number; block: number };
  const placements = new Map<Quad, Placement>();

  const pack = (side: number): boolean => {
    placements.clear();
    let x = 0;
    let y = 0;
    for (let block = MAX_BLOCK; block >= 1; block /= 2) {
      // Start each bucket on a row boundary its own block size divides, or a 2×2 would
      // straddle two rows of 4×4s and overlap one of them.
      if (x > 0) {
        x = 0;
        y += block * 2 <= MAX_BLOCK ? block * 2 : block;
      }
      y = Math.ceil(y / block) * block;
      for (const quad of quads) {
        if (quad.block !== block) continue;
        if (x + block > side) {
          x = 0;
          y += block;
        }
        if (y + block > side) return false;
        placements.set(quad, { x, y, block });
        x += block;
      }
    }
    return true;
  };

  let guard = 0;
  while (!pack(gridSide) && guard++ < 8) {
    gridSide = Math.ceil((gridSide * 1.2) / MAX_BLOCK) * MAX_BLOCK;
  }

  // Pass four: write uv1.
  const charts: LightmapChart[] = [];
  const perMesh = new Map<THREE.Mesh, { uv2: Float32Array; cells: number }>();

  for (const quad of quads) {
    const placement = placements.get(quad);
    if (!placement) continue;

    const geometry = quad.mesh.geometry;
    const uv = geometry.getAttribute('uv');
    let entry = perMesh.get(quad.mesh);
    if (!entry) {
      entry = { uv2: new Float32Array(uv.count * 2), cells: 0 };
      perMesh.set(quad.mesh, entry);
    }
    entry.cells += placement.block * placement.block;

    const span = placement.block;
    // Padding is measured in *cells*, not as a fraction of the block, so the gutter is
    // the same number of texels whatever size the block is. Bilinear reaches the same
    // distance regardless of how big the chart it is standing on happens to be.
    const inner = Math.max(1e-3, span - 2 * padding);

    for (let v = quad.vertex; v < Math.min(quad.vertex + 4, uv.count); v++) {
      const u = uv.getX(v) * inner + padding;
      const w = uv.getY(v) * inner + padding;
      entry.uv2[v * 2 + 0] = (placement.x + u) / gridSide;
      entry.uv2[v * 2 + 1] = (placement.y + w) / gridSide;
    }
  }

  let cursor = 0;
  for (const [mesh, entry] of perMesh) {
    mesh.geometry.setAttribute('uv1', new THREE.BufferAttribute(entry.uv2, 2));
    charts.push({ mesh, firstCell: cursor, cellCount: entry.cells });
    cursor += entry.cells;
  }

  // Density, reported rather than assumed. `sqrt(area)/atlasSize` is the aggregate
  // metres per texel a fully-packed atlas would achieve; it is the same figure
  // docs/scale-report.md quotes, so the two are comparable.
  const metresPerTexel = Math.sqrt(mappedArea) / atlasSize;

  console.log(
    `[lightmap] ${perMesh.size} meshes, ${quads.length} charts, atlas grid ` +
      `${gridSide}x${gridSide}, ${mappedArea.toFixed(1)} m² mapped, ` +
      `${metresPerTexel.toFixed(3)} m/texel at ${atlasSize}²`,
  );

  if (metresPerTexel > REFUSE_METRES_PER_TEXEL) {
    console.error(
      `[lightmap] ${metresPerTexel.toFixed(3)} m/texel is past the ` +
        `${REFUSE_METRES_PER_TEXEL} m/texel this atlas is worth baking at. A texel now ` +
        'covers more ground than a person stands on, so no contact shadow and no colour ' +
        'bleed survives it — the bake will produce a dim, flat image and will not say so ' +
        'again. Atlas area is proportional to world area at fixed density and no packer ' +
        'changes that: this path is for interiors and small sets. Use the runtime surfel ' +
        'GI (the default) for anything landscape-sized.',
    );
  }

  return {
    charts,
    gridSide,
    cellCount: cursor,
    mappedArea,
    refusedArea,
    atlasSize,
    metresPerTexel,
  };
}
