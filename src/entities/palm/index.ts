/**
 * Coconut palm entity — procedural, deterministic per seed.
 *
 * Origin at the trunk base, +Y up, metres. Three meshes:
 *   - `palmTrunk`    slim tapered S-curved tube, ringed leaf-scar bark, lightmappable.
 *   - `palmLeaves`   crown fronds + dead hanging fronds, one merged geometry,
 *                    vertex colours, TSL wind sway, lit live (not lightmapped).
 *   - `palmCoconuts` small cluster at the crown base.
 *
 * Crown model (Cocos nucifera at ~10 m): 11–14 long fronds (0.75–0.85 × trunk
 * height) spread by the golden angle, the youngest two or three standing as a
 * spike in the centre, the oldest lowest. Each rachis leaves the crown 25–45°
 * above horizontal, arches over and ends 35–60° below. 22–30 leaflet pairs per
 * frond, long lanceolate leaflets in a V that droop toward their tips — that is
 * what makes the silhouette feathery with individual leaflets rather than a fern.
 *
 * Albedo convention (matches `applyLightmap.ts` and the ray tracer): the raster
 * shades `material.color * map` (or `colorNode`), and the tracer reads
 * `material.color` (times the map's mean) as the flat albedo. The bark map is
 * therefore normalised so its mean is 1.0 and `material.color` carries the true
 * average colour; the leaf material uses `colorNode = vertexColor()` and keeps the
 * average leaf colour in `material.color`.
 */
import * as THREE from 'three/webgpu';
import { attribute, positionLocal, positionWorld, sin, uniform, vec3, vertexColor } from 'three/tsl';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { leafTranslucency } from '../foliage/translucency.ts';
import { createNoise, seededRandom } from '../../shared/lib/noise';

export interface PalmOptions {
  seed: number;
  /** Trunk length in metres, 3..6. */
  height: number;
  /** Trunk lean in radians; default derived from the seed (0.1..0.35). */
  lean?: number;
}

export interface Palm {
  group: THREE.Group;
  update(timeSec: number): void;
}

type RGB = [number, number, number];

const UP = new THREE.Vector3(0, 1, 0);
const TWO_PI = Math.PI * 2;
const GOLDEN_ANGLE = 2.399963;

// ---------------------------------------------------------------------------
// Non-indexed geometry accumulator. Every vertex carries position / normal / uv /
// colour / sway so the per-frond geometries merge without attribute mismatch.
// ---------------------------------------------------------------------------

interface Vert {
  p: THREE.Vector3;
  n: THREE.Vector3;
  c: RGB;
  u: number;
  v: number;
  /** Wind weight, 0 at a frond base .. 1 at its tip. */
  s: number;
}

class MeshBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly uv: number[] = [];
  private readonly sway: number[] = [];

  private push(v: Vert): void {
    this.pos.push(v.p.x, v.p.y, v.p.z);
    this.nor.push(v.n.x, v.n.y, v.n.z);
    this.col.push(v.c[0], v.c[1], v.c[2]);
    this.uv.push(v.u, v.v);
    this.sway.push(v.s);
  }

  tri(a: Vert, b: Vert, c: Vert): void {
    this.push(a);
    this.push(b);
    this.push(c);
  }

  quad(a: Vert, b: Vert, c: Vert, d: Vert): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(this.sway, 1));
    return g;
  }
}

const vert = (p: THREE.Vector3, n: THREE.Vector3, c: RGB, u: number, v: number, s: number): Vert => ({
  p: p.clone(),
  n: n.clone(),
  c,
  u,
  v,
  s,
});

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const mixRGB = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const scaleRGB = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];

// ---------------------------------------------------------------------------
// Trunk
// ---------------------------------------------------------------------------

interface TrunkResult {
  geometry: THREE.BufferGeometry;
  /** Crown base: end point and tangent of the spine. */
  top: THREE.Vector3;
  topTangent: THREE.Vector3;
}

