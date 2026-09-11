import * as THREE from 'three';
import { createNoise, seededRandom } from '../../shared/lib/noise';

/**
 * Parameters for one procedural boulder. Everything is derived from `seed`
 * unless overridden, so the same options always produce the same mesh.
 */
export interface RockGeometryOptions {
  detail?: number;
  seed: number;
  /** Nominal radius in metres (before anisotropic stretch). */
  radius: number;
  /** Anisotropic stretch. Default is derived from the seed. */
  scale?: THREE.Vector3Like;
  /** 0..1. Controls facet hardness, crack depth and normal flatness. Default 0.6. */
  sharpness?: number;
}

const BOTTOM_CLAMP = 0.75;

/** Fisher–Yates-free unit vector from two uniforms. */
function randomUnitVector(rng: () => number, out: THREE.Vector3): THREE.Vector3 {
  const z = rng() * 2 - 1;
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return out.set(r * Math.cos(a), z, r * Math.sin(a));
}

/**
 * IcosahedronGeometry ships non-indexed with duplicated shared vertices.
 * Weld them by quantised position so displacement is evaluated once per
 * physical vertex (no cracks) and smooth normals can be computed.
 */
function weldIcosphere(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const src = source.getAttribute('position') as THREE.BufferAttribute;
  const keyToIndex = new Map<string, number>();
  const unique: number[] = [];
  const index = new Uint32Array(src.count);
  for (let i = 0; i < src.count; i++) {
    const x = src.getX(i);
    const y = src.getY(i);
    const z = src.getZ(i);
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let idx = keyToIndex.get(key);
    if (idx === undefined) {
      idx = unique.length / 3;
      keyToIndex.set(key, idx);
      unique.push(x, y, z);
    }
    index[i] = idx;
  }
  source.dispose();
  const welded = new THREE.BufferGeometry();
  welded.setAttribute('position', new THREE.BufferAttribute(new Float32Array(unique), 3));
  welded.setIndex(new THREE.BufferAttribute(index, 1));
  return welded;
}

/**
 * Builds a non-indexed boulder mesh geometry:
 *   icosphere → anisotropic stretch → low-frequency lumps (fbm) →
 *   ridged crevices → random plane cuts (flat facets) → flattened bottom.
 * Attributes: position, normal (smooth/flat blend by sharpness), uv (spherical,
 * seam-fixed per triangle), crevice (float 0..1 for shading).
 */
