/**
 * Leaf surface relief and gloss, from the anatomy of the lamina.
 *
 * The blade of a leaf is a thin sheet stiffened by its vascular bundles. On the
 * adaxial (upper) face the veins are impressed — the lamina bulges up between
 * them — and on the abaxial face the same veins stand proud. The upper epidermis
 * carries a thick cuticle with epicuticular wax, which is why sun leaves are
 * glossy from above and matte from below.
 *
 *   - `parallel`: a monocot leaflet (Cocos, palmettos). One midrib with fine
 *     parallel veins running the length of the blade, a few tenths of a
 *     millimetre apart — at texture scale a longitudinal striation.
 *   - `pinnate`: a dicot broadleaf. A midrib tapering to the tip, alternate
 *     secondaries leaving it at ~55° and curving toward the apex, a reticulate
 *     tertiary net, and quilted lamina between the secondaries.
 *
 * The map is authored in leaf space: u across the blade (0..1, midrib at 0.5),
 * v along it (0 petiole .. 1 apex), at the metre size given, so the slopes are
 * physical. The normal map represents the adaxial face; the renderer's face
 * flip inverts it for the abaxial view, which is right for a thin sheet.
 */
import * as THREE from 'three/webgpu';
import type { NoiseField } from '../../shared/lib/noise';

export type Venation = 'parallel' | 'pinnate';

export interface LeafSurfaceOptions {
  venation: Venation;
  /** Blade width and length in metres, for the physical slope. */
  width: number;
  length: number;
  noise: NoiseField;
  width_px?: number;
  length_px?: number;
}

