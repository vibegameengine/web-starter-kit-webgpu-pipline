import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { IslandField } from './heightField.ts';
import { createSandMaterial, type SandMaterialUniforms } from './sandMaterial.ts';
import { createCliffMaterial, type CliffTextures } from './cliffMaterial.ts';
import { WATER_ABSORB } from '../water/medium.ts';

export { IslandField } from './heightField.ts';
export { SAND_AVERAGE_COLOR } from './sandMaterial.ts';
export type { CliffTextures } from './cliffMaterial.ts';

export interface IslandOptions {
  field: IslandField;
  textures: CliffTextures;
  /** Grid vertices per side for the sand top. */
  topSegments?: number;
  wallSegments?: number;
}

export interface Island {
  group: THREE.Group;
  sand: THREE.Mesh;
  walls: THREE.Mesh[];
  bottom: THREE.Mesh;
  uniforms: SandMaterialUniforms;
  update(timeSec: number, sunColor: THREE.Color, sunDir: THREE.Vector3): void;
}

/**
 * The floating slab: a heightfield of sand on top, four displaced cut faces of soil
 * and rock, a flat underside.
 *
 * The walls share the top's edge vertices exactly (same `field.height` at the rim,
 * zero displacement on the top row), so the beach turns over the edge with no crack.
 */
export function createIsland(options: IslandOptions): Island {
  const { field, textures, topSegments = 192, wallSegments = 48 } = options;
  const half = field.half;

  const uniforms: SandMaterialUniforms = {
    time: uniform(0),
    sunColor: uniform(new THREE.Color(1, 0.95, 0.85)),
    waterLevel: uniform(field.waterLevel),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    absorb: uniform(WATER_ABSORB.clone()),
  };

  const group = new THREE.Group();
  group.name = 'island';

  // --- sand top -------------------------------------------------------------
  const top = new THREE.PlaneGeometry(2 * half, 2 * half, topSegments, topSegments);
  top.rotateX(-Math.PI / 2);
  const pos = top.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, field.height(x, z));
  }
  top.computeVertexNormals();
  const sandMaterial = createSandMaterial(uniforms);
  const sand = new THREE.Mesh(top, sandMaterial);
  sand.name = 'islandSand';
  sand.castShadow = true;
  sand.receiveShadow = true;
  group.add(sand);

  // --- walls ------------------------------------------------------------------
  const cliffMaterial = createCliffMaterial(textures);
  const walls: THREE.Mesh[] = [];
  const n = field.noise;
  const sides: Array<{ name: string; outward: THREE.Vector3; corner: THREE.Vector3; along: THREE.Vector3 }> = [
    { name: 'front', outward: new THREE.Vector3(0, 0, 1), corner: new THREE.Vector3(-half, 0, half), along: new THREE.Vector3(1, 0, 0) },
    { name: 'back', outward: new THREE.Vector3(0, 0, -1), corner: new THREE.Vector3(half, 0, -half), along: new THREE.Vector3(-1, 0, 0) },
    { name: 'left', outward: new THREE.Vector3(-1, 0, 0), corner: new THREE.Vector3(-half, 0, -half), along: new THREE.Vector3(0, 0, 1) },
    { name: 'right', outward: new THREE.Vector3(1, 0, 0), corner: new THREE.Vector3(half, 0, half), along: new THREE.Vector3(0, 0, -1) },
  ];

  const wallCols = topSegments;
  const wallRows = wallSegments;
  for (const side of sides) {
    const vertexCount = (wallCols + 1) * (wallRows + 1);
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const strata = new Float32Array(vertexCount);
    const indices: number[] = [];

    for (let r = 0; r <= wallRows; r++) {
      const v = r / wallRows; // 0 at the rim, 1 at the bottom
      for (let c = 0; c <= wallCols; c++) {
        const s = c / wallCols;
        const bx = side.corner.x + side.along.x * s * 2 * half;
        const bz = side.corner.z + side.along.z * s * 2 * half;
        const rim = field.height(bx, bz);
        // Ease from the rim down to the flat bottom, denser rows near the rim.
        const y = rim + (field.bottom - rim) * (v * v * 0.35 + v * 0.65);

        // Outward displacement: soil sags, rock juts. Zero at the rim row so the
        // wall meets the sand exactly; grows with depth then fades near the bottom.
        // Under water the wall stays a clean glass-side until below the sand floor.
        const sub = Math.min(rim, field.waterLevel - 0.15) - y;
        const reach = Math.max(0, Math.min(1, sub / 0.6)) * (1 - 0.6 * v * v);
        const rockField = n.ridged3(bx * 0.9 + 3, y * 1.4, bz * 0.9, 4);
        const lumps = n.fbm3(bx * 1.6, y * 2.2 + 11, bz * 1.6, 3);
        const rockMask = Math.max(0, Math.min(1, (rockField - 0.45) * 3.0));
        const bulge = 0.10 * lumps + 0.5 * rockMask * (0.5 + 0.5 * lumps) + 0.05 * n.noise3(bx * 6, y * 6, bz * 6);
        const out = reach * bulge;

        const i = r * (wallCols + 1) + c;
        positions[i * 3] = bx + side.outward.x * out;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = bz + side.outward.z * out;
        uvs[i * 2] = s * 2 * half * 0.5;
        uvs[i * 2 + 1] = (y - field.bottom) * 0.5;
        strata[i] = Math.min(1, rockMask * reach * 1.6 + Math.max(0, (lumps - 0.45)) * reach);

        if (r < wallRows && c < wallCols) {
          const a = i;
          const b = i + 1;
          const d = i + wallCols + 1;
          const e = d + 1;
          // Wind so the face normal points outward.
          indices.push(a, d, b, b, d, e);
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('strata', new THREE.BufferAttribute(strata, 1));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    // Winding depends on the side's frame; flip where the normal came out inward.
    const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
    const centreIndex = Math.floor(wallRows / 2) * (wallCols + 1) + Math.floor(wallCols / 2);
    const dot = normal.getX(centreIndex) * side.outward.x + normal.getZ(centreIndex) * side.outward.z;
    if (dot < 0) {
      const idx = geometry.getIndex()!;
      for (let t = 0; t < idx.count; t += 3) {
        const tmp = idx.getX(t + 1);
        idx.setX(t + 1, idx.getX(t + 2));
        idx.setX(t + 2, tmp);
      }
      geometry.computeVertexNormals();
    }

    const wall = new THREE.Mesh(geometry, cliffMaterial);
    wall.name = `islandWall_${side.name}`;
    wall.castShadow = true;
    wall.receiveShadow = true;
    walls.push(wall);
    group.add(wall);
  }

  // --- underside ---------------------------------------------------------------
  const bottomGeometry = new THREE.PlaneGeometry(2 * half + 0.6, 2 * half + 0.6);
  bottomGeometry.rotateX(Math.PI / 2);
  bottomGeometry.translate(0, field.bottom, 0);
  const bottomMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x3a3128, roughness: 1 });
  bottomMaterial.name = 'islandBottom';
  const bottom = new THREE.Mesh(bottomGeometry, bottomMaterial);
  bottom.name = 'islandBottom';
  bottom.userData.lightmap = false;
  bottom.castShadow = true;
  bottom.receiveShadow = true;
  group.add(bottom);

  return {
    group,
    sand,
    walls,
    bottom,
    uniforms,
    update(timeSec, sunColor, sunDir) {
      uniforms.time.value = timeSec;
      (uniforms.sunColor.value as THREE.Color).copy(sunColor);
      (uniforms.sunDir.value as THREE.Vector3).copy(sunDir);
    },
  };
}
