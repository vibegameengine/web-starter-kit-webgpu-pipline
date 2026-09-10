import * as THREE from 'three/webgpu';
import {
  Fn,
  abs,
  attribute,
  float,
  mix,
  mx_fractal_noise_float,
  normalMap,
  normalWorld,
  normalize,
  positionWorld,
  pow,
  smoothstep,
  texture,
  transformNormalToView,
  vec2,
  vec3,
} from 'three/tsl';

export interface ForestMaps {
  mossColor: THREE.Texture;
  mossNormal: THREE.Texture;
  mossRoughness: THREE.Texture;
  floorColor: THREE.Texture;
  floorNormal: THREE.Texture;
  floorRoughness: THREE.Texture;
  graniteColor: THREE.Texture;
  graniteNormal: THREE.Texture;
  graniteRoughness: THREE.Texture;
}

const MOSS_REPEATS_PER_METRE = 0.9;
const FLOOR_REPEATS_PER_METRE = 0.7;
const GRANITE_REPEATS_PER_METRE = 0.5;
const GRANITE_GROUND_GAIN = 0.45;
const MOSS_GROUND_GAIN = 0.9;

export const GROUND_AVERAGE_COLOR = new THREE.Color(0.17, 0.16, 0.09);
export const BOULDER_AVERAGE_COLOR = new THREE.Color(0.34, 0.34, 0.32);

function planar(repeatsPerMetre: number) {
  return vec2(positionWorld.x, positionWorld.z).mul(float(repeatsPerMetre));
}

export function createDressedGroundMaterial(maps: ForestMaps): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = 'groveGroundDressed';
  material.color = GROUND_AVERAGE_COLOR.clone();
  material.map = maps.mossColor;
  material.metalness = 0;
  material.roughness = 0.95;
  material.userData.lightmapAlbedo = true;

  const cover = attribute('cover', 'vec3');
  const patch = mx_fractal_noise_float(positionWorld.mul(0.7), 3).mul(0.5).add(0.5);
  const litter = smoothstep(0.45, 0.85, mx_fractal_noise_float(positionWorld.mul(0.35).add(11.0), 3).mul(0.5).add(0.5));
  const mossWeight = cover.x.mul(patch.mul(0.5).add(0.75)).mul(litter.oneMinus().mul(0.75).add(0.25));
  const litterWeight = cover.x.mul(litter).mul(0.45);
  const total = mossWeight.add(litterWeight).add(cover.y).add(cover.z).max(0.001);

  const mossUv = planar(MOSS_REPEATS_PER_METRE);
  const floorUv = planar(FLOOR_REPEATS_PER_METRE);
  const graniteUv = planar(GRANITE_REPEATS_PER_METRE);

  const albedo = texture(maps.mossColor, mossUv).rgb
    .mul(MOSS_GROUND_GAIN)
    .mul(mossWeight)
    .add(texture(maps.floorColor, floorUv).rgb.mul(cover.y.add(litterWeight)))
    .add(texture(maps.graniteColor, graniteUv).rgb.mul(GRANITE_GROUND_GAIN).mul(cover.z))
    .div(total);
  const wetness = smoothstep(0.35, 0.9, cover.z.mul(cover.y.add(0.4)));
  material.colorNode = albedo.mul(mix(float(1.0), float(0.55), wetness));

  const roughness = texture(maps.mossRoughness, mossUv).r
    .mul(mossWeight)
    .add(texture(maps.floorRoughness, floorUv).r.mul(cover.y.add(litterWeight)))
    .add(texture(maps.graniteRoughness, graniteUv).r.mul(cover.z))
    .div(total);
  material.roughnessNode = mix(roughness.mul(0.5).add(0.5), float(0.22), wetness);

  const normalTexture = texture(maps.mossNormal, mossUv).xyz
    .mul(mossWeight)
    .add(texture(maps.floorNormal, floorUv).xyz.mul(cover.y.add(litterWeight)))
    .add(texture(maps.graniteNormal, graniteUv).xyz.mul(cover.z))
    .div(total);
  material.normalNode = normalMap(normalTexture);
  return material;
}