export interface LeafSurface {
  /** Tangent-space normal of the adaxial face, +u right, +v toward the apex. */
  normal: THREE.DataTexture;
  /** R = adaxial (waxy) roughness, G = abaxial roughness, B = vein mask. Linear. */
  roughness: THREE.DataTexture;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Gloss of the cuticle: sun-leaf wax ≈ 0.25..0.35 on the adaxial face. The abaxial
 * epidermis carries the stomata and little wax: matte, ≈ 0.7. Lower than that and a
 * crown seen from below mirrors the blue sky over its dark undersides.
 */
const ROUGH_ADAXIAL = 0.3;
const ROUGH_ABAXIAL = 0.7;

export function buildLeafSurface(options: LeafSurfaceOptions): LeafSurface {
  const { venation, width, length, noise } = options;
  const W = options.width_px ?? (venation === 'pinnate' ? 256 : 128);
  const H = options.length_px ?? 512;
  const texelU = width / W;
  const texelV = length / H;

  const height = new Float32Array(W * H);
  const veinMask = new Float32Array(W * H);

  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const i = y * W + x;
      const du = u - 0.5; // -0.5..0.5 across the blade
      const across = Math.abs(du) * width; // metres from the midrib
      let h = 0;
      let vein = 0;

      if (venation === 'parallel') {
        // Midrib: a groove ~1.2 mm wide near the base narrowing to the tip.
        const midW = lerp(0.0012, 0.0005, v);
        const mid = 1 - smoothstep(midW * 0.4, midW, across);
        h -= mid * lerp(0.0007, 0.00025, v);
        vein = mid;
        // Parallel veins: ~0.6 mm apart, wandering a little, each a shallow groove.
        const spacing = 0.0006;
        const wander = noise.noise2(du * 40, v * 6) * 0.00012;
        const phase = ((across + wander) / spacing) % 1;
        const veinK = 1 - smoothstep(0.12, 0.3, Math.min(phase, 1 - phase));
        const veinDepth = 0.00012 * (1 - mid);
        h -= veinK * veinDepth;
        vein = Math.max(vein, veinK * 0.3);
        // Lamina between veins is very slightly convex.
        h += 0.00005 * Math.cos(phase * Math.PI * 2) * (1 - mid);
      } else {
        // Midrib groove: 2.5 mm wide at the petiole → 0.6 mm at the apex.
        const midW = lerp(0.0025, 0.0006, v);
        const mid = 1 - smoothstep(midW * 0.35, midW, across);
        h -= mid * lerp(0.0011, 0.0004, v);
        vein = mid;
        // Secondaries: alternate, every 8% of the length, leaving at ~55° and
        // curving toward the apex. Distance measured across the vein's direction.
        const pitch = 0.08;
        const side = du < 0 ? 0 : 1;
        const offset = side * pitch * 0.5;
        const slope = 0.7; // dv per unit of |du| (≈55° from the midrib in leaf space)
        const curve = 0.9; // bends toward the apex
        const vv = v - Math.abs(du) * slope - Math.abs(du) * Math.abs(du) * curve - offset;
        const k = Math.round(vv / pitch);
        const vk = k * pitch;
        const dv = (vv - vk) * length; // metres, roughly perpendicular scaled
        const dist = Math.abs(dv) * 0.7;
        const along = Math.abs(du) * 2; // 0 at the midrib .. 1 at the margin
        const secW = lerp(0.0008, 0.0003, along);
        const alive = vk > 0.02 && vk < 0.98 ? 1 : 0;
        const sec = (1 - smoothstep(secW * 0.4, secW, dist)) * alive * (1 - smoothstep(0.85, 1, along));
        h -= sec * lerp(0.0006, 0.0002, along) * (1 - mid);
        vein = Math.max(vein, sec * 0.5);
        // Quilting: the lamina bulges up between secondaries.
        const frac = (vv - vk) / pitch + 0.5;
        const bulge = Math.sin(Math.PI * clamp01(frac));
        h += 0.00045 * bulge * bulge * (1 - smoothstep(0.7, 1, along)) * (1 - mid) * alive;
        // Tertiary reticulum: ridged noise, fine and shallow.
        const ridge = 1 - Math.abs(noise.noise2(u * 60, v * 180));
        const tert = smoothstep(0.82, 0.98, ridge);
        h -= tert * 0.0001 * (1 - sec) * (1 - mid);
        vein = Math.max(vein, tert * 0.12);
      }

      // Epidermal micro-undulation.
      h += noise.fbm2(u * 90, v * 300, 3) * 0.00002;
      height[i] = h;
      veinMask[i] = vein;
    }
  }

  const texels = W * H;
  const normalData = new Uint8Array(texels * 4);
  const roughData = new Uint8Array(texels * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const hl = height[y * W + Math.max(0, x - 1)];
      const hr = height[y * W + Math.min(W - 1, x + 1)];
      const hd = height[Math.max(0, y - 1) * W + x];
      const hu = height[Math.min(H - 1, y + 1) * W + x];
      const dx = (hr - hl) / (2 * texelU);
      const dy = (hu - hd) / (2 * texelV);
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      normalData[i * 4] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      normalData[i * 4 + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      normalData[i * 4 + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      normalData[i * 4 + 3] = 255;

      // Veins carry less wax and are rougher; the cuticle varies a little.
      const u = (x + 0.5) / W;
      const v = (y + 0.5) / H;
      const jitter = noise.fbm2(u * 30 + 7, v * 90, 2) * 0.05;
      const ad = clamp01(ROUGH_ADAXIAL + veinMask[i] * 0.18 + jitter);
      const ab = clamp01(ROUGH_ABAXIAL + veinMask[i] * 0.1 + jitter);
      roughData[i * 4] = Math.round(ad * 255);
      roughData[i * 4 + 1] = Math.round(ab * 255);
      // B: vein mask, for the albedo (veins carry no chloroplasts).
      roughData[i * 4 + 2] = Math.round(clamp01(veinMask[i]) * 255);
      roughData[i * 4 + 3] = 255;
    }
  }

  const makeTexture = (data: Uint8Array): THREE.DataTexture => {
    const texture = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    return texture;
  };
  return { normal: makeTexture(normalData), roughness: makeTexture(roughData) };
}