function buildTrunk(height: number, lean: number, leanAz: number, rng: () => number, noise: ReturnType<typeof createNoise>): TrunkResult {
  // Spine: the lean grows with t^1.6 (a palm bends most in its upper half) and a
  // pronounced S sweep runs in the perpendicular horizontal direction.
  const leanDir = new THREE.Vector3(Math.cos(leanAz), 0, Math.sin(leanAz));
  const sDir = new THREE.Vector3(-leanDir.z, 0, leanDir.x);
  const sPhase = rng() * TWO_PI;
  const sAmp = (0.28 + rng() * 0.14) * (height / 5);
  const leanReach = Math.sin(lean) * height;
  const points: THREE.Vector3[] = [];
  const controlCount = 9;
  for (let k = 0; k < controlCount; k++) {
    const t = k / (controlCount - 1);
    const reach = leanReach * Math.pow(t, 1.6);
    const y = height * t * Math.cos(lean * t * 0.8);
    const s = Math.sin(t * Math.PI * 1.5 + sPhase) * sAmp * Math.sin(t * Math.PI);
    points.push(new THREE.Vector3().addScaledVector(leanDir, reach).addScaledVector(sDir, s).setY(y));
  }
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const lengthSegments = 32;
  const radialSegments = 12;
  const arcLength = curve.getLength();
  const frames = curve.computeFrenetFrames(lengthSegments, false);

  // Slim coconut trunk: 0.12 m at the base thinning to 0.075 m under the crown
  // for a 5 m palm, with a short root flare at the very bottom.
  const sizeK = Math.pow(height / 5, 0.35);
  const radiusAt = (t: number): number => {
    const taper = lerp(0.12, 0.075, t) * sizeK;
    const flare = 0.05 * Math.pow(1 - t, 12);
    return taper + flare;
  };

  const b = new MeshBuilder();
  const rings: Vert[][] = [];
  const barkColor: RGB = [1, 1, 1];
  const textureRepeatMetres = 0.6;
  for (let i = 0; i <= lengthSegments; i++) {
    const t = i / lengthSegments;
    const centre = curve.getPointAt(t);
    const tangent = frames.tangents[i];
    const normal = frames.normals[i];
    const binormal = frames.binormals[i];
    const dt = 1 / lengthSegments;
    const drds = (radiusAt(Math.min(1, t + dt)) - radiusAt(Math.max(0, t - dt))) / (2 * dt * arcLength);
    const ring: Vert[] = [];
    for (let j = 0; j <= radialSegments; j++) {
      const a = (j / radialSegments) * TWO_PI;
      const radial = new THREE.Vector3().addScaledVector(normal, Math.cos(a)).addScaledVector(binormal, Math.sin(a));
      const wobble = 1 + 0.035 * noise.noise2(t * 6, j * 0.7);
      const r = radiusAt(t) * wobble;
      const p = centre.clone().addScaledVector(radial, r);
      const n = radial.clone().addScaledVector(tangent, -drds).normalize();
      ring.push(vert(p, n, barkColor, j / radialSegments, (t * arcLength) / textureRepeatMetres, 0));
    }
    rings.push(ring);
  }
  for (let i = 0; i < lengthSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      b.quad(rings[i][j], rings[i][j + 1], rings[i + 1][j + 1], rings[i + 1][j]);
    }
  }
  // Caps. The top one sits under the crown; the bottom is a fan pointing down so
  // an uneven ground never shows a hollow tube.
  const top = curve.getPointAt(1);
  const topTangent = frames.tangents[lengthSegments].clone().normalize();
  const topCentre = vert(top, topTangent, barkColor, 0.5, 0.5, 0);
  const topRing = rings[lengthSegments];
  for (let j = 0; j < radialSegments; j++) {
    b.tri(topCentre, { ...topRing[j], n: topTangent }, { ...topRing[j + 1], n: topTangent });
  }
  const bottomTangent = frames.tangents[0].clone().normalize().negate();
  const bottomCentre = vert(curve.getPointAt(0), bottomTangent, barkColor, 0.5, 0.5, 0);
  const bottomRing = rings[0];
  for (let j = 0; j < radialSegments; j++) {
    b.tri(bottomCentre, { ...bottomRing[j + 1], n: bottomTangent }, { ...bottomRing[j], n: bottomTangent });
  }

  const geometry = b.build();
  // The trunk does not use vertex colours or sway; drop them so the lightmap
  // atlas packer and the BVH see a plain position/normal/uv mesh.
  geometry.deleteAttribute('color');
  geometry.deleteAttribute('sway');
  return { geometry, top, topTangent };
}

