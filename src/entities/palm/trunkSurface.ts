/**
 * Coconut trunk surface, generated from the stem's anatomy.
 *
 * A palm is a monocot: it has no cambium and grows no bark. What the eye reads as
 * bark on Cocos nucifera is the outside of the stem itself, a sclerified cortex
 * that stays the same tissue for the life of the tree, marked by
 *
 *   - leaf scars: every frond leaves a broad crescent where its sheathing base
 *     was attached. The base wraps most of the stem, so the scars read as rings,
 *     but they are set on the 2/5 phyllotaxis spiral (144° divergence, left- or
 *     right-handed per tree) and tilt with it. The scar tissue shrinks a little
 *     below the surface with a raised abscission lip along its lower edge.
 *   - internodes: the distance between scars records the growth rate at that
 *     age. A seedling makes short crowded internodes (the swollen bole), a
 *     vigorous young adult stretches them to 10..15 cm, and an old or stressed
 *     crown shortens them again. About 12..14 fronds a year.
 *   - longitudinal fissures: the stem still widens slowly after the leaves have
 *     gone, and the rigid cortex cracks along the grain. Cracks are narrow, a
 *     few millimetres, and most numerous on the oldest tissue near the base.
 *   - weathering: fresh cortex is lignin-brown. Sunlight photodegrades the
 *     lignin to grey, and in a humid coastal climate the shaded side grows a
 *     film of algae and crustose lichen, lowest and thickest near the base.
 *   - the bole: adventitious root initials stud the lowest decimetres.
 *
 * Everything is produced from one height field so albedo, normal, roughness and
 * cavity agree with each other. Textures cover the whole trunk once (v = 0 at
 * the base, 1 under the crown) at a set metre scale, so nothing tiles.
 */
import * as THREE from 'three/webgpu';
import type { NoiseField } from '../../shared/lib/noise';

export interface TrunkSurfaceOptions {
  /** Trunk arc length, metres. */
  height: number;
  /** Mean trunk radius, metres; sets the metre size of a texel around the stem. */
  radius: number;
  /** Deterministic per tree. */
  rng: () => number;
  noise: NoiseField;
  /** Texture width around the stem; height follows the trunk length at ~5 mm/texel. */
  width?: number;
}

export interface TrunkSurface {
  /** sRGB albedo, real values (mean ≈ 0.2), nothing clipped. */
  albedo: THREE.DataTexture;
  /** Tangent-space normal, +u right, +v up the trunk. */
  normal: THREE.DataTexture;
  /** R = cavity occlusion (1 = open), G = roughness. Linear. */
  roughnessCavity: THREE.DataTexture;
  /** Mean linear albedo of the surface before the cavity term. */
  meanAlbedo: [number, number, number];
  /** Mean cavity; the raster shades `map · cavity`, a flat tracer `map · meanCavity`. */
  meanCavity: number;
  /** Scar positions along the trunk, 0..1, for anything that wants to line up with them. */
  scars: number[];
}

type RGB = [number, number, number];

