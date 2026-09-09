import * as THREE from 'three/webgpu';
import { createNoise, type NoiseField } from '../../shared/lib/noise.ts';
import type { Cover } from './adaptiveMesh.ts';

export interface PathHit {
  distance: number;
  along: number;
}

const STREAM_POINTS: Array<[number, number]> = [
  [-4.4, -6.5],
  [-4.0, -4.4],
  [-3.6, -2.6],
  [-3.2, -1.2],
  [-2.8, 0.6],
  [-2.6, 2.8],
  [-2.7, 6.5],
];

const TRAIL_POINTS: Array<[number, number]> = [
  [3.1, -6.5],
  [2.7, -3.8],
  [2.1, -1.4],
  [1.6, 0.8],
  [1.3, 3.2],
  [1.3, 6.5],
];

const LEDGE_HEIGHT = 0.65;
const LEDGE_LINE_Z = -1.6;
const LEDGE_LINE_SKEW = 0.3;
const LEDGE_SLOPE = 0.45;
const CLEARING_RISE = 0.28;
const STREAM_HALF_WIDTH = 0.5;
const STREAM_DEPTH = 0.2;
const STREAM_WATER_DEPTH = 0.1;
const TRAIL_HALF_WIDTH = 0.85;
const TRAIL_DEPTH = 0.07;

class Path {
  private readonly points: THREE.Vector2[];

  constructor(raw: Array<[number, number]>) {
    this.points = raw.map(([x, z]) => new THREE.Vector2(x, z));
  }

  nearest(x: number, z: number): PathHit {
    let distance = Infinity;
    let along = 0;
    const segments = this.points.length - 1;
    for (let i = 0; i < segments; i++) {
      const a = this.points[i];
      const b = this.points[i + 1];
      const dx = b.x - a.x;
      const dz = b.y - a.y;
      const t = clamp01(((x - a.x) * dx + (z - a.y) * dz) / (dx * dx + dz * dz));
      const px = a.x + dx * t - x;
      const pz = a.y + dz * t - z;
      const d = Math.sqrt(px * px + pz * pz);
      if (d < distance) {
        distance = d;
        along = (i + t) / segments;
      }
    }
    return { distance, along };
  }

  pointAt(along: number): THREE.Vector2 {
    const segments = this.points.length - 1;
    const scaled = clamp01(along) * segments;
    const index = Math.min(segments - 1, Math.floor(scaled));
    return this.points[index].clone().lerp(this.points[index + 1], scaled - index);
  }
}

export class GroveField {
  readonly noise: NoiseField;
  readonly half: number;
  readonly bottom: number;
  private readonly stream = new Path(STREAM_POINTS);
  private readonly trail = new Path(TRAIL_POINTS);

  constructor(seed = 21, half = 6, bottom = -2.4) {
    this.noise = createNoise(seed);
    this.half = half;
    this.bottom = bottom;
  }

  height(x: number, z: number): number {
    const bank = this.terrace(x, z) + this.bumps(x, z) * (1 - this.streamMask(x, z));
    const channel = STREAM_DEPTH * this.streamMask(x, z);
    const rut = TRAIL_DEPTH * this.trailMask(x, z);
    return bank - channel - rut;
  }

  terrace(x: number, z: number): number {
    const towardBack = smooth(this.half, -this.half, z);
    const shelf = smooth(LEDGE_SLOPE, -LEDGE_SLOPE, this.ledgeSigned(x, z));
    return CLEARING_RISE * towardBack + LEDGE_HEIGHT * shelf;
  }

  private ledgeSigned(x: number, z: number): number {
    return z - (LEDGE_LINE_Z + LEDGE_LINE_SKEW * x);
  }

  private bumps(x: number, z: number): number {
    return 0.05 * this.noise.fbm2(x * 0.4 + 3.1, z * 0.4, 3);
  }

  streamMask(x: number, z: number): number {
    const hit = this.stream.nearest(x, z);
    return smooth(STREAM_HALF_WIDTH + 0.45, STREAM_HALF_WIDTH * 0.5, hit.distance);
  }

  streamSurface(x: number, z: number): number {
    return this.terrace(x, z) - STREAM_DEPTH + STREAM_WATER_DEPTH;
  }

  streamCentre(along: number): THREE.Vector2 {
    return this.stream.pointAt(along);
  }

  get streamHalfWidth(): number {
    return STREAM_HALF_WIDTH;
  }

  streamDistance(x: number, z: number): number {
    return this.stream.nearest(x, z).distance;
  }

  trailMask(x: number, z: number): number {
    const hit = this.trail.nearest(x, z);
    const wobble = 0.15 * this.noise.fbm2(x * 0.5 + 8.4, z * 0.5, 2);
    return smooth(TRAIL_HALF_WIDTH + wobble, TRAIL_HALF_WIDTH * 0.4, hit.distance);
  }

  trailDistance(x: number, z: number): number {
    return this.trail.nearest(x, z).distance;
  }

  ledgeDistance(x: number, z: number): number {
    return Math.abs(this.ledgeSigned(x, z)) / Math.hypot(1, LEDGE_LINE_SKEW);
  }

  detailDistance(x: number, z: number): number {
    return Math.min(
      Math.max(0, this.streamDistance(x, z) - STREAM_HALF_WIDTH),
      Math.max(0, this.trailDistance(x, z) - TRAIL_HALF_WIDTH),
      Math.max(0, this.ledgeDistance(x, z) - LEDGE_SLOPE),
    );
  }

  cover(x: number, z: number): Cover {
    const trail = this.trailMask(x, z);
    const stream = this.streamMask(x, z);
    const rockFromLedge = smooth(LEDGE_SLOPE * 1.6, LEDGE_SLOPE * 0.4, this.ledgeDistance(x, z));
    const rock = clamp01(Math.max(stream * 0.85, rockFromLedge * 0.8));
    const mud = clamp01(trail * (1 - rock));
    return [clamp01(1 - rock - mud), mud, rock];
  }

  normal(x: number, z: number, epsilon = 0.05): THREE.Vector3 {
    const dx = this.height(x + epsilon, z) - this.height(x - epsilon, z);
    const dz = this.height(x, z + epsilon) - this.height(x, z - epsilon);
    return new THREE.Vector3(-dx, 2 * epsilon, -dz).normalize();
  }
}

function smooth(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