// ---------------------------------------------------------------------------
// Bark texture: 256x256 RGBA sRGB. Pale grey leaf-scar rings (one every 0.15 m)
// with a dark groove under each, on a light warm grey-brown.
// Returned with the map normalised to mean 1.0 and the true mean colour apart.
// ---------------------------------------------------------------------------

function linearToSrgb(x: number): number {
  const c = clamp01(x);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function buildBarkTexture(noise: ReturnType<typeof createNoise>): { texture: THREE.DataTexture; mean: RGB } {
  const size = 256;
  const linear = new Float32Array(size * size * 3);
  // Linear ≈ sRGB (0.55, 0.50, 0.42): a light, slightly warm grey.
  const base: RGB = [0.262, 0.214, 0.148];
  const ringsPerTile = 4;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      // Tileable in u: sample noise on a circle so the seam closes.
      const cu = Math.cos(u * TWO_PI);
      const su = Math.sin(u * TWO_PI);
      const warp = 0.045 * noise.noise3(cu * 1.5, su * 1.5, v * 4);
      const ringPhase = (v + warp) * ringsPerTile;
      const ringFrac = ringPhase - Math.floor(ringPhase);
      // Leaf scar: a broad pale band (the old leaf base) with a dark groove
      // just under it, then plain internode.
      const band = Math.pow(clamp01(1 - Math.abs(ringFrac - 0.3) / 0.22), 0.6);
      const groove = Math.pow(clamp01(1 - Math.abs(ringFrac - 0.06) / 0.07), 1.1);
      const mottle = noise.fbm3(cu * 3, su * 3, v * 9, 4) * 0.12;
      const fibre = noise.fbm3(cu * 16, su * 16, v * 2, 3) * 0.07;
      const scar = band * 0.38 - groove * 0.4;
      const k = 1 + mottle + fibre + scar;
      // Scar bands are greyer (less warm) than the internodes.
      const warmth = 1 + 0.08 * noise.noise3(cu * 2, su * 2, v * 3 + 7) - band * 0.1;
      const i = (y * size + x) * 3;
      linear[i] = base[0] * k * warmth;
      linear[i + 1] = base[1] * k;
      linear[i + 2] = base[2] * k * (2 - warmth);
    }
  }
  const mean: RGB = [0, 0, 0];
  for (let i = 0; i < linear.length; i += 3) {
    mean[0] += linear[i];
    mean[1] += linear[i + 1];
    mean[2] += linear[i + 2];
  }
  const texels = size * size;
  mean[0] /= texels;
  mean[1] /= texels;
  mean[2] /= texels;

  // Normalise so mean(clamp(map)) == 1 per channel: the shader's color * map then
  // averages to the true albedo, and the tracer's flat `material.color` agrees.
  const gain: RGB = [1 / mean[0], 1 / mean[1], 1 / mean[2]];
  for (let pass = 0; pass < 3; pass++) {
    for (let ch = 0; ch < 3; ch++) {
      let sum = 0;
      for (let i = ch; i < linear.length; i += 3) sum += Math.min(1, linear[i] * gain[ch]);
      gain[ch] *= texels / sum;
    }
  }
  const data = new Uint8Array(size * size * 4);
  for (let t = 0; t < texels; t++) {
    data[t * 4] = Math.round(linearToSrgb(linear[t * 3] * gain[0]) * 255);
    data[t * 4 + 1] = Math.round(linearToSrgb(linear[t * 3 + 1] * gain[1]) * 255);
    data[t * 4 + 2] = Math.round(linearToSrgb(linear[t * 3 + 2] * gain[2]) * 255);
    data[t * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return { texture, mean };
}

// ---------------------------------------------------------------------------
// Fronds
// ---------------------------------------------------------------------------

interface FrondParams {
  base: THREE.Vector3;
  azimuth: number;
  /** Launch elevation above horizontal, radians. */
  elevation: number;
  /** Elevation of the tip direction, radians; negative points below horizontal. */
  tipElevation: number;
  /** Rachis arc length, metres. */
  length: number;
  /** Leaflet V half-angle above the rachis plane, radians. */
  vAngle: number;
  /** Leaflet tip drop as a fraction of leaflet length. */
  leafletDroop: number;
  leafletPairs: number;
  /** Longest leaflet, metres (middle third of the frond). */
  leafletLength: number;
  /** Widest leaflet, metres. */
  leafletWidth: number;
  colorBase: RGB;
  colorTip: RGB;
  rachisColor: RGB;
  rachisRadius: number;
  rng: () => number;
}

interface ColorStat {
  sum: RGB;
  count: number;
}

interface PlanarCurve {
  point(s: number): THREE.Vector3;
  tangent(s: number): THREE.Vector3;
}

/**
 * Rachis: a cubic Bézier in the vertical plane through `horiz`, launched at
 * `e0` and ending pointing at `e3`, with a stiff petiole handle and a floppy tip
 * handle, then scaled so its arc length is exactly `length`.
 */
function rachisCurve(base: THREE.Vector3, horiz: THREE.Vector3, e0: number, e3: number, length: number): PlanarCurve {
  const theta = Math.max(0.08, e0 - e3);
  const chord = (2 / theta) * Math.sin(theta / 2);
  const mid = (e0 + e3) / 2;
  const dirAt = (e: number): THREE.Vector3 => horiz.clone().multiplyScalar(Math.cos(e)).addScaledVector(UP, Math.sin(e));
  const q0 = new THREE.Vector3();
  const q3 = dirAt(mid).multiplyScalar(chord);
  const q1 = dirAt(e0).multiplyScalar(0.42);
  const q2 = q3.clone().addScaledVector(dirAt(e3), -0.25);
  const evalUnit = (s: number): THREE.Vector3 => {
    const a = (1 - s) * (1 - s) * (1 - s);
    const b = 3 * (1 - s) * (1 - s) * s;
    const c = 3 * (1 - s) * s * s;
    const d = s * s * s;
    return new THREE.Vector3(
      a * q0.x + b * q1.x + c * q2.x + d * q3.x,
      a * q0.y + b * q1.y + c * q2.y + d * q3.y,
      a * q0.z + b * q1.z + c * q2.z + d * q3.z,
    );
  };
  let arc = 0;
  let prev = evalUnit(0);
  for (let i = 1; i <= 64; i++) {
    const p = evalUnit(i / 64);
    arc += p.distanceTo(prev);
    prev = p;
  }
  const scale = length / Math.max(1e-6, arc);
  return {
    point: (s) => evalUnit(s).multiplyScalar(scale).add(base),
    tangent: (s) => {
      const u = 1 - s;
      return new THREE.Vector3()
        .addScaledVector(new THREE.Vector3().subVectors(q1, q0), 3 * u * u)
        .addScaledVector(new THREE.Vector3().subVectors(q2, q1), 6 * u * s)
        .addScaledVector(new THREE.Vector3().subVectors(q3, q2), 3 * s * s)
        .normalize();
    },
  };
}

function buildFrond(params: FrondParams, stat: ColorStat): THREE.BufferGeometry {
  const { base, azimuth, elevation, tipElevation, length, rng } = params;
  const horiz = new THREE.Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
  const curve = rachisCurve(base, horiz, elevation, tipElevation, length);
  // The rachis is planar, so one fixed side vector gives a continuous frame:
  // `side` is normal to the frond plane, `upR(s)` the adaxial direction.
  const side = new THREE.Vector3().crossVectors(UP, horiz).normalize();
  if (new THREE.Vector3().crossVectors(side, curve.tangent(0.5)).y < 0) side.negate();
  const upAt = (t: THREE.Vector3): THREE.Vector3 => new THREE.Vector3().crossVectors(side, t).normalize();

  const b = new MeshBuilder();
  const addStat = (c: RGB, n: number): void => {
    stat.sum[0] += c[0] * n;
    stat.sum[1] += c[1] * n;
    stat.sum[2] += c[2] * n;
    stat.count += n;
  };

  // Rachis: 4-sided tapered tube.
  const rachisSegments = 16;
  const rachisRings: Vert[][] = [];
  for (let i = 0; i <= rachisSegments; i++) {
    const s = i / rachisSegments;
    const c = curve.point(s);
    const t = curve.tangent(s);
    const n2 = upAt(t);
    const r = lerp(params.rachisRadius, params.rachisRadius * 0.18, s);
    const col = mixRGB(params.rachisColor, params.colorBase, s * 0.5);
    const ring: Vert[] = [];
    for (let j = 0; j <= 4; j++) {
      const a = (j / 4) * TWO_PI + Math.PI / 4;
      const radial = new THREE.Vector3().addScaledVector(side, Math.cos(a)).addScaledVector(n2, Math.sin(a));
      ring.push(vert(c.clone().addScaledVector(radial, r), radial, col, j / 4, s, s));
    }
    rachisRings.push(ring);
  }
  for (let i = 0; i < rachisSegments; i++) {
    for (let j = 0; j < 4; j++) {
      b.quad(rachisRings[i][j], rachisRings[i][j + 1], rachisRings[i + 1][j + 1], rachisRings[i + 1][j]);
    }
  }
  addStat(params.rachisColor, rachisSegments * 8);

  // Leaflets in pairs along the rachis, after a bare petiole. Each leaflet is a
  // lanceolate strip of three segments, folded along its midrib (Λ section), that
  // leaves the rachis pointing forward in a V and droops toward its tip.
  const pairs = params.leafletPairs;
  const rowK = [0, 0.3, 0.68, 1];
  const rowW = [0.5, 1, 0.55, 0];
  const petiole = 0.13;
  for (let j = 0; j < pairs; j++) {
    const s = petiole + (1 - petiole) * clamp01((j + 0.5 + (rng() - 0.5) * 0.5) / pairs);
    const c = curve.point(s);
    const t = curve.tangent(s);
    const upR = upAt(t);
    // Length profile: shorter at the petiole, longest around the middle third,
    // tapering to the tip.
    const profile = s < 0.42 ? lerp(0.58, 1, (s - petiole) / (0.42 - petiole)) : lerp(1, 0.42, (s - 0.42) / 0.58);
    const len = params.leafletLength * profile * (0.92 + rng() * 0.16);
    const w = params.leafletWidth * (0.85 + rng() * 0.3) * lerp(1, 0.6, s);
    const droopL = params.leafletDroop * lerp(0.8, 1.25, s) + (rng() - 0.5) * 0.12;
    // Angle between the leaflet and the rachis: ~55° near the petiole, more
    // forward-swept toward the tip.
    const phi = lerp(0.95, 0.7, s) + (rng() - 0.5) * 0.15;
    const frondTipMix = Math.pow(s, 1.5);

    for (const sgn of [1, -1]) {
      const vAngle = lerp(params.vAngle, params.vAngle * 0.6, s) + (rng() - 0.5) * 0.22;
      const dir = new THREE.Vector3()
        .addScaledVector(side, sgn * Math.cos(vAngle) * Math.sin(phi))
        .addScaledVector(upR, Math.sin(vAngle) * Math.sin(phi))
        .addScaledVector(t, Math.cos(phi))
        .normalize();
      const twist0 = (rng() - 0.5) * 0.4;
      const twistK = (rng() - 0.5) * 0.6;
      const leafletVar = (rng() - 0.5) * 0.14;
      const rows: Vert[][] = [];
      for (let r = 0; r < rowK.length; r++) {
        const k = rowK[r];
        const p = c.clone().addScaledVector(dir, len * k).addScaledVector(UP, -droopL * len * k * k);
        const dirK = dir.clone().addScaledVector(UP, -2 * droopL * k).normalize();
        const wDir = new THREE.Vector3().crossVectors(dirK, upR).normalize();
        wDir.applyAxisAngle(dirK, twist0 + twistK * k);
        const nrm = new THREE.Vector3().crossVectors(wDir, dirK).normalize();
        const half = w * rowW[r] * 0.5;
        const fold = half * 0.45;
        const tipMix = clamp01(Math.pow(k, 1.2) * 0.8 + frondTipMix * 0.3);
        const col = scaleRGB(mixRGB(params.colorBase, params.colorTip, tipMix), 1 + leafletVar);
        const swayW = clamp01(s + 0.18 * k);
        if (half < 1e-4) {
          rows.push([vert(p, nrm, col, 0.5, k, swayW)]);
        } else {
          const nL = nrm.clone().multiplyScalar(half).addScaledVector(wDir, -fold).normalize();
          const nR = nrm.clone().multiplyScalar(half).addScaledVector(wDir, fold).normalize();
          rows.push([
            vert(p.clone().addScaledVector(wDir, -half), nL, col, 0, k, swayW),
            vert(p.clone().addScaledVector(nrm, fold), nrm, col, 0.5, k, swayW),
            vert(p.clone().addScaledVector(wDir, half), nR, col, 1, k, swayW),
          ]);
        }
        addStat(col, 3);
      }
      for (let r = 0; r < rows.length - 1; r++) {
        const a = rows[r];
        const d = rows[r + 1];
        if (d.length === 3) {
          b.quad(a[0], a[1], d[1], d[0]);
          b.quad(a[1], a[2], d[2], d[1]);
        } else {
          b.tri(a[0], a[1], d[0]);
          b.tri(a[1], a[2], d[0]);
        }
      }
    }
  }
  return b.build();
}

// ---------------------------------------------------------------------------
// Palm
// ---------------------------------------------------------------------------

function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  return index ? index.count / 3 : geometry.getAttribute('position').count / 3;
}

