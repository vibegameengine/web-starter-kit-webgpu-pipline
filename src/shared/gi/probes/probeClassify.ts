import * as THREE from 'three/webgpu';
import { DISTANCE_SIDE, IRRADIANCE_SIDE, type ProbeVolume } from './probeVolume.ts';
import { HIT_DISTANCE, HIT_FLAG, HIT_RAW_DISTANCE, HIT_SIDE, type ProbeTrace } from './probeTracePass.ts';

const BACKFACE_FRACTION_LIMIT = 0.25;
const MAX_OFFSET_FRACTION = 0.45;
const RELOCATION_MARGIN = 0.05;

/* @important RTXGI's classification and relocation (DDGIVolume.md): a probe whose fixed rays hit more than
   25 % backfaces sits inside geometry and is inactive; it is pushed along the closest backface ray,
   through that face and out, the offset capped inside its own cell so the trilinear cage stays valid.
   The first version pushed the other way and drove probes deeper under the floor (critic, 2026-09-10). */
export function classifyProbes(volume: ProbeVolume, trace: ProbeTrace, directions: THREE.Vector3[], options: { relocate?: boolean } = {}): number {
  const relocateProbes = options.relocate ?? true;
  const maxOffset = MAX_OFFSET_FRACTION * volume.layout.spacing;
  const voxelRadius = volume.layout.spacing * Math.sqrt(3);
  const offset = new THREE.Vector3();
  let moved = 0;
  for (let probe = 0; probe < volume.count; probe++) {
    let backfaces = 0;
    let nearby = 0;
    let closestBackface = Infinity;
    let closestDirection = -1;
    for (let k = 0; k < trace.directions; k++) {
      const r = (probe * trace.directions + k) * 4;
      if (trace.hits[r + HIT_FLAG] < 0.5) continue;
      if (trace.hits[r + HIT_RAW_DISTANCE] <= voxelRadius) nearby++;
      if (trace.hits[r + HIT_SIDE] > 0) continue;
      backfaces++;
      if (trace.hits[r + HIT_RAW_DISTANCE] < closestBackface) { closestBackface = trace.hits[r + HIT_RAW_DISTANCE]; closestDirection = k; }
    }
    const inside = backfaces / trace.directions > BACKFACE_FRACTION_LIMIT;
    volume.setProbeActive(probe, !inside);
    if (!inside && nearby === 0) volume.setProbeEmpty(probe);
    if (!inside || !relocateProbes || closestDirection < 0) continue;
    offset.set(volume.probeData[probe * 4], volume.probeData[probe * 4 + 1], volume.probeData[probe * 4 + 2]);
    offset.addScaledVector(directions[closestDirection], closestBackface + RELOCATION_MARGIN * volume.layout.spacing);
    if (offset.length() > maxOffset) offset.setLength(maxOffset);
    volume.setProbeOffset(probe, offset);
    moved++;
  }
  return moved;
}

const DISTANCE_LOBE_POWER = 50;
const DISTANCE_LOBE_CUTOFF = 1e-4;

function coneWeights(directions: THREE.Vector3[]): Array<Array<[number, number]>> {
  return directions.map((texelDirection) => {
    const taps: Array<[number, number]> = [];
    directions.forEach((ray, j) => {
      const w = Math.pow(Math.max(0, texelDirection.dot(ray)), DISTANCE_LOBE_POWER);
      if (w > DISTANCE_LOBE_CUTOFF) taps.push([j, w]);
    });
    return taps;
  });
}

/* @important One ray per texel gives mean² ≡ mean-of-squares, so the Chebyshev test collapses to a hard
   step and draws a seam across a mover (critic, 2026-09-10). DDGI blends every ray into every texel
   with a pow-50 cosine lobe; the variance the test needs comes from that cone. */
export function writeDistances(volume: ProbeVolume, trace: ProbeTrace, directions: THREE.Vector3[]): void {
  if (trace.directions !== DISTANCE_SIDE * DISTANCE_SIDE) throw new Error('probes: distance trace must use the distance tile directions');
  const lobes = coneWeights(directions);
  for (let probe = 0; probe < volume.count; probe++) {
    const base = probe * trace.directions;
    for (let k = 0; k < trace.directions; k++) {
      let sum = 0; let sumSquares = 0; let weight = 0;
      for (const [j, w] of lobes[k]) {
        const d = trace.hits[(base + j) * 4 + HIT_DISTANCE];
        sum += w * d; sumSquares += w * d * d; weight += w;
      }
      const out = volume.distanceIndex(probe, k);
      volume.distance[out] = sum / weight; volume.distance[out + 1] = sumSquares / weight; volume.distance[out + 2] = 0; volume.distance[out + 3] = 1;
    }
  }
}

function neighbours(volume: ProbeVolume, probe: number): number[] {
  const [nx, ny, nz] = volume.layout.dims;
  const x = probe % nx; const y = Math.floor(probe / nx) % ny; const z = Math.floor(probe / (nx * ny));
  const list: number[] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy && !dz) continue;
    const X = x + dx; const Y = y + dy; const Z = z + dz;
    if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
    list.push(X + Y * nx + Z * nx * ny);
  }
  return list;
}

export function dilateInactiveProbes(volume: ProbeVolume, passes = 2): number {
  const texels = IRRADIANCE_SIDE * IRRADIANCE_SIDE;
  let filled = new Set<number>();
  for (let pass = 0; pass < passes; pass++) {
    const next = new Set<number>();
    for (let probe = 0; probe < volume.count; probe++) {
      if (volume.isActive(probe) || filled.has(probe)) continue;
      const sources = neighbours(volume, probe).filter((n) => volume.isActive(n) || filled.has(n));
      if (!sources.length) continue;
      for (const atlas of [volume.irradiance, volume.irradianceSun]) {
        for (let t = 0; t < texels; t++) {
          const d = volume.irradianceIndex(probe, t);
          let r = 0; let g = 0; let b = 0;
          for (const n of sources) { const s = volume.irradianceIndex(n, t); r += atlas[s]; g += atlas[s + 1]; b += atlas[s + 2]; }
          atlas[d] = r / sources.length; atlas[d + 1] = g / sources.length; atlas[d + 2] = b / sources.length; atlas[d + 3] = 1;
        }
      }
      next.add(probe);
    }
    filled = new Set([...filled, ...next]);
  }
  for (const probe of filled) volume.setProbeDilated(probe);
  let active = 0;
  for (let probe = 0; probe < volume.count; probe++) if (volume.isActive(probe)) active++;
  return active;
}
