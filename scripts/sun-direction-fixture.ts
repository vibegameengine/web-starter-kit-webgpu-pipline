import * as THREE from 'three/webgpu';
import { findSunPositionWeighted } from '../src/shared/gi/surfel/envSunSearch.ts';

const WIDTH = 8;
const HEIGHT = 4;
const BACKGROUND = 1;
const SUN = 100;

type Angles = { azimuthDeg: number; elevationDeg: number };

function anglesOf(uv: readonly [number, number] | null): Angles | null {
  if (!uv) return null;
  return { azimuthDeg: (uv[0] - 0.5) * 360, elevationDeg: (0.5 - uv[1]) * 180 };
}

function panorama(values: number[], type: THREE.TextureDataType): THREE.DataTexture {
  const data = type === THREE.HalfFloatType
    ? Uint16Array.from(values, (value) => THREE.DataUtils.toHalfFloat(value))
    : Float32Array.from(values);
  const texture = new THREE.DataTexture(data, WIDTH, HEIGHT, THREE.RGBAFormat, type);
  texture.flipY = true;
  return texture;
}

function scene(bright: [number, number][]): number[] {
  const values: number[] = [];
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const lit = bright.some(([bx, by]) => bx === x && by === y);
      const level = lit ? SUN : BACKGROUND;
      values.push(level, level, level, 1);
    }
  }
  return values;
}

function report(name: string, values: number[]): { float: Angles | null; half: Angles | null } {
  const float = anglesOf(findSunPositionWeighted(panorama(values, THREE.FloatType)));
  const half = anglesOf(findSunPositionWeighted(panorama(values, THREE.HalfFloatType)));
  const show = (a: Angles | null) => (a ? `az ${a.azimuthDeg.toFixed(2)} el ${a.elevationDeg.toFixed(2)}` : 'sun not found');
  console.log(`${name.padEnd(18)} float32: ${show(float).padEnd(26)} half: ${show(half)}`);
  return { float, half };
}

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function agree(name: string, values: number[], toleranceDeg: number): void {
  const { float, half } = report(name, values);
  if (!float || !half) fail(`${name}: a sun was expected in both representations`);
  const azimuthGap = Math.abs(((float.azimuthDeg - half.azimuthDeg + 540) % 360) - 180);
  if (azimuthGap > toleranceDeg) fail(`${name}: azimuth differs by ${azimuthGap.toFixed(2)} deg`);
  if (Math.abs(float.elevationDeg - half.elevationDeg) > toleranceDeg) fail(`${name}: elevation differs`);
}

agree('single sun', scene([[6, 0]]), 0.01);
agree('seam sun', scene([[0, 1], [WIDTH - 1, 1]]), 0.01);

const uniform = report('uniform sky', scene([]));
if (uniform.float !== null || uniform.half !== null) fail('uniform sky: an overcast panorama has no sun to point at');

const blackFloat = findSunPositionWeighted(panorama(new Array(WIDTH * HEIGHT * 4).fill(0), THREE.FloatType));
const blackHalf = findSunPositionWeighted(panorama(new Array(WIDTH * HEIGHT * 4).fill(0), THREE.HalfFloatType));
if (blackFloat !== null || blackHalf !== null) fail('black env: expected "sun not found", not a direction');
console.log('black env       float32: sun not found          half: sun not found');

const seam = findSunPositionWeighted(panorama(scene([[0, 1], [WIDTH - 1, 1]]), THREE.HalfFloatType));
const seamAzimuth = anglesOf(seam)!.azimuthDeg;
if (Math.abs(Math.abs(seamAzimuth) - 180) > 1) fail(`seam sun: averaged to azimuth ${seamAzimuth.toFixed(2)}, which is the opposite side of the sky`);

console.log('OK sun direction: half-float decoded, seam averaged on the sphere, empty panorama reported');
