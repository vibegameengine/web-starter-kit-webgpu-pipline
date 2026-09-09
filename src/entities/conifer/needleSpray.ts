import * as THREE from 'three/webgpu';
import type { LeafRamp, RGB } from '../foliage/leafOptics.ts';
import { sampleLeafRamp } from '../foliage/leafOptics.ts';

export interface NeedleShoot {
  origin: THREE.Vector3;
  forward: THREE.Vector3;
  up: THREE.Vector3;
  length: number;
  needleLength: number;
  needleWidth: number;
  pairs: number;
  ramp: LeafRamp;
  spread: number;
}

export class NeedleBuilder {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];
  private readonly transmittances: number[] = [];
  private readonly uvs: number[] = [];
  private readonly indices: number[] = [];

  vertex(point: THREE.Vector3, reflectance: RGB, transmittance: RGB, u: number, v: number): number {
    const id = this.positions.length / 3;
    this.positions.push(point.x, point.y, point.z);
    this.colors.push(reflectance[0], reflectance[1], reflectance[2]);
    this.transmittances.push(transmittance[0], transmittance[1], transmittance[2]);
    this.uvs.push(u, v);
    return id;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, c, b, b, c, d);
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute('transmittance', new THREE.Float32BufferAttribute(this.transmittances, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setIndex(this.indices);
    return geometry;
  }

  get needleCount(): number {
    return this.indices.length / 6;
  }
}

const SIDE = new THREE.Vector3();
const BASE = new THREE.Vector3();
const TIP = new THREE.Vector3();
const AXIS = new THREE.Vector3();
const WIDTH = new THREE.Vector3();

function needleDirection(shoot: NeedleShoot, sign: number, t: number, out: THREE.Vector3): THREE.Vector3 {
  SIDE.crossVectors(shoot.forward, shoot.up).normalize();
  const droop = 0.25 + 0.35 * t;
  return out
    .copy(SIDE)
    .multiplyScalar(sign * Math.cos(shoot.spread))
    .addScaledVector(shoot.up, Math.sin(shoot.spread) - droop * 0.35)
    .addScaledVector(shoot.forward, 0.55)
    .normalize();
}

/**
 * @important A needle is a flat quad, not a cylinder: spruce needles are 1 mm across
 * and a round one costs eight times the triangles for a silhouette no camera in this
 * diorama can resolve, while the flat one still catches the light on both faces.
 */
export function appendShoot(builder: NeedleBuilder, shoot: NeedleShoot): void {
  for (let i = 0; i < shoot.pairs; i++) {
    const t = (i + 0.5) / shoot.pairs;
    BASE.copy(shoot.origin).addScaledVector(shoot.forward, t * shoot.length);
    const optics = sampleLeafRamp(shoot.ramp, t);
    for (const sign of [-1, 1]) {
      needleDirection(shoot, sign, t, AXIS);
      const length = shoot.needleLength * (0.75 + 0.35 * (1 - t));
      TIP.copy(BASE).addScaledVector(AXIS, length);
      WIDTH.crossVectors(AXIS, shoot.forward).normalize().multiplyScalar(shoot.needleWidth * 0.5);
      const a = builder.vertex(BASE.clone().sub(WIDTH), optics.R, optics.T, 0, 0);
      const b = builder.vertex(BASE.clone().add(WIDTH), optics.R, optics.T, 1, 0);
      const c = builder.vertex(TIP.clone().sub(WIDTH.clone().multiplyScalar(0.4)), optics.R, optics.T, 0, 1);
      const d = builder.vertex(TIP.clone().add(WIDTH.clone().multiplyScalar(0.4)), optics.R, optics.T, 1, 1);
      builder.quad(a, b, c, d);
    }
  }
}