export function createRockGeometry(options: RockGeometryOptions): THREE.BufferGeometry {
  const { seed, radius } = options;
  const sharpness = THREE.MathUtils.clamp(options.sharpness ?? 0.6, 0, 1);
  const rng = seededRandom((seed * 0x9e3779b1) >>> 0);
  const noise = createNoise((seed * 0x85ebca6b + 17) >>> 0);

  const scale = new THREE.Vector3();
  if (options.scale) {
    scale.copy(options.scale as THREE.Vector3);
  } else {
    // Boulders are wider than tall, and rarely symmetric in plan.
    scale.set(1.0 + rng() * 0.55, 0.62 + rng() * 0.38, 0.8 + rng() * 0.5);
  }

  // r182 PolyhedronGeometry: 20 * (detail + 1)^2 triangles, already non-indexed.
  // detail 31 → 20480 tris, detail 23 → 11520 tris.
  const detail = options.detail === undefined ? (radius < 0.4 ? 23 : 31) : Math.max(2, Math.min(31, Math.round(options.detail)));
  const indexed = weldIcosphere(new THREE.IcosahedronGeometry(1, detail));
  const pos = indexed.getAttribute('position') as THREE.BufferAttribute;
  const count = pos.count;

  // Noise domain offsets so different seeds sample different regions.
  const lumpOffset = new THREE.Vector3(rng() * 40, rng() * 40, rng() * 40);
  const ridgeOffset = new THREE.Vector3(rng() * 40 + 100, rng() * 40, rng() * 40);
  const lumpFreq = 1.1 + rng() * 0.5;
  const ridgeFreq = 3.6 + rng() * 1.6;
  const lumpAmp = 0.22 + rng() * 0.12;
  // Cracks are thin lines, not bumps: shallow, thresholded ridge crests.
  const creviceDepth = 0.025 + 0.045 * sharpness;

  const crevice = new Float32Array(count);
  const dirs = new Float32Array(count * 3);
  const d = new THREE.Vector3();
  const p = new THREE.Vector3();

  // Pass 1: anisotropic stretch + low-frequency lumps.
  for (let i = 0; i < count; i++) {
    d.fromBufferAttribute(pos, i).normalize();
    dirs[i * 3] = d.x;
    dirs[i * 3 + 1] = d.y;
    dirs[i * 3 + 2] = d.z;

    const lump = noise.fbm3(
      d.x * lumpFreq + lumpOffset.x,
      d.y * lumpFreq + lumpOffset.y,
      d.z * lumpFreq + lumpOffset.z,
      4,
      2.1,
      0.5,
    );
    const r = 1 + lumpAmp * lump;
    p.copy(d).multiplyScalar(r * radius).multiply(scale);
    pos.setXYZ(i, p.x, p.y, p.z);
  }

  // Random plane cuts: flatten everything beyond a plane → angular facets.
  const cutCount = 3 + Math.floor(rng() * 4) + Math.round(sharpness * 2);
  const n = new THREE.Vector3();
  for (let c = 0; c < cutCount; c++) {
    randomUnitVector(rng, n);
    // Bias cuts to the upper half and sides so the silhouette reads from above.
    if (n.y < -0.2) n.y = -n.y;
    n.normalize();

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < count; i++) {
      const t = pos.getX(i) * n.x + pos.getY(i) * n.y + pos.getZ(i) * n.z;
      if (t < min) min = t;
      if (t > max) max = t;
    }
    // Cut off the outer 10–30% of the extent along n.
    const depth = 0.1 + rng() * 0.2 * (0.5 + sharpness);
    const planeD = max - (max - min) * depth;
    for (let i = 0; i < count; i++) {
      const t = pos.getX(i) * n.x + pos.getY(i) * n.y + pos.getZ(i) * n.z;
      if (t > planeD) {
        const over = t - planeD;
        pos.setXYZ(i, pos.getX(i) - n.x * over, pos.getY(i) - n.y * over, pos.getZ(i) - n.z * over);
      }
    }
  }

  // Pass 2 (after the cuts, so cracks run across the facets too): ridged
  // crevices carved radially inwards. ridged3 is [0,1] with crests near 1.
  for (let i = 0; i < count; i++) {
    d.set(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]);
    const ridge = noise.ridged3(
      d.x * ridgeFreq + ridgeOffset.x,
      d.y * ridgeFreq + ridgeOffset.y,
      d.z * ridgeFreq + ridgeOffset.z,
      4,
    );
    // Narrow crest → geometric groove; slightly broader band → shading darkening.
    const crack = THREE.MathUtils.smoothstep(ridge, 0.62, 0.95);
    crevice[i] = THREE.MathUtils.smoothstep(ridge, 0.5, 0.95);
    const push = creviceDepth * crack * radius;
    pos.setXYZ(
      i,
      pos.getX(i) - d.x * push * scale.x,
      pos.getY(i) - d.y * push * scale.y,
      pos.getZ(i) - d.z * push * scale.z,
    );
  }

  // Flattened bottom so the boulder sits in sand.
  const floorY = -BOTTOM_CLAMP * radius * scale.y;
  for (let i = 0; i < count; i++) {
    if (pos.getY(i) < floorY) pos.setY(i, floorY);
  }

  indexed.setAttribute('crevice', new THREE.BufferAttribute(crevice, 1));

  // Smooth normals come from the shared-vertex mesh; flat ones from the
  // unwelded mesh. Blend by sharpness so facets read hard, lumps stay soft.
  indexed.computeVertexNormals();
  const geometry = indexed.toNonIndexed();
  indexed.dispose();

  const smooth = (geometry.getAttribute('normal') as THREE.BufferAttribute).array.slice() as Float32Array;
  geometry.computeVertexNormals();
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const flat = normal.array as Float32Array;
  const flatWeight = sharpness;
  const tmp = new THREE.Vector3();
  for (let i = 0; i < normal.count; i++) {
    const j = i * 3;
    tmp.set(
      smooth[j] * (1 - flatWeight) + flat[j] * flatWeight,
      smooth[j + 1] * (1 - flatWeight) + flat[j + 1] * flatWeight,
      smooth[j + 2] * (1 - flatWeight) + flat[j + 2] * flatWeight,
    ).normalize();
    normal.setXYZ(i, tmp.x, tmp.y, tmp.z);
  }
  normal.needsUpdate = true;

  buildSphericalUVs(geometry, radius, scale);

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Spherical UVs (for anything that samples `material.map` with a uv, e.g. a
 * ray tracer). Per triangle the wrap seam is fixed by shifting the low-u
 * vertices by +1, and pole vertices take the mean u of their neighbours, so
 * no triangle ever spans the seam. Tiling matches the raster's ~0.6 rpm.
 */
function buildSphericalUVs(geometry: THREE.BufferGeometry, radius: number, scale: THREE.Vector3): void {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const count = pos.count;
  const uv = new Float32Array(count * 2);
  const meanRadius = radius * (scale.x + scale.y + scale.z) / 3;
  const repeatU = Math.max(1, Math.round(2 * Math.PI * meanRadius * 0.6));
  const repeatV = Math.max(1, Math.round(Math.PI * meanRadius * 0.6));

  const d = new THREE.Vector3();
  const u = [0, 0, 0];
  const v = [0, 0, 0];
  const pole = [false, false, false];
  for (let t = 0; t < count; t += 3) {
    for (let k = 0; k < 3; k++) {
      d.fromBufferAttribute(pos, t + k).divide(scale).normalize();
      u[k] = 0.5 + Math.atan2(d.z, d.x) / (2 * Math.PI);
      v[k] = 0.5 + Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)) / Math.PI;
      pole[k] = Math.abs(d.y) > 0.999;
    }
    // Seam fix: if the triangle straddles u=0/1, lift the low side.
    let umin = Infinity;
    let umax = -Infinity;
    for (let k = 0; k < 3; k++) {
      if (pole[k]) continue;
      umin = Math.min(umin, u[k]);
      umax = Math.max(umax, u[k]);
    }
    if (umax - umin > 0.5) {
      for (let k = 0; k < 3; k++) if (!pole[k] && u[k] < 0.5) u[k] += 1;
    }
    // Pole vertices: use the mean u of the non-pole vertices.
    let sum = 0;
    let cnt = 0;
    for (let k = 0; k < 3; k++) if (!pole[k]) { sum += u[k]; cnt++; }
    const meanU = cnt > 0 ? sum / cnt : 0;
    for (let k = 0; k < 3; k++) if (pole[k]) u[k] = meanU;

    for (let k = 0; k < 3; k++) {
      const i = t + k;
      uv[i * 2] = THREE.MathUtils.clamp(u[k], 0, 1.5) * repeatU;
      uv[i * 2 + 1] = THREE.MathUtils.clamp(v[k], 0, 1) * repeatV;
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
