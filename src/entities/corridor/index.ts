import * as THREE from 'three/webgpu';

import { createConcreteMaterial, type ConcretePreset } from './concreteMaterial.ts';

const WALL_STAINS = {
  streakScale: [1.575, 21, 21] as [number, number, number],
  streakOctaves: 6,
  streakGain: 0.75,
  streakLow: 0.375,
  streakHigh: 1.0,
  blotchScale: 0.75,
  blotchOctaves: 4,
  blotchGain: 0.75,
  blotchLow: 0.45,
  blotchHigh: 0.75,
  albedoAmount: 0.855,
  roughnessAmount: 0.375,
};

const WALLS: ConcretePreset = {
  grainScale: 0.9,
  grainOctaves: 8,
  grainGain: 0.9,
  shadeLow: 0.15,
  shadeHigh: 0.855,
  shadeDark: [0.209, 0.209, 0.209],
  shadeLight: [0.701, 0.701, 0.701],
  tintDark: [0.073, 0.051, 0.036],
  tintLight: [0.241, 0.27, 0.319],
  tintAmount: 0.255,
  tintUvMix: 0.45,
  roughnessLow: 0.225,
  roughnessHigh: 0.375,
  grainRelief: 0.12,
  chipLow: 0.51,
  chipHigh: 0.675,
  chipRelief: 0.15,
  stains: WALL_STAINS,
};

const PANELS: ConcretePreset = {
  ...WALLS,
  tintDark: [0.073, 0.068, 0.065],
  stains: { ...WALL_STAINS, streakScale: [21, 21, 1.575] },
};

const FLOOR_A: ConcretePreset = {
  grainScale: 1.35,
  grainOctaves: 8,
  grainGain: 0.9,
  shadeLow: 0.15,
  shadeHigh: 0.855,
  shadeDark: [0.02, 0.014, 0.011],
  shadeLight: [0.319, 0.272, 0.223],
  tintDark: [0, 0, 0],
  tintLight: [1, 1, 1],
  tintAmount: 0.3,
  tintUvMix: 0.45,
  roughnessLow: 0.135,
  roughnessHigh: 0.45,
  grainRelief: 0.12,
  chipLow: 0.51,
  chipHigh: 0.675,
  chipRelief: 0.135,
  stains: null,
};

const FLOOR_B: ConcretePreset = {
  ...FLOOR_A,
  grainOctaves: 6,
  shadeDark: [0.053, 0.035, 0.027],
  shadeLight: [0.413, 0.353, 0.289],
  tintAmount: 0.15,
  roughnessLow: 0.18,
  roughnessHigh: 0.345,
  grainRelief: 0.195,
  chipRelief: 0.375,
};

const DEFAULT_BUMP_SCALE = 0;

const PRESETS: Record<string, ConcretePreset> = {
  concrete_walls: WALLS,
  concrete_panels: PANELS,
  concrete_floor_a: FLOOR_A,
  concrete_floor_b: FLOOR_B,
};

export function createCorridorMaterials(): Map<string, THREE.MeshStandardNodeMaterial> {
  const raw = new URLSearchParams(window.location.search).get('concreteBump');
  const requested = raw === null ? Number.NaN : Number(raw);
  const bumpScale = Number.isFinite(requested) && requested >= 0 ? requested : DEFAULT_BUMP_SCALE;
  const built = new Map<string, THREE.MeshStandardNodeMaterial>();
  for (const [name, preset] of Object.entries(PRESETS)) {
    const material = createConcreteMaterial(preset, bumpScale);
    material.name = name;
    built.set(name, material);
  }
  return built;
}

export { createConcreteMaterial, type ConcretePreset } from './concreteMaterial.ts';
