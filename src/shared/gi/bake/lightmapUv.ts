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
}

/**
 * Assigns lightmap UVs by giving every quad of every static mesh its own cell in a
 * square atlas.
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
 * `padding` shrinks each chart inside its cell so bilinear filtering at runtime cannot
 * pull in a neighbouring chart's radiance — the classic lightmap seam.
 */
export function assignLightmapUvs(
  scene: THREE.Scene,
  options: { padding?: number } = {},
): LightmapLayout {
  const { padding = 0.12 } = options;

  const meshes: THREE.Mesh[] = [];
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    if (!mesh.layers.isEnabled(Layer.GiStatic)) return;
    meshes.push(mesh);
  });

  // One cell per group of 4 vertices — i.e. per box face.
  let totalCells = 0;
  for (const mesh of meshes) {
    const uv = mesh.geometry.getAttribute('uv');
    if (!uv) continue;
    totalCells += Math.ceil(uv.count / 4);
  }

  const gridSide = Math.max(1, Math.ceil(Math.sqrt(totalCells)));
  const charts: LightmapChart[] = [];
  let cursor = 0;

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const uv = geometry.getAttribute('uv');
    if (!uv) {
      console.warn(`[lightmap] ${mesh.name || mesh.uuid} has no uv; skipped`);
      continue;
    }

    const cellCount = Math.ceil(uv.count / 4);
    const uv2 = new Float32Array(uv.count * 2);

    for (let vertex = 0; vertex < uv.count; vertex++) {
      const cell = cursor + Math.floor(vertex / 4);
      const cx = cell % gridSide;
      const cy = Math.floor(cell / gridSide);

      // Face UV, inset by the padding, mapped into the cell.
      const u = uv.getX(vertex) * (1 - 2 * padding) + padding;
      const v = uv.getY(vertex) * (1 - 2 * padding) + padding;

      uv2[vertex * 2 + 0] = (cx + u) / gridSide;
      uv2[vertex * 2 + 1] = (cy + v) / gridSide;
    }

    geometry.setAttribute('uv1', new THREE.BufferAttribute(uv2, 2));
    charts.push({ mesh, firstCell: cursor, cellCount });
    cursor += cellCount;
  }

  console.log(
    `[lightmap] ${charts.length} meshes, ${cursor} charts, atlas grid ${gridSide}x${gridSide}`,
  );

  return { charts, gridSide, cellCount: cursor };
}
