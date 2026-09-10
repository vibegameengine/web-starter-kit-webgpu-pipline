import type * as THREE from 'three/webgpu';
import { float, vec3 } from 'three/tsl';
import { SurfaceField } from '../../entities/water/surfaceField.ts';

export async function checkSurfaceReadback(renderer: THREE.WebGPURenderer) {
  const field = new SurfaceField({ renderer, size: 8, half: 1, waterLevel: 0, simHeight: xz => xz.x.add(xz.y.mul(2)), wind: () => vec3(0), rim: () => float(1), windCap: 1, film: () => float(1) });
  try {
    field.update();
    const rows = [];
    for (const [x, z] of [[0, 0], [0.125, 0.25], [-0.2, 0.1], [0.4, -0.35]]) {
      const actual = await field.readAt(x, z);
      const expected = { eta: x + 2 * z, slopeX: 1, slopeZ: 2 };
      const error = Math.max(Math.abs(actual.eta - expected.eta), Math.abs(actual.slopeX - 1), Math.abs(actual.slopeZ - 2));
      if (error > 0.002) throw new Error(`Surface readback error ${error} at ${x}, ${z}`);
      rows.push({ x, z, expected, actual, error });
    }
    return rows;
  } finally {
    field.dispose();
  }
}
