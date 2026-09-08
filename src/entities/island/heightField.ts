import * as THREE from 'three/webgpu';
import { createNoise, type NoiseField } from '../../shared/lib/noise.ts';

/**
 * The one shape every part of the diorama agrees on.
 *
 * The sand mesh, the slab walls, rock placement and the water shader all read the
 * same function, so the shoreline the water finds by depth test is the shoreline the
 * foam and the wet-sand band are drawn on. Height is metres; `0` is the water level.
 */
export class IslandField {
  readonly noise: NoiseField;
  /** Slab is a square of side `2 * half`, centred on the origin. */
  readonly half: number;
  /** Bottom of the slab, metres. */
  readonly bottom: number;
  readonly waterLevel = 0;

  constructor(seed = 7, half = 6, bottom = -3.2) {
    this.noise = createNoise(seed);
    this.half = half;
    this.bottom = bottom;
  }

  /**
   * Sand height at (x, z). Beach rises from the front-left (deep water, ~-1 m) to the
   * back-right (dry sand, ~+1 m) along a slightly curved, noisy shoreline.
   */
  height(x: number, z: number): number {
    const h = this.half;
    const n = this.noise;
    // Beach gradient: land is toward +x and -z (back right). Bay curvature bends
    // the shoreline so the water pushes a tongue into the sand at the front.
    const bay = 0.16 * Math.sin((z / h) * 2.1 + 0.6) + 0.12 * n.fbm2(x * 0.09 + 3.1, z * 0.09, 3);
    const t = (x * 0.82 - z * 0.34) / h + bay;

    // Underwater floor: gentle slope with a few humps, deepest at the far corner.
    const floor = -0.95 + 0.25 * n.fbm2(x * 0.22, z * 0.22, 3) - 0.35 * smooth(-0.15, -1.2, t);
    // Beach above the water line: a gentle foreshore first (slope ~0.03, where the
    // swash runs up and the sand stays wet), then the berm and a slow dune rise.
    const berm = 0.02 + 0.12 * smooth(-0.08, 0.5, t) + 0.43 * smooth(0.32, 0.8, t) + 0.5 * smooth(0.55, 1.1, t);
    const dunes = 0.08 * n.fbm2(x * 0.35 + 9.0, z * 0.35, 3) * smooth(0.1, 0.6, t);

    let y = mix(floor, berm + dunes, smooth(-0.32, 0.06, t));

    // Ripples: sand ripples under water, wind ripples on the dry sand. The swash zone
    // between them is planar — the run-up erases ripples there, and a run-up front
    // over ripples would follow their troughs as a row of cusps.
    const rel = y - this.waterLevel;
    const wet = smooth(-0.12, -0.3, rel);
    const dry = smooth(0.15, 0.35, rel);
    const rippleDir = x * 0.86 + z * 0.5;
    const ripple = Math.sin(rippleDir * 15.0 + 3.0 * n.noise2(x * 0.6, z * 0.6));
    y += 0.007 * ripple * wet;
    y += 0.0025 * Math.sin(rippleDir * 22.0 + 4.0 * n.noise2(x * 0.5 + 4, z * 0.5)) * dry;
    y += 0.01 * n.fbm2(x * 1.7, z * 1.7, 2);
    return y;
  }

  /** Vertical depth of water at (x, z); zero on land. */
  depth(x: number, z: number): number {
    return Math.max(0, this.waterLevel - this.height(x, z));
  }

  private readonly stamps: Array<{ x: number; z: number; rx: number; rz: number; top: number }> = [];

  /**
   * Registers a boulder footprint so the water sees it: depth, foam and the wet band
   * wrap around rocks that stand in the water, which the sand mesh alone cannot tell.
   */
  addStamp(x: number, z: number, rx: number, rz: number, top: number): void {
    this.stamps.push({ x, z, rx, rz, top });
  }

  /** Sand height plus stamped boulders; what the water shader marches against. */
  obstacleHeight(x: number, z: number): number {
    let y = this.height(x, z);
    for (const s of this.stamps) {
      const dx = (x - s.x) / s.rx;
      const dz = (z - s.z) / s.rz;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1) y = Math.max(y, s.top - (s.top - y) * Math.sqrt(d2));
    }
    return y;
  }

  /**
   * Height, packed for the GPU: R16F over the slab square, row-major, +z down.
   * With the boulder stamps (the bathymetry the water runs over) unless `bare`.
   */
  toTexture(size = 256, bare = false): THREE.DataTexture {
    const data = new Uint16Array(size * size);
    for (let j = 0; j < size; j++) {
      const z = -this.half + ((j + 0.5) / size) * 2 * this.half;
      for (let i = 0; i < size; i++) {
        const x = -this.half + ((i + 0.5) / size) * 2 * this.half;
        data[j * size + i] = THREE.DataUtils.toHalfFloat(bare ? this.height(x, z) : this.obstacleHeight(x, z));
      }
    }
    const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.HalfFloatType);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }
}

function smooth(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
