import * as THREE from 'three/webgpu';
import { GroveField } from './heightField.ts';
import { buildAdaptiveMesh } from './adaptiveMesh.ts';
import { BLOCKOUT_WALL, createCoverMaterial, createFlatMaterial } from './blockoutMaterial.ts';
import type { ForestMaps } from './dressedMaterials.ts';
import { createDressedBoulderMaterial, createDressedGroundMaterial } from './dressedMaterials.ts';

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

function buildSkirt(field: GroveField, segments = 96): THREE.BufferGeometry {
  const half = field.half;
  const positions: number[] = [];
  const rim = (t: number, side: number): THREE.Vector3 => {
    const s = -half + t * 2 * half;
    const point = side === 0 ? new THREE.Vector3(s, 0, half)
      : side === 1 ? new THREE.Vector3(half, 0, half - t * 2 * half)
      : side === 2 ? new THREE.Vector3(half - t * 2 * half, 0, -half)
      : new THREE.Vector3(-half, 0, -half + t * 2 * half);
    point.y = field.height(point.x, point.z);
    return point;
  };
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < segments; i++) {
      const a = rim(i / segments, side);
      const b = rim((i + 1) / segments, side);
      const aLow = new THREE.Vector3(a.x, field.bottom, a.z);
      const bLow = new THREE.Vector3(b.x, field.bottom, b.z);
      positions.push(a.x, a.y, a.z, aLow.x, aLow.y, aLow.z, b.x, b.y, b.z);
      positions.push(b.x, b.y, b.z, aLow.x, aLow.y, aLow.z, bLow.x, bLow.y, bLow.z);
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
  const geometry = new THREE.PlaneGeometry(2 * field.half, 2 * field.half, 1, 1);
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
    ? createDressedBoulderMaterial(options.maps, 'bare')
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