export function createPalm(options: PalmOptions): Palm {
  const seed = options.seed | 0;
  const height = THREE.MathUtils.clamp(options.height, 2, 8);
  const rng = seededRandom(seed * 7919 + 17);
  const noise = createNoise(seed * 131 + 5);
  const lean = options.lean ?? 0.1 + rng() * 0.25;
  const leanAz = rng() * TWO_PI;

  const group = new THREE.Group();
  group.name = 'palm';

  // Trunk ------------------------------------------------------------------
  const trunk = buildTrunk(height, lean, leanAz, rng, noise);
  const bark = buildBarkTexture(noise);
  const trunkMaterial = new THREE.MeshStandardNodeMaterial({
    map: bark.texture,
    roughness: 0.88,
    metalness: 0,
  });
  trunkMaterial.color.setRGB(bark.mean[0], bark.mean[1], bark.mean[2], THREE.LinearSRGBColorSpace);
  const trunkMesh = new THREE.Mesh(trunk.geometry, trunkMaterial);
  trunkMesh.name = 'palmTrunk';
  trunkMesh.castShadow = true;
  trunkMesh.receiveShadow = true;
  group.add(trunkMesh);

  // Crown ------------------------------------------------------------------
  const crownBase = trunk.top.clone().addScaledVector(trunk.topTangent, 0.1);
  const stat: ColorStat = { sum: [0, 0, 0], count: 0 };
  const frondGeometries: THREE.BufferGeometry[] = [];
  const frondCount = 11 + Math.floor(rng() * 4);
  const spikeCount = 2 + Math.floor(rng() * 2);
  const frondLength = THREE.MathUtils.clamp(height * (0.75 + rng() * 0.1), 2.4, 4.4);
  const leafletLength = THREE.MathUtils.clamp(frondLength * 0.25, 0.55, 0.95);
  const green: RGB = [0.16, 0.34, 0.07];
  const yellowGreen: RGB = [0.5, 0.62, 0.14];
  const azimuth0 = rng() * TWO_PI;
  for (let i = 0; i < frondCount; i++) {
    // Phyllotaxis: fronds spiral out by the golden angle. The youngest two or
    // three stand as a near-vertical spike in the centre; the rest fan out with
    // age, launching at 45°..10° and ending 35°..60° below horizontal.
    const azimuth = azimuth0 + i * GOLDEN_ANGLE + (rng() - 0.5) * 0.2;
    const spike = i < spikeCount;
    const age = spike ? 0 : (i - spikeCount) / Math.max(1, frondCount - 1 - spikeCount);
    const elevation = spike ? 1.35 - i * 0.13 + (rng() - 0.5) * 0.1 : lerp(0.78, 0.18, age) + (rng() - 0.5) * 0.14;
    const tipElevation = spike ? 0.85 - i * 0.28 : lerp(-0.62, -1.05, age) + (rng() - 0.5) * 0.12;
    const lengthMul = spike ? 0.58 + i * 0.07 : 0.92 + rng() * 0.14;
    const upperness = spike ? 1 : clamp01(1 - age * 1.1);
    const frondVar = 1 + (rng() - 0.5) * 0.14;
    // Younger fronds lean yellow-green, older ones sit darker green.
    const colorBase = scaleRGB(mixRGB(green, yellowGreen, 0.1 + upperness * 0.25), frondVar * lerp(0.82, 1, upperness));
    const colorTip = scaleRGB(mixRGB(green, yellowGreen, 0.75 + upperness * 0.25), frondVar);
    frondGeometries.push(
      buildFrond(
        {
          base: crownBase
            .clone()
            .addScaledVector(new THREE.Vector3(Math.cos(azimuth), 0, Math.sin(azimuth)), 0.06)
            .addScaledVector(UP, 0.12 * upperness - 0.06),
          azimuth,
          elevation,
          tipElevation,
          length: frondLength * lengthMul,
          vAngle: 0.72 + rng() * 0.24,
          leafletDroop: 0.3 + rng() * 0.15,
          leafletPairs: 22 + Math.floor(rng() * 9),
          leafletLength: leafletLength * (spike ? 0.8 : 1),
          leafletWidth: 0.062 + rng() * 0.022,
          colorBase,
          colorTip,
          rachisColor: scaleRGB([0.4, 0.36, 0.1], frondVar),
          rachisRadius: 0.034,
          rng,
        },
        stat,
      ),
    );
  }
  // The oldest fronds have died and hang brown-yellow straight down the trunk.
  const deadCount = 2 + Math.floor(rng() * 2);
  const deadBase: RGB = [0.34, 0.25, 0.08];
  const deadTip: RGB = [0.5, 0.4, 0.13];
  for (let i = 0; i < deadCount; i++) {
    const azimuth = azimuth0 + (i + 0.5) * (TWO_PI / deadCount) + (rng() - 0.5) * 0.6;
    frondGeometries.push(
      buildFrond(
        {
          base: crownBase.clone().addScaledVector(UP, -0.2).addScaledVector(new THREE.Vector3(Math.cos(azimuth), 0, Math.sin(azimuth)), 0.12),
          azimuth,
          elevation: -1.1 - rng() * 0.2,
          tipElevation: -1.5,
          length: frondLength * (0.8 + rng() * 0.12),
          vAngle: -0.25,
          leafletDroop: 0.5,
          leafletPairs: 22 + Math.floor(rng() * 5),
          leafletLength: leafletLength * 0.85,
          leafletWidth: 0.06,
          colorBase: deadBase,
          colorTip: deadTip,
          rachisColor: [0.36, 0.26, 0.09],
          rachisRadius: 0.028,
          rng,
        },
        stat,
      ),
    );
  }
  const leavesGeometry = BufferGeometryUtils.mergeGeometries(frondGeometries, false);
  if (!leavesGeometry) throw new Error('[palm] frond geometries failed to merge');
  for (const g of frondGeometries) g.dispose();
  leavesGeometry.computeBoundingBox();
  leavesGeometry.computeBoundingSphere();

  const windTime = uniform(0);
  const leavesMaterial = new THREE.MeshStandardNodeMaterial({
    roughness: 0.55,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  leavesMaterial.colorNode = vertexColor();
  leavesMaterial.emissiveNode = leafTranslucency(0.28);
  leavesMaterial.color.setRGB(stat.sum[0] / stat.count, stat.sum[1] / stat.count, stat.sum[2] / stat.count, THREE.LinearSRGBColorSpace);
  // Wind: a slow lateral sway growing toward the frond tips, phased by world x so
  // neighbouring palms do not move in lockstep. `positionWorld` reads the
  // undisplaced local position here (the assignment into `positionLocal` happens
  // after this expression is evaluated), which is what we want for a phase.
  {
    const swayWeight = attribute('sway', 'float');
    const phase = windTime.mul(1.3).add(positionWorld.x.mul(0.5)).add((seed % 97) * 0.37);
    const primary = sin(phase).mul(0.05).mul(swayWeight);
    const secondary = sin(phase.mul(0.63).add(1.7)).mul(0.03).mul(swayWeight);
    leavesMaterial.positionNode = positionLocal.add(vec3(primary, secondary.mul(0.5), secondary));
  }
  const leavesMesh = new THREE.Mesh(leavesGeometry, leavesMaterial);
  leavesMesh.name = 'palmLeaves';
  leavesMesh.castShadow = true;
  leavesMesh.receiveShadow = true;
  leavesMesh.userData.animatesVertices = true;
  leavesMesh.userData.lightmap = false;
  group.add(leavesMesh);

  // Coconuts ---------------------------------------------------------------
  const nutCount = 4 + Math.floor(rng() * 3);
  const nutGeometries: THREE.BufferGeometry[] = [];
  const nutAz0 = rng() * TWO_PI;
  let nutColorSum: RGB = [0, 0, 0];
  for (let i = 0; i < nutCount; i++) {
    const r = 0.09 + rng() * 0.03;
    const g = new THREE.SphereGeometry(r, 10, 7);
    g.scale(1, 1.18, 1);
    const az = nutAz0 + (i / nutCount) * TWO_PI + (rng() - 0.5) * 0.5;
    const dist = 0.14 + rng() * 0.12;
    g.translate(
      crownBase.x + Math.cos(az) * dist,
      crownBase.y - 0.22 - rng() * 0.08,
      crownBase.z + Math.sin(az) * dist,
    );
    const ripeness = rng();
    const col: RGB = mixRGB([0.3, 0.34, 0.1], [0.36, 0.26, 0.09], ripeness);
    const count = g.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let k = 0; k < count; k++) {
      colors[k * 3] = col[0];
      colors[k * 3 + 1] = col[1];
      colors[k * 3 + 2] = col[2];
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    nutColorSum = [nutColorSum[0] + col[0], nutColorSum[1] + col[1], nutColorSum[2] + col[2]];
    nutGeometries.push(g);
  }
  const nutsGeometry = BufferGeometryUtils.mergeGeometries(nutGeometries, false);
  if (!nutsGeometry) throw new Error('[palm] coconut geometries failed to merge');
  for (const g of nutGeometries) g.dispose();
  const nutsMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
  nutsMaterial.colorNode = vertexColor();
  nutsMaterial.color.setRGB(nutColorSum[0] / nutCount, nutColorSum[1] / nutCount, nutColorSum[2] / nutCount, THREE.LinearSRGBColorSpace);
  const nutsMesh = new THREE.Mesh(nutsGeometry, nutsMaterial);
  nutsMesh.name = 'palmCoconuts';
  nutsMesh.castShadow = true;
  nutsMesh.receiveShadow = true;
  group.add(nutsMesh);

  const triangles = triangleCount(trunk.geometry) + triangleCount(leavesGeometry) + triangleCount(nutsGeometry);
  console.log(
    `[palm] seed ${seed}: ${triangles} triangles (trunk ${triangleCount(trunk.geometry)}, leaves ${triangleCount(leavesGeometry)}, coconuts ${triangleCount(nutsGeometry)}), ${frondCount} fronds + ${deadCount} dead, frond ${frondLength.toFixed(2)} m`,
  );

  return {
    group,
    update(timeSec: number): void {
      windTime.value = timeSec;
    },
  };
}
