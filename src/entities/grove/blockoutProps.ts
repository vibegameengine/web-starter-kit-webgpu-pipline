import * as THREE from 'three/webgpu';
import { seededRandom } from '../../shared/lib/noise.ts';
import { createRock } from '../rocks/index.ts';
import { BLOCKOUT_BARK, BLOCKOUT_NEEDLE, BLOCKOUT_ROCK, BLOCKOUT_MOSS, createFlatMaterial } from './blockoutMaterial.ts';

export interface SpruceSpec {
  x: number;
  z: number;
  height: number;
  seed: number;
}

export interface BoulderSpec {
  x: number;
  z: number;
  radius: number;
  seed: number;
  mossy?: boolean;
}

export interface BlockoutMaterials {
  bark: THREE.MeshStandardNodeMaterial;
  needle: THREE.MeshStandardNodeMaterial;
  rock: THREE.MeshStandardNodeMaterial;
  moss: THREE.MeshStandardNodeMaterial;
}

export function createBlockoutMaterials(): BlockoutMaterials {
  return {
    bark: createFlatMaterial('blockoutBark', BLOCKOUT_BARK, 0.95),
    needle: createFlatMaterial('blockoutNeedle', BLOCKOUT_NEEDLE, 0.9),
    rock: createFlatMaterial('blockoutRock', BLOCKOUT_ROCK, 0.85),
    moss: createFlatMaterial('blockoutMoss', BLOCKOUT_MOSS, 0.95),
  };
}

const CROWN_TIERS = 4;

export function createSpruce(spec: SpruceSpec, materials: BlockoutMaterials, groundY: number): THREE.Group {
  const random = seededRandom(spec.seed);
  const group = new THREE.Group();
  group.name = `spruce-${spec.seed}`;
  const trunkRadius = spec.height * 0.022;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(trunkRadius * 0.6, trunkRadius, spec.height, 10),
    materials.bark,
  );
  trunk.position.y = groundY + spec.height * 0.5;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  group.add(trunk);

  const crownBase = groundY + spec.height * 0.28;
  const crownTop = groundY + spec.height * 1.02;
  for (let tier = 0; tier < CROWN_TIERS; tier++) {
    const t = tier / (CROWN_TIERS - 1);
    const centre = crownBase + (crownTop - crownBase) * t;
    const radius = spec.height * (0.22 - 0.15 * t) * (0.85 + random() * 0.3);
    const tierHeight = spec.height * (0.34 - 0.14 * t);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(radius, tierHeight, 9), materials.needle);
    cone.position.set(spec.x * 0 + (random() - 0.5) * 0.08, centre, (random() - 0.5) * 0.08);
    cone.castShadow = true;
    cone.receiveShadow = true;
    group.add(cone);
  }
  group.position.set(spec.x, 0, spec.z);
  group.rotation.y = random() * Math.PI * 2;
  return group;
}

export function createBoulder(spec: BoulderSpec, materials: BlockoutMaterials, groundY: number): THREE.Mesh {
  const random = seededRandom(spec.seed);
  const mesh = createRock({ seed: spec.seed, radius: spec.radius }, spec.mossy ? materials.moss : materials.rock);
  mesh.name = `boulder-${spec.seed}`;
  mesh.position.set(spec.x, groundY + spec.radius * 0.34, spec.z);
  mesh.rotation.set((random() - 0.5) * 0.3, random() * Math.PI * 2, (random() - 0.5) * 0.3);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function createFallenLog(x: number, z: number, length: number, heading: number, materials: BlockoutMaterials, groundY: number): THREE.Mesh {
  const log = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, length, 9), materials.bark);
  log.name = 'fallenLog';
  log.rotation.set(0, heading, Math.PI / 2);
  log.position.set(x, groundY + 0.16, z);
  log.castShadow = true;
  log.receiveShadow = true;
  return log;
}

export function createFernClump(x: number, z: number, radius: number, seed: number, materials: BlockoutMaterials, groundY: number): THREE.Group {
  const random = seededRandom(seed);
  const group = new THREE.Group();
  group.name = `fern-${seed}`;
  const blades = 5 + Math.floor(random() * 4);
  for (let i = 0; i < blades; i++) {
    const height = radius * (1.1 + random() * 0.7);
    const blade = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.45, height, 6), materials.needle);
    const angle = random() * Math.PI * 2;
    const offset = radius * 0.5 * random();
    blade.position.set(Math.cos(angle) * offset, groundY + height * 0.45, Math.sin(angle) * offset);
    blade.rotation.set((random() - 0.5) * 0.5, random() * Math.PI, (random() - 0.5) * 0.5);
    blade.castShadow = true;
    blade.receiveShadow = true;
    group.add(blade);
  }
  group.position.set(x, 0, z);
  return group;
}
