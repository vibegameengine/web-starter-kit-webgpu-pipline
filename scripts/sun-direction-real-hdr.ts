import { readFileSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { findSunPositionWeighted } from '../src/shared/gi/surfel/envSunSearch.ts';

const PANORAMA = process.argv[2] ?? 'public/exr/pizzo_pernice_puresky_2k.hdr';

const file = readFileSync(PANORAMA);
const parsed = new HDRLoader().parse(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
const texture = new THREE.DataTexture(parsed.data, parsed.width, parsed.height, THREE.RGBAFormat, parsed.type);
texture.flipY = true;

const anglesOf = (uv: readonly [number, number] | null) =>
  uv ? { azimuthDeg: (uv[0] - 0.5) * 360, elevationDeg: (0.5 - uv[1]) * 180 } : null;

function undecodedSearch(threshold = 0.5): readonly [number, number] {
  const data = parsed.data as ArrayLike<number>;
  const { width, height } = parsed;
  const lum = (i: number) => 0.2126 * Number(data[i]) + 0.7152 * Number(data[i + 1]) + 0.0722 * Number(data[i + 2]);
  let peak = 0;
  for (let i = 0; i < data.length; i += 4) peak = Math.max(peak, lum(i));
  const cutoff = peak * threshold;
  let sumX = 0;
  let sumY = 0;
  let weight = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = lum((y * width + x) * 4);
      if (value <= cutoff) continue;
      sumX += x * value;
      sumY += y * value;
      weight += value;
    }
  }
  return [(sumX / weight + 0.5) / width, (sumY / weight + 0.5) / height];
}

const show = (a: { azimuthDeg: number; elevationDeg: number } | null) =>
  a ? `azimuth ${a.azimuthDeg.toFixed(2)}, elevation ${a.elevationDeg.toFixed(2)}` : 'sun not found';

console.log(`${PANORAMA}: ${parsed.width}x${parsed.height}, type ${parsed.type === THREE.HalfFloatType ? 'HalfFloat' : parsed.type === THREE.FloatType ? 'Float' : String(parsed.type)}`);
console.log(`raw bit patterns read as radiance (the shipped bug): ${show(anglesOf(undecodedSearch()))}`);
console.log(`decoded, averaged on the sphere:                     ${show(anglesOf(findSunPositionWeighted(texture)))}`);