function triplanarWeights() {
  return Fn(() => {
    const w = pow(abs(normalWorld), vec3(4.0));
    return w.div(w.x.add(w.y).add(w.z));
  })();
}

function triplanar(map: THREE.Texture, scale: number, weights: ReturnType<typeof triplanarWeights>) {
  const p = positionWorld.mul(float(scale));
  return texture(map, p.zy).rgb.mul(weights.x)
    .add(texture(map, p.xz).rgb.mul(weights.y))
    .add(texture(map, p.xy).rgb.mul(weights.z));
}

export type BoulderCover = 'bare' | 'mossy';

const MOSS_COVERAGE: Record<BoulderCover, number> = { bare: 0.15, mossy: 0.6 };

export function createDressedBoulderMaterial(maps: ForestMaps, cover: BoulderCover): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = `groveBoulder-${cover}`;
  material.color = BOULDER_AVERAGE_COLOR.clone();
  material.map = maps.graniteColor;
  material.metalness = 0;
  material.roughness = 0.85;
  material.userData.lightmapAlbedo = true;

  const weights = triplanarWeights();
  const granite = triplanar(maps.graniteColor, 0.6, weights);
  const moss = triplanar(maps.mossColor, 1.2, weights);
  const upward = smoothstep(0.1, 0.8, normalWorld.y);
  const patch = mx_fractal_noise_float(positionWorld.mul(1.8), 3).mul(0.5).add(0.5);
  const mossMask = smoothstep(0.4, 0.8, upward.mul(patch.add(MOSS_COVERAGE[cover])));

  material.colorNode = mix(granite, moss, mossMask);
  material.roughnessNode = mix(float(0.72), float(0.97), mossMask);
  const graniteNormal = triplanar(maps.graniteNormal, 0.6, weights).mul(2).sub(1);
  const mossNormal = triplanar(maps.mossNormal, 1.2, weights).mul(2).sub(1);
  material.normalNode = transformNormalToView(normalize(mix(graniteNormal, mossNormal, mossMask).add(normalWorld)));
  return material;
}

const SLAB_GRANITE_GAIN = 0.42;

export function createSlabFaceMaterial(maps: ForestMaps, rimHeight: number, bottom: number): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = 'groveSlabFace';
  material.color = new THREE.Color(0.22, 0.20, 0.17);
  material.map = maps.graniteColor;
  material.metalness = 0;
  material.roughness = 0.95;
  material.side = THREE.DoubleSide;
  material.userData.lightmapAlbedo = true;

  const weights = triplanarWeights();
  const granite = triplanar(maps.graniteColor, 0.55, weights).mul(SLAB_GRANITE_GAIN);
  const soil = triplanar(maps.floorColor, 0.6, weights).mul(0.6);
  const moss = triplanar(maps.mossColor, 1.0, weights);
  const depth = smoothstep(rimHeight, bottom + 0.2, positionWorld.y);
  const patch = mx_fractal_noise_float(positionWorld.mul(0.8), 3).mul(0.5).add(0.5);
  const rock = smoothstep(0.35, 0.75, patch);
  const drape = smoothstep(rimHeight - 0.9, rimHeight, positionWorld.y).mul(smoothstep(0.35, 0.8, patch));

  material.colorNode = mix(mix(mix(soil, granite, rock), soil.mul(0.8), depth), moss, drape.mul(0.8));
  material.roughnessNode = mix(float(0.96), float(0.85), rock);
  const graniteNormal = triplanar(maps.graniteNormal, 0.55, weights).mul(2).sub(1);
  material.normalNode = transformNormalToView(normalize(graniteNormal.add(normalWorld)));
  return material;
}

export function createBarkMaterial(maps: { color: THREE.Texture; normal: THREE.Texture; roughness: THREE.Texture }): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = 'forestBark';
  material.map = maps.color;
  material.normalMap = maps.normal;
  material.roughnessMap = maps.roughness;
  material.metalness = 0;
  material.color = new THREE.Color(1, 1, 1);
  material.userData.lightmapAlbedo = true;
  return material;
}
