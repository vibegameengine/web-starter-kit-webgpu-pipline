import { createNoise2D, createNoise3D } from 'simplex-noise';

/** Deterministic 32-bit PRNG (mulberry32). Same seed, same scene, same bake key. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface NoiseField {
  noise2(x: number, y: number): number;
  noise3(x: number, y: number, z: number): number;
  /** Fractal Brownian motion in [-1, 1]-ish; `octaves` layers, each halving amplitude. */
  fbm2(x: number, y: number, octaves?: number, lacunarity?: number, gain?: number): number;
  fbm3(x: number, y: number, z: number, octaves?: number, lacunarity?: number, gain?: number): number;
  /** Ridged multifractal in [0, 1]: sharp crests, the shape of eroded rock. */
  ridged2(x: number, y: number, octaves?: number): number;
  ridged3(x: number, y: number, z: number, octaves?: number): number;
}

/** Seeded simplex noise with the usual fractal helpers on top. CPU side only. */
export function createNoise(seed: number): NoiseField {
  const random = seededRandom(seed);
  const noise2 = createNoise2D(random);
  const noise3 = createNoise3D(random);

  const fbm2 = (x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5): number => {
    let amplitude = 1;
    let frequency = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += noise2(x * frequency, y * frequency) * amplitude;
      norm += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return sum / norm;
  };

  const fbm3 = (x: number, y: number, z: number, octaves = 5, lacunarity = 2, gain = 0.5): number => {
    let amplitude = 1;
    let frequency = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += noise3(x * frequency, y * frequency, z * frequency) * amplitude;
      norm += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return sum / norm;
  };

  const ridged2 = (x: number, y: number, octaves = 4): number => {
    let amplitude = 0.5;
    let frequency = 1;
    let sum = 0;
    let weight = 1;
    for (let i = 0; i < octaves; i++) {
      let signal = 1 - Math.abs(noise2(x * frequency, y * frequency));
      signal *= signal * weight;
      weight = Math.min(1, Math.max(0, signal * 2));
      sum += signal * amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }
    return Math.min(1, sum);
  };

  const ridged3 = (x: number, y: number, z: number, octaves = 4): number => {
    let amplitude = 0.5;
    let frequency = 1;
    let sum = 0;
    let weight = 1;
    for (let i = 0; i < octaves; i++) {
      let signal = 1 - Math.abs(noise3(x * frequency, y * frequency, z * frequency));
      signal *= signal * weight;
      weight = Math.min(1, Math.max(0, signal * 2));
      sum += signal * amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }
    return Math.min(1, sum);
  };

  return { noise2, noise3, fbm2, fbm3, ridged2, ridged3 };
}
