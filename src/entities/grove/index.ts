import * as THREE from 'three/webgpu';
import { GroveField } from './heightField.ts';
import { buildAdaptiveMesh } from './adaptiveMesh.ts';
import { BLOCKOUT_WALL, createCoverMaterial, createFlatMaterial } from './blockoutMaterial.ts';
import type { ForestMaps } from './dressedMaterials.ts';
import { createDressedGroundMaterial, createSlabFaceMaterial } from './dressedMaterials.ts';

export { GroveField } from './heightField.ts';
export { buildAdaptiveMesh, type AdaptiveMeshData } from './adaptiveMesh.ts';
export * from './blockoutMaterial.ts';
export * from './dressedMaterials.ts';

const COARSEST_QUAD_METERS = 1.5;
const FINEST_QUAD_METERS = 0.1875;
const DETAIL_FACTOR = 2;
const GROUND_UV_REPEATS_PER_METRE = 0.5;

export interface GroveOptions {
  field: GroveField;
  maps?: ForestMaps;
}

export interface Grove {
  group: THREE.Group;
  ground: THREE.Mesh;
  skirt: THREE.Mesh;
  triangleCount: number;
  leafCount: number;
}

const SKIRT_ROWS = 12;
const SKIRT_BULGE = 0.34;
const SKIRT_TUCK = 0.55;

function rimPoint(field: GroveField, side: number, t: number): THREE.Vector3 {
  const half = field.half;
  const s = -half + t * 2 * half;
  if (side === 0) return new THREE.Vector3(s, 0, half);
  if (side === 1) return new THREE.Vector3(half, 0, half - t * 2 * half);
  if (side === 2) return new THREE.Vector3(half - t * 2 * half, 0, -half);
  return new THREE.Vector3(-half, 0, -half + t * 2 * half);
}

function outwardOf(side: number): THREE.Vector3 {
  if (side === 0) return new THREE.Vector3(0, 0, 1);
  if (side === 1) return new THREE.Vector3(1, 0, 0);
  if (side === 2) return new THREE.Vector3(0, 0, -1);
  return new THREE.Vector3(-1, 0, 0);
}

function skirtVertex(field: GroveField, side: number, t: number, v: number): THREE.Vector3 {
  const base = rimPoint(field, side, t);
  const rim = field.height(base.x, base.z);
  const y = rim + (field.bottom - rim) * (v * v * 0.25 + v * 0.75);
  const n = field.noise;
  const cobble = n.ridged3(base.x * 0.9 + 5, y * 1.1, base.z * 0.9, 3);
  const lumps = n.fbm3(base.x * 1.7, y * 1.9 + 7, base.z * 1.7, 3);
  const rounded = Math.max(0, Math.min(1, (cobble - 0.45) * 2.4));
  const shoulder = Math.min(1, Math.max(0, (rim - y) / 0.5));
  const tuck = SKIRT_TUCK * v * v * v;
  const bulge = shoulder * (0.05 * lumps + SKIRT_BULGE * rounded * (0.6 + 0.4 * lumps));
  const outward = outwardOf(side).multiplyScalar(bulge - tuck);
  return new THREE.Vector3(base.x + outward.x, y, base.z + outward.z);
}

function buildSkirt(field: GroveField, columns = 128): THREE.BufferGeometry {
  const positions: number[] = [];
  for (let side = 0; side < 4; side++) {
    for (let c = 0; c < columns; c++) {
      for (let r = 0; r < SKIRT_ROWS; r++) {
        const t0 = c / columns;
        const t1 = (c + 1) / columns;
        const v0 = r / SKIRT_ROWS;
        const v1 = (r + 1) / SKIRT_ROWS;
        const a = skirtVertex(field, side, t0, v0);
        const b = skirtVertex(field, side, t1, v0);
        const d = skirtVertex(field, side, t0, v1);
        const e = skirtVertex(field, side, t1, v1);
        positions.push(a.x, a.y, a.z, d.x, d.y, d.z, b.x, b.y, b.z);
        positions.push(b.x, b.y, b.z, d.x, d.y, d.z, e.x, e.y, e.z);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function buildUnderside(field: GroveField): THREE.BufferGeometry {
  const width = 2 * (field.half - SKIRT_TUCK);
  const geometry = new THREE.PlaneGeometry(width, width, 1, 1);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, field.bottom, 0);
  return geometry;
}

export function createGrove(options: GroveOptions): Grove {
  const { field } = options;
  const group = new THREE.Group();
  group.name = 'grove';

  const mesh = buildAdaptiveMesh({
    half: field.half,
    maxQuadMeters: COARSEST_QUAD_METERS,
    minQuadMeters: FINEST_QUAD_METERS,
    detailFactor: DETAIL_FACTOR,
    detailDistance: (x, z) => field.detailDistance(x, z),
    sampleHeight: (x, z) => field.height(x, z),
    sampleCover: (x, z) => field.cover(x, z),
    uvRepeatsPerMetre: GROUND_UV_REPEATS_PER_METRE,
  });

  const groundMaterial = options.maps ? createDressedGroundMaterial(options.maps) : createCoverMaterial();
  const ground = new THREE.Mesh(mesh.geometry, groundMaterial);
  ground.name = 'groveGround';
  ground.castShadow = true;
  ground.receiveShadow = true;
  group.add(ground);

  const wallMaterial = options.maps
    ? createSlabFaceMaterial(options.maps, field.height(0, 0), field.bottom)
    : createFlatMaterial('groveSkirt', BLOCKOUT_WALL, 1);
  wallMaterial.side = THREE.DoubleSide;
  const skirt = new THREE.Mesh(buildSkirt(field), wallMaterial);
  skirt.name = 'groveSkirt';
  skirt.castShadow = true;
  skirt.receiveShadow = true;
  group.add(skirt);

  const underside = new THREE.Mesh(buildUnderside(field), wallMaterial);
  underside.name = 'groveUnderside';
  underside.receiveShadow = true;
  group.add(underside);

  console.info(`[grove] ground ${mesh.triangleCount} tris, ${mesh.leafCount} leaves`);
  return { group, ground, skirt, triangleCount: mesh.triangleCount, leafCount: mesh.leafCount };
}
