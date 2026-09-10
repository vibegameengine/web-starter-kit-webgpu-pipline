import * as THREE from 'three/webgpu';
import {
  attribute,
  clamp,
  faceDirection,
  float,
  mix,
  mx_fractal_noise_float,
  normalView,
  positionLocal,
  positionView,
  vec2,
  vec3,
} from 'three/tsl';

type Node = ReturnType<typeof float>;
type Rgb = [number, number, number];

export interface StainPreset {
  streakScale: Rgb;
  streakOctaves: number;
  streakGain: number;
  streakLow: number;
  streakHigh: number;
  blotchScale: number;
  blotchOctaves: number;
  blotchGain: number;
  blotchLow: number;
  blotchHigh: number;
  albedoAmount: number;
  roughnessAmount: number;
}

export interface ConcretePreset {
  grainScale: number;
  grainOctaves: number;
  grainGain: number;
  shadeLow: number;
  shadeHigh: number;
  shadeDark: Rgb;
  shadeLight: Rgb;
  tintDark: Rgb;
  tintLight: Rgb;
  tintAmount: number;
  tintUvMix: number;
  roughnessLow: number;
  roughnessHigh: number;
  grainRelief: number;
  chipLow: number;
  chipHigh: number;
  chipRelief: number;
  stains: StainPreset | null;
}

function rampAt(value: number, low: number, high: number): number {
  return Math.min(1, Math.max(0, (value - low) / Math.max(high - low, 1e-4)));
}

function meanAlbedo(preset: ConcretePreset): THREE.Color {
  const shade = rampAt(0.5, preset.shadeLow, preset.shadeHigh);
  const tintMean = preset.shadeDark.map((_, i) => (preset.tintDark[i] + preset.tintLight[i]) * 0.5 * (1 - preset.tintUvMix));
  const stain = preset.stains
    ? rampAt(0.5, preset.stains.streakLow, preset.stains.streakHigh)
      * rampAt(0.5, preset.stains.blotchLow, preset.stains.blotchHigh)
      * preset.stains.albedoAmount
    : 0;
  const channel = (i: number) => {
    const base = preset.shadeDark[i] + (preset.shadeLight[i] - preset.shadeDark[i]) * shade;
    return Math.min(1, Math.max(0, base + tintMean[i] * preset.tintAmount - stain));
  };
  return new THREE.Color(channel(0), channel(1), channel(2));
}

function amplitudeSum(octaves: number, gain: number): number {
  let sum = 0;
  for (let i = 0; i < octaves; i += 1) sum += gain ** i;
  return sum;
}

function fbm01(position: Node, octaves: number, gain: number): Node {
  const raw = mx_fractal_noise_float(position, octaves, 2, gain);
  return raw.div(amplitudeSum(octaves, gain)).mul(0.5).add(0.5);
}

function ramp(value: Node, low: number, high: number): Node {
  return clamp(value.sub(low).div(Math.max(high - low, 1e-4)), 0, 1);
}

const blenderObjectCoord = vec3(positionLocal.x, positionLocal.z.negate(), positionLocal.y);

function stainMask(preset: StainPreset): Node {
  const streakCoord = blenderObjectCoord.mul(vec3(...preset.streakScale));
  const streak = ramp(fbm01(streakCoord, preset.streakOctaves, preset.streakGain), preset.streakLow, preset.streakHigh);
  const blotchCoord = blenderObjectCoord.mul(preset.blotchScale);
  const blotch = ramp(fbm01(blotchCoord, preset.blotchOctaves, preset.blotchGain), preset.blotchLow, preset.blotchHigh);
  return streak.mul(blotch);
}

function proceduralBump(height: Node, scale: number): Node {
  const gradient = vec2(height.dFdx(), height.dFdy()).mul(scale);
  const sigmaX = positionView.dFdx().normalize();
  const sigmaY = positionView.dFdy().normalize();
  const r1 = sigmaY.cross(normalView);
  const r2 = normalView.cross(sigmaX);
  const determinant = sigmaX.dot(r1).mul(faceDirection);
  const slope = determinant.sign().mul(gradient.x.mul(r1).add(gradient.y.mul(r2)));
  return determinant.abs().mul(normalView).sub(slope).normalize();
}

export function createConcreteMaterial(preset: ConcretePreset, bumpScale = 1): THREE.MeshStandardNodeMaterial {
  const grain = fbm01(blenderObjectCoord.mul(preset.grainScale), preset.grainOctaves, preset.grainGain);
  const shade = ramp(grain, preset.shadeLow, preset.shadeHigh);
  const shadeColor = mix(vec3(...preset.shadeDark), vec3(...preset.shadeLight), shade);
  const island = attribute('color', 'vec4').r;
  const tint = mix(vec3(...preset.tintDark), vec3(...preset.tintLight), island).mul(1 - preset.tintUvMix);
  const stain = preset.stains ? stainMask(preset.stains) : float(0);

  const albedoLoss = preset.stains ? stain.mul(preset.stains.albedoAmount) : float(0);
  const albedo = clamp(shadeColor.add(tint.mul(preset.tintAmount)).sub(albedoLoss), 0, 1);
  const shadeValue = shadeColor.x.add(shadeColor.y).add(shadeColor.z).div(3);
  const roughnessLoss = preset.stains ? stain.mul(preset.stains.roughnessAmount) : float(0);
  const roughness = clamp(
    mix(float(preset.roughnessLow), float(preset.roughnessHigh), shadeValue).sub(roughnessLoss),
    0.05,
    1,
  );

  const chip = ramp(grain, preset.chipLow, preset.chipHigh);
  const relief = grain.mul(preset.grainRelief).add(chip.mul(preset.chipRelief));

  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = albedo;
  material.roughnessNode = roughness;
  material.metalnessNode = float(0);
  material.normalNode = proceduralBump(relief, bumpScale);
  material.userData.lightmapAlbedo = true;
  material.color = meanAlbedo(preset);
  material.roughness = (preset.roughnessLow + preset.roughnessHigh) * 0.5;
  material.metalness = 0;
  return material;
}