const TWO_PI = Math.PI * 2;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const mix3 = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
function linearToSrgb(x: number): number {
  const c = clamp01(x);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Linear reflectances. Bark-like surfaces sit at 0.1..0.3; see the header. */
const CORTEX_FRESH: RGB = [0.165, 0.095, 0.048];
const CORTEX_WEATHERED: RGB = [0.215, 0.2, 0.175];
const SCAR_TISSUE: RGB = [0.26, 0.245, 0.215];
const ALGAE_FILM: RGB = [0.11, 0.15, 0.07];
const LICHEN_CRUST: RGB = [0.36, 0.38, 0.28];

interface Scar {
  /** Centre of the crescent's lower edge along the trunk, 0..1. */
  v: number;
  /** Internode above it, in v units. */
  internode: number;
  /** Azimuth (u) of the crescent's lowest point. */
  phase: number;
}

/** Internode length in metres at height fraction t: bole, vigorous middle, tired top. */
function internodeAt(t: number): number {
  const bole = lerp(0.03, 0.11, smoothstep(0, 0.28, t));
  const decline = lerp(1, 0.55, smoothstep(0.55, 1, t));
  return bole * decline;
}

function placeScars(height: number, rng: () => number): { scars: Scar[]; handed: number } {
  const scars: Scar[] = [];
  const handed = rng() < 0.5 ? 1 : -1;
  const divergence = (144 / 360) * handed;
  let phase = rng();
  let y = 0.02;
  while (y < height) {
    const internode = internodeAt(y / height) * (0.82 + rng() * 0.36);
    scars.push({ v: y / height, internode: internode / height, phase });
    y += internode;
    phase = (phase + divergence + (rng() - 0.5) * 0.03 + 1) % 1;
  }
  return { scars, handed };
}

interface Fissure {
  u: number;
  v0: number;
  v1: number;
  /** Half width and depth, metres. */
  halfWidth: number;
  depth: number;
  wander: number;
}

function placeFissures(height: number, rng: () => number): Fissure[] {
  const out: Fissure[] = [];
  const count = Math.round(height * 9);
  for (let i = 0; i < count; i++) {
    // More on the old tissue near the base.
    const v0 = Math.pow(rng(), 1.6) * 0.85;
    const length = (0.06 + Math.pow(rng(), 2) * 0.35) / height;
    out.push({
      u: rng(),
      v0,
      v1: Math.min(0.97, v0 + length),
      halfWidth: 0.0008 + rng() * 0.0012,
      depth: 0.0012 + rng() * 0.0016,
      wander: rng() * 10,
    });
  }
  return out;
}

export function buildTrunkSurface(options: TrunkSurfaceOptions): TrunkSurface {
  const { height, radius, rng, noise } = options;
  const W = options.width ?? 256;
  const H = Math.max(256, Math.min(2048, Math.round(height / 0.005 / 64) * 64));
  const texelU = (TWO_PI * radius) / W;
  const texelV = height / H;

  const { scars, handed } = placeScars(height, rng);
  const fissures = placeFissures(height, rng);
  // Shade side: where the algae and lichen sit; one azimuth per tree.
  const shadeAzimuth = rng();
  const lichenSeed = rng() * 100;

  const heightField = new Float32Array(W * H);
  const scarMask = new Float32Array(W * H);
  const crackMask = new Float32Array(W * H);
  const lipMask = new Float32Array(W * H);

  // Scars are sorted by v; only a few can touch a row.
  let scarLo = 0;
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    while (scarLo < scars.length - 1 && scars[scarLo + 1].v + scars[scarLo + 1].internode * 0.6 < v - 0.03) scarLo++;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const cu = Math.cos(u * TWO_PI);
      const su = Math.sin(u * TWO_PI);
      const i = y * W + x;

      // Cortex grain: fibres run along the stem, so the noise is stretched in v.
      const grain = noise.fbm3(cu * 9, su * 9, v * height * 1.6, 3) * 0.00035;
      // Slow bulges, the stem is never a true cylinder.
      const macro = noise.fbm3(cu * 1.3, su * 1.3, v * height * 0.5, 2) * 0.0025;
      let h = grain + macro;
      let scar = 0;
      let lip = 0;

      for (let s = scarLo; s < scars.length; s++) {
        const sc = scars[s];
        if (sc.v - sc.internode * 0.5 > v + 0.03) break;
        // Crescent lower edge: lowest at `phase`, rising on both sides, tilted
        // with the spiral. Height of the scar band ≈ 0.4 of the internode.
        const tilt = 0.32 * sc.internode * (1 - Math.cos((u - sc.phase) * TWO_PI));
        const edgeV = sc.v + tilt;
        const bandV = sc.internode * (0.36 + 0.08 * Math.cos((u - sc.phase - 0.5 * handed) * TWO_PI));
        const dv = (v - edgeV) * height; // metres above the lower edge
        const bandM = bandV * height;
        // Lip: the abscission ridge along the lower edge, ~8 mm.
        const lipK = smoothstep(-0.006, 0, dv) * (1 - smoothstep(0.003, 0.011, dv));
        // Plateau: the scar face itself, sunken and with a soft upper margin.
        const plateau = smoothstep(0.004, 0.012, dv) * (1 - smoothstep(bandM - 0.012, bandM, dv));
        h += lipK * 0.0022 - plateau * 0.0016;
        scar = Math.max(scar, plateau);
        lip = Math.max(lip, lipK);
      }

      // Longitudinal fissures.
      let crack = 0;
      for (const f of fissures) {
        if (v < f.v0 || v > f.v1) continue;
        const along = (v - f.v0) / (f.v1 - f.v0);
        const ends = smoothstep(0, 0.12, along) * (1 - smoothstep(0.88, 1, along));
        const wander = noise.noise2(f.wander, v * height * 3) * 0.006;
        let du = u - f.u + wander / (TWO_PI * radius);
        du -= Math.round(du);
        const dist = Math.abs(du) * TWO_PI * radius;
        const k = (1 - smoothstep(f.halfWidth * 0.5, f.halfWidth * 1.6, dist)) * ends;
        if (k > crack) crack = k;
        h -= k * f.depth;
      }

      // Bole: root initials in the lowest decimetres.
      if (v * height < 0.35) {
        const cell = noise.noise3(cu * 14, su * 14, v * height * 40);
        const bump = smoothstep(0.45, 0.85, cell) * (1 - smoothstep(0.15, 0.35, v * height));
        h += bump * 0.0025;
      }

      heightField[i] = h;
      scarMask[i] = scar;
      crackMask[i] = crack;
      lipMask[i] = lip;
    }
  }

  // Cavity: how far a texel sits below its 9x9 neighbourhood, at the scale of
  // the cracks and scar margins (up to ~2.5 mm).
  const cavity = new Float32Array(W * H);
  const blur = new Float32Array(W * H);
  const R = 4;
  const rowSum = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let k = -R; k <= R; k++) s += heightField[y * W + ((x + k + W) % W)];
      rowSum[y * W + x] = s / (2 * R + 1);
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let k = -R; k <= R; k++) {
        const yy = Math.min(H - 1, Math.max(0, y + k));
        s += rowSum[yy * W + x];
      }
      blur[y * W + x] = s / (2 * R + 1);
    }
  }
  let cavitySum = 0;
  for (let i = 0; i < W * H; i++) {
    const below = Math.max(0, blur[i] - heightField[i]);
    cavity[i] = 1 - 0.75 * clamp01(below / 0.0022);
    cavitySum += cavity[i];
  }
  const meanCavity = cavitySum / (W * H);

  // Materials per texel.
  const albedoLinear = new Float32Array(W * H * 3);
  const rough = new Float32Array(W * H);
  const mean: RGB = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const cu = Math.cos(u * TWO_PI);
      const su = Math.sin(u * TWO_PI);
      const i = y * W + x;

      // Weathering: fresh cortex under the crown, grey below, blotchy in between.
      const age = 1 - smoothstep(0.7, 1, v);
      const blotch = noise.fbm3(cu * 2.2, su * 2.2, v * height * 0.9 + 3, 3) * 0.5 + 0.5;
      const weathered = clamp01(age * (0.55 + 0.6 * blotch));
      let c: RGB = mix3(CORTEX_FRESH, CORTEX_WEATHERED, weathered);
      // Scar faces are cut sclerenchyma: paler and greyer.
      c = mix3(c, SCAR_TISSUE, scarMask[i] * 0.85);
      // A crack exposes fresh cortex.
      c = mix3(c, CORTEX_FRESH, crackMask[i] * 0.8);
      // Shade side, low on the trunk: algae film then lichen crust on top of it.
      const shade = 0.5 + 0.5 * Math.cos((u - shadeAzimuth) * TWO_PI);
      const low = 1 - smoothstep(0.25, 0.8, v);
      const algae = smoothstep(0.35, 0.8, noise.fbm3(cu * 3, su * 3, v * height * 1.2 + 11, 3) * 0.5 + 0.5) * shade * low * 0.55;
      c = mix3(c, ALGAE_FILM, algae);
      const lichenField = noise.fbm3(cu * 4.5, su * 4.5, v * height * 2.5 + lichenSeed, 4) * 0.5 + 0.5;
      const lichen = smoothstep(0.58, 0.68, lichenField) * (0.35 + 0.65 * shade) * (1 - smoothstep(0.35, 0.9, v)) * (1 - crackMask[i]);
      c = mix3(c, LICHEN_CRUST, lichen);
      // Fibre-scale tone variation.
      const fibre = 1 + 0.1 * noise.fbm3(cu * 14, su * 14, v * height * 2.2, 3);
      c = [c[0] * fibre, c[1] * fibre, c[2] * fibre];

      albedoLinear[i * 3] = c[0];
      albedoLinear[i * 3 + 1] = c[1];
      albedoLinear[i * 3 + 2] = c[2];
      mean[0] += c[0];
      mean[1] += c[1];
      mean[2] += c[2];

      // Roughness: weathered cortex is matte; scar faces and fresh crack walls a
      // little smoother; lichen crust the roughest of all.
      let r = lerp(0.8, 0.92, weathered);
      r = lerp(r, 0.8, scarMask[i] * 0.7);
      r = lerp(r, 0.76, crackMask[i] * 0.6);
      r = lerp(r, 0.97, lichen);
      r += 0.03 * noise.noise3(cu * 20, su * 20, v * height * 4);
      rough[i] = clamp01(r);
    }
  }
  const texels = W * H;
  mean[0] /= texels;
  mean[1] /= texels;
  mean[2] /= texels;

  // The albedo texture holds the real linear albedo (encoded sRGB, all ≤ 1). An
  // earlier "normalise to mean 1" gain (≈ ×5) clipped 86 % of the texels to white
  // and erased the scars, lichen and weathering from the raster.
  const gain: RGB = [1, 1, 1];
  const albedoData = new Uint8Array(texels * 4);
  for (let i = 0; i < texels; i++) {
    albedoData[i * 4] = Math.round(linearToSrgb(albedoLinear[i * 3] * gain[0]) * 255);
    albedoData[i * 4 + 1] = Math.round(linearToSrgb(albedoLinear[i * 3 + 1] * gain[1]) * 255);
    albedoData[i * 4 + 2] = Math.round(linearToSrgb(albedoLinear[i * 3 + 2] * gain[2]) * 255);
    albedoData[i * 4 + 3] = 255;
  }

  // Tangent-space normal from the height field (metres), +u right, +v up.
  const normalData = new Uint8Array(texels * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const hl = heightField[y * W + ((x - 1 + W) % W)];
      const hr = heightField[y * W + ((x + 1) % W)];
      const hd = heightField[Math.max(0, y - 1) * W + x];
      const hu = heightField[Math.min(H - 1, y + 1) * W + x];
      const dx = (hr - hl) / (2 * texelU);
      const dy = (hu - hd) / (2 * texelV);
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      normalData[i * 4] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      normalData[i * 4 + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      normalData[i * 4 + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      normalData[i * 4 + 3] = 255;
    }
  }

  const rcData = new Uint8Array(texels * 4);
  for (let i = 0; i < texels; i++) {
    rcData[i * 4] = Math.round(cavity[i] * 255);
    rcData[i * 4 + 1] = Math.round(rough[i] * 255);
    rcData[i * 4 + 2] = 0;
    rcData[i * 4 + 3] = 255;
  }

  const makeTexture = (data: Uint8Array, srgb: boolean): THREE.DataTexture => {
    const texture = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    return texture;
  };

  return {
    albedo: makeTexture(albedoData, true),
    normal: makeTexture(normalData, false),
    roughnessCavity: makeTexture(rcData, false),
    meanAlbedo: mean,
    meanCavity,
    scars: scars.map((s) => s.v),
  };
}
