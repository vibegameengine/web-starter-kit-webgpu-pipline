import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { OceanDetail } from '../../entities/water/oceanDetail.ts';

export async function checkOceanFFT(renderer: THREE.WebGPURenderer) {
  const detail = new OceanDetail({ renderer, clock: uniform(0), windSpeed: 0, windDirection: 0, inverseWaveAge: 1, depth: 30, longestWavelength: 4 });
  const band = detail.bands[0];
  const modes = [[3, 0, 0.13], [0, 5, 0.075], [7, -4, 0.035]];
  const initial = band.initial.image.data as Float32Array;
  const size = band.size;
  for (const [x, y, amplitude] of modes) {
    const i = (((y + size) % size) * size + (x + size) % size) * 4;
    const opposite = (((size - y) % size) * size + (size - x) % size) * 4;
    const coefficient = amplitude / (2 * Math.sqrt(2));
    initial[i] = coefficient; initial[i + 2] = coefficient;
    initial[opposite] = coefficient; initial[opposite + 2] = coefficient;
  }
  band.initial.needsUpdate = true;
  try {
    detail.update();
    const raw = await renderer.readRenderTargetPixelsAsync(band.output, 0, 0, size, size);
    let maximumSlopeError = 0, maximumMomentError = 0, maximumHeightError = 0, squaredError = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let sx = 0, sz = 0, height = 0;
      for (const [mx, mz, amplitude] of modes) {
        const sine = Math.sin(2 * Math.PI * (mx * x + mz * y) / size);
        sx -= amplitude * mx * 2 * Math.PI / band.length * sine;
        sz -= amplitude * mz * 2 * Math.PI / band.length * sine;
        height += amplitude * Math.cos(2 * Math.PI * (mx * x + mz * y) / size);
      }
      const at = (y * size + x) * 4;
      const dx = THREE.DataUtils.fromHalfFloat(raw[at]) - sx;
      const dz = THREE.DataUtils.fromHalfFloat(raw[at + 1]) - sz;
      maximumSlopeError = Math.max(maximumSlopeError, Math.abs(dx), Math.abs(dz));
      maximumMomentError = Math.max(maximumMomentError, Math.abs(THREE.DataUtils.fromHalfFloat(raw[at + 2]) - sx * sx - sz * sz));
      maximumHeightError = Math.max(maximumHeightError, Math.abs(THREE.DataUtils.fromHalfFloat(raw[at + 3]) - height));
      squaredError += dx * dx + dz * dz;
    }
    const clock = 0.43;
    (detail as unknown as { options: { clock: { value: number } } }).options.clock.value = clock;
    detail.update();
    const motion = await renderer.readRenderTargetPixelsAsync(band.transport!, 0, 0, size, size);
    let maximumVelocityError = 0, maximumAccelerationError = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let vx = 0, vz = 0, acceleration = 0;
      for (const [mx, mz, amplitude] of modes) {
        const k = Math.hypot(mx, mz) * 2 * Math.PI / band.length;
        const omega = Math.sqrt(9.82 * k * (1 + (k / 370) ** 2) * Math.tanh(k * 30));
        const spatial = 2 * Math.PI * (mx * x + mz * y) / size;
        const velocity = amplitude * omega / Math.tanh(k * 30) * Math.sin(omega * clock) * Math.sin(spatial);
        vx += velocity * mx / Math.hypot(mx, mz);
        vz += velocity * mz / Math.hypot(mx, mz);
        acceleration -= amplitude * omega ** 2 * Math.cos(omega * clock) * Math.cos(spatial);
      }
      const at = (y * size + x) * 4;
      maximumVelocityError = Math.max(maximumVelocityError, Math.abs(THREE.DataUtils.fromHalfFloat(motion[at]) - vx), Math.abs(THREE.DataUtils.fromHalfFloat(motion[at + 1]) - vz));
      maximumAccelerationError = Math.max(maximumAccelerationError, Math.abs(THREE.DataUtils.fromHalfFloat(motion[at + 2]) - acceleration));
    }
    return { samples: size * size, modes, maximumSlopeError, maximumMomentError, maximumHeightError,
      maximumVelocityError, maximumAccelerationError,
      rmsSlopeError: Math.sqrt(squaredError / (size * size * 2)), passed: maximumSlopeError < 0.0002 && maximumMomentError < 0.0001 && maximumHeightError < 0.0002 && maximumVelocityError < 0.0005 && maximumAccelerationError < 0.001 };
  } finally { detail.dispose(); }
}
