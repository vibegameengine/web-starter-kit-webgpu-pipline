import * as THREE from 'three/webgpu';
import { attribute, color } from 'three/tsl';

export const BLOCKOUT_MOSS = new THREE.Color(0.16, 0.26, 0.11);
export const BLOCKOUT_MUD = new THREE.Color(0.22, 0.17, 0.12);
export const BLOCKOUT_ROCK = new THREE.Color(0.35, 0.35, 0.34);
export const BLOCKOUT_BARK = new THREE.Color(0.19, 0.14, 0.10);
export const BLOCKOUT_NEEDLE = new THREE.Color(0.11, 0.20, 0.10);
export const BLOCKOUT_WALL = new THREE.Color(0.20, 0.18, 0.15);
export const BLOCKOUT_WATER = new THREE.Color(0.10, 0.16, 0.18);

export function createCoverMaterial(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = 'groveBlockoutCover';
  material.roughness = 0.95;
  material.metalness = 0;
  material.color = BLOCKOUT_MOSS.clone();
  material.userData.lightmapAlbedo = true;
  const cover = attribute('cover', 'vec3');
  material.colorNode = color(BLOCKOUT_MOSS)
    .mul(cover.x)
    .add(color(BLOCKOUT_MUD).mul(cover.y))
    .add(color(BLOCKOUT_ROCK).mul(cover.z));
  return material;
}

export function createFlatMaterial(name: string, tint: THREE.Color, roughness = 0.9): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = name;
  material.color = tint.clone();
  material.roughness = roughness;
  material.metalness = 0;
  material.userData.lightmapAlbedo = true;
  return material;
}
