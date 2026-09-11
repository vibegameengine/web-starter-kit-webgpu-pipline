import * as THREE from 'three/webgpu';

const DEG = Math.PI / 180;
const REFINE_CONE_DEG = 20;

/* @important A resultant length of 1 is one tight lobe and 0 is light spread evenly over
   the sphere. An overcast panorama passes the half-max cutoff everywhere, its texels
   cancel, and what survives is numerical residue pointing nowhere; below this the answer
   is "no sun", not a confident direction. A sun inside a 60 deg cone still scores 0.75. */
const MIN_LOBE_CONCENTRATION = 0.5;

export type SunUv = readonly [number, number];

type Direction = { x: number; y: number; z: number };
type Accumulation = { direction: Direction; weight: number };

/* @important HalfFloatType panoramas hold float16 bit patterns in a Uint16Array, not
   radiance: read raw, 1.0 is 15360 and 100.0 is 22080, so a half-max cutoff of 11040
   keeps the whole background and the centroid slides to the middle of the panorama.
   The synthetic 8x4 fixture moved the sun from 67.5 deg to 0.91 deg that way. */
function radianceReader(texture: THREE.DataTexture): (index: number) => number {
  const data = texture.image.data as ArrayLike<number>;
  const half = texture.type === THREE.HalfFloatType;
  return (index) => {
    const value = half ? THREE.DataUtils.fromHalfFloat(Number(data[index])) : Number(data[index]);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  };
}

function luminanceAt(read: (index: number) => number, index: number): number {
  return 0.2126 * read(index) + 0.7152 * read(index + 1) + 0.0722 * read(index + 2);
}

function peakLuminance(read: (index: number) => number, length: number): number {
  let peak = 0;
  for (let index = 0; index + 3 < length; index += 4) {
    const luminance = luminanceAt(read, index);
    if (luminance > peak) peak = luminance;
  }
  return peak;
}

function directionOf(azimuthDeg: number, elevationDeg: number): Direction {
  const azimuth = azimuthDeg * DEG;
  const elevation = elevationDeg * DEG;
  const horizontal = Math.cos(elevation);
  return { x: horizontal * Math.sin(azimuth), y: Math.sin(elevation), z: horizontal * Math.cos(azimuth) };
}

function normalize(direction: Direction): Direction | null {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 0)) return null;
  return { x: direction.x / length, y: direction.y / length, z: direction.z / length };
}

function uvOf(direction: Direction): SunUv {
  const azimuthDeg = Math.atan2(direction.x, direction.z) / DEG;
  const elevationDeg = Math.asin(Math.min(1, Math.max(-1, direction.y))) / DEG;
  return [azimuthDeg / 360 + 0.5, 0.5 - elevationDeg / 180];
}

function rowElevationDeg(y: number, height: number, flipY: boolean): number {
  const row = (y + 0.5) / height;
  return (0.5 - (flipY ? row : 1 - row)) * 180;
}

/* @important Bright texels are averaged as directions on the sphere, never as UV: a sun
   straddling the u=0/1 seam averages in UV to u=0.5, the opposite side of the sky. The
   weight carries the texel's solid angle (proportional to cos(elevation)) so the
   compressed rows at the poles cannot outvote the horizon. */
function accumulate(
  texture: THREE.DataTexture,
  read: (index: number) => number,
  cutoff: number,
  cone: { direction: Direction; cosine: number } | null,
): Accumulation {
  const { width, height } = texture.image;
  const sum = { x: 0, y: 0, z: 0 };
  let weight = 0;
  for (let y = 0; y < height; y++) {
    const elevationDeg = rowElevationDeg(y, height, texture.flipY);
    const solidAngle = Math.max(0, Math.cos(elevationDeg * DEG));
    for (let x = 0; x < width; x++) {
      const luminance = luminanceAt(read, (y * width + x) * 4);
      if (luminance <= cutoff) continue;
      const direction = directionOf(((x + 0.5) / width - 0.5) * 360, elevationDeg);
      if (cone && direction.x * cone.direction.x + direction.y * cone.direction.y + direction.z * cone.direction.z < cone.cosine) continue;
      const sampleWeight = luminance * solidAngle;
      sum.x += direction.x * sampleWeight;
      sum.y += direction.y * sampleWeight;
      sum.z += direction.z * sampleWeight;
      weight += sampleWeight;
    }
  }
  return { direction: sum, weight };
}

export function findSunPositionWeighted(texture: THREE.DataTexture, threshold = 0.5): SunUv | null {
  const { data } = texture.image;
  if (!data) throw new Error('No data');
  const read = radianceReader(texture);
  const cutoff = peakLuminance(read, (data as ArrayLike<number>).length) * threshold;
  if (!(cutoff > 0)) return null;
  const spread = accumulate(texture, read, cutoff, null);
  const coarse = normalize(spread.direction);
  if (!coarse || Math.hypot(spread.direction.x, spread.direction.y, spread.direction.z) < spread.weight * MIN_LOBE_CONCENTRATION) return null;
  const refined = accumulate(texture, read, cutoff, { direction: coarse, cosine: Math.cos(REFINE_CONE_DEG * DEG) });
  return uvOf(normalize(refined.direction) ?? coarse);
}
