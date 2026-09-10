/**
 * Leaf optics from leaf biochemistry.
 *
 * A leaf is a stack of mesophyll cell layers bounded by a waxy cuticle. Light
 * entering it is partly reflected at each air/cell-wall interface (refractive
 * index ≈ 1.4) and absorbed on its way through by the pigments dissolved in the
 * chloroplasts: chlorophyll a+b (strong in the blue and the red, weak in the
 * green — which is why leaves are green), carotenoids (blue only, so a leaf low in
 * chlorophyll turns yellow), and brown pigments (oxidised phenolics in senescent
 * and dead tissue, absorbing across the visible, strongest in the blue).
 *
 * This is the PROSPECT plate model (Jacquemoud & Baret 1990; Féret et al. 2008):
 * an N-layer generalisation of Allen's plate model, with the diffuse
 * transmittance of one elementary layer from Beer's law integrated over the
 * hemisphere, and Fresnel interfaces averaged over the incidence cone. It yields
 * a directional-hemispherical reflectance and transmittance spectrum per leaf,
 * which is then integrated under D65 with the CIE 1931 observer into linear
 * sRGB: the reflectance is the leaf's diffuse albedo, the transmittance is the
 * colour of light coming through it.
 *
 * The specific absorption spectra below are 10 nm tabulations of the shape of
 * the PROSPECT-5 coefficients over 400..700 nm. They are the biology; the plate
 * arithmetic is exact for the model.
 */

export interface LeafBiochemistry {
  /** Leaf structure parameter: number of elementary layers (1.0 thin monocot .. 3.0 thick). */
  N: number;
  /** Chlorophyll a+b content, µg/cm². Young pale frond ~15, mature ~40..60, dead ~0. */
  Cab: number;
  /** Carotenoid content, µg/cm². Typically Cab / 5 in green leaves; persists into senescence. */
  Car: number;
  /** Brown pigment content, arbitrary PROSPECT units, 0 for a living leaf, 0.5..1.5 dead. */
  Cbrown: number;
}

export interface LeafOptics {
  /** Linear-sRGB diffuse albedo: hemispherical reflectance minus the cuticle's Fresnel term. */
  reflectance: [number, number, number];
  /** Linear-sRGB directional-hemispherical transmittance. */
  transmittance: [number, number, number];
  /** Photometric (luminance) reflectance and transmittance under D65. */
  luminanceR: number;
  luminanceT: number;
  /** Cuticle refractive index at 550 nm; gives the specular F0. */
  ior: number;
}

const WAVELENGTHS: number[] = [];
for (let l = 400; l <= 700; l += 10) WAVELENGTHS.push(l);

/** Chlorophyll a+b specific absorption, cm²/µg (PROSPECT-5 shape). */
const K_CHLOROPHYLL = [
  0.066, 0.075, 0.083, 0.086, 0.081, 0.068, 0.052, 0.036, 0.024, 0.015, 0.011,
  0.0098, 0.0082, 0.0072, 0.0067, 0.0066, 0.0072, 0.0086, 0.0105, 0.014, 0.019,
  0.026, 0.035, 0.046, 0.054, 0.052, 0.042, 0.028, 0.016, 0.0085, 0.0045,
];
/** Carotenoid specific absorption, cm²/µg. Blue band only. */
const K_CAROTENOID = [
  0.045, 0.062, 0.084, 0.105, 0.121, 0.128, 0.126, 0.112, 0.088, 0.058, 0.032,
  0.015, 0.006, 0.002, 0.0006, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];
/** Brown pigment specific absorption per unit Cbrown; broad, decaying to the red. */
const K_BROWN = [
  0.72, 0.68, 0.64, 0.60, 0.565, 0.53, 0.495, 0.462, 0.43, 0.40, 0.372,
  0.346, 0.322, 0.30, 0.28, 0.261, 0.244, 0.228, 0.213, 0.20, 0.188,
  0.177, 0.167, 0.158, 0.15, 0.143, 0.137, 0.131, 0.126, 0.121, 0.117,
];

/** CIE D65 relative spectral power, 400..700 nm by 10 nm. */
const D65 = [
  82.75, 91.49, 93.43, 86.68, 104.86, 117.01, 117.81, 114.86, 115.92, 108.81, 109.35,
  107.80, 104.79, 107.69, 104.41, 104.05, 100.00, 96.33, 95.79, 88.69, 90.01,
  89.60, 87.70, 83.29, 83.70, 80.03, 80.21, 82.28, 78.28, 69.72, 71.61,
];

/** Piecewise-Gaussian fit of the CIE 1931 2° observer (Wyman, Sloan & Shirley 2013). */
function gauss(l: number, mu: number, s1: number, s2: number): number {
  const t = (l - mu) / (l < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}
function cieX(l: number): number {
  return 1.056 * gauss(l, 599.8, 37.9, 31.0) + 0.362 * gauss(l, 442.0, 16.0, 26.7) - 0.065 * gauss(l, 501.1, 20.4, 26.2);
}
function cieY(l: number): number {
  return 0.821 * gauss(l, 568.8, 46.9, 40.5) + 0.286 * gauss(l, 530.9, 16.3, 31.1);
}
function cieZ(l: number): number {
  return 1.217 * gauss(l, 437.0, 11.8, 36.0) + 0.681 * gauss(l, 459.0, 26.0, 13.8);
}

/** Refractive index of the leaf material (cell wall / cuticle), PROSPECT range 1.44 → 1.40. */
function refractiveIndex(l: number): number {
  return 1.44 - 0.04 * ((l - 400) / 300);
}

/** Unpolarised Fresnel reflectance of an air → dielectric interface. */
function fresnel(cosI: number, n: number): number {
  const sinT2 = (1 - cosI * cosI) / (n * n);
  if (sinT2 >= 1) return 1;
  const cosT = Math.sqrt(1 - sinT2);
  const rs = (cosI - n * cosT) / (cosI + n * cosT);
  const rp = (n * cosI - cosT) / (n * cosI + cosT);
  return 0.5 * (rs * rs + rp * rp);
}

/**
 * Transmissivity of the interface averaged over a cone of incidence of half-angle
 * `alphaDeg`, weighted by projected solid angle. `tav(90°)` is the hemispherical
 * value used between internal layers; PROSPECT uses 40° for the first surface,
 * standing for the directional illumination of a leaf held at the measurement port.
 */
function tav(alphaDeg: number, n: number): number {
  const alpha = (alphaDeg * Math.PI) / 180;
  const steps = 256;
  let num = 0;
  let den = 0;
  for (let i = 0; i < steps; i++) {
    const th = ((i + 0.5) / steps) * alpha;
    const w = Math.sin(th) * Math.cos(th);
    num += (1 - fresnel(Math.cos(th), n)) * w;
    den += w;
  }
  return num / den;
}

/** Exponential integral E1(x), x > 0: series below 1, continued fraction (Lentz) above. */
function expint1(x: number): number {
  if (x <= 1) {
    const euler = 0.5772156649015329;
    let sum = 0;
    let term = 1;
    for (let k = 1; k < 60; k++) {
      term *= -x / k;
      sum += -term / k;
      if (Math.abs(term) < 1e-16) break;
    }
    return -euler - Math.log(x) + sum;
  }
  const tiny = 1e-300;
  let b = x + 1;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 200; i++) {
    const an = -i * i;
    b += 2;
    d = 1 / (an * d + b);
    c = b + an / c;
    const del = c * d;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h * Math.exp(-x);
}

/**
 * Diffuse transmittance of one elementary layer of absorption coefficient k:
 * Beer's law integrated over an isotropic incident flux.
 */
function layerTransmittance(k: number): number {
  if (k <= 1e-9) return 1;
  return (1 - k) * Math.exp(-k) + k * k * expint1(k);
}

/**
 * PROSPECT: reflectance and transmittance of the whole leaf at one wavelength.
 * `alphaDeg` is the incidence cone of the illumination on the upper surface.
 */
const tavCache = new Map<string, number>();
function tavCached(alphaDeg: number, n: number): number {
  const key = `${alphaDeg}|${n}`;
  let v = tavCache.get(key);
  if (v === undefined) {
    v = tav(alphaDeg, n);
    tavCache.set(key, v);
  }
  return v;
}

function plateModel(k: number, n: number, N: number, alphaDeg: number): [number, number] {
  const tau = layerTransmittance(k);
  const talf = tavCached(alphaDeg, n);
  const ralf = 1 - talf;
  const t12 = tavCached(90, n);
  const r12 = 1 - t12;
  const t21 = t12 / (n * n);
  const r21 = 1 - t21;

  // Top layer: lit through the cone, exits through the hemisphere.
  const denom = 1 - r21 * r21 * tau * tau;
  const Ta = (talf * tau * t21) / denom;
  const Ra = ralf + (r21 * tau * Ta);
  // Interior layers: diffuse both ways.
  const t = (t12 * tau * t21) / denom;
  const r = r12 + r21 * tau * t;

  // Stokes' solution for the N-1 identical layers below the first.
  let Rsub: number;
  let Tsub: number;
  if (r + t >= 1) {
    Tsub = t / (t + (1 - t) * (N - 1));
    Rsub = 1 - Tsub;
  } else {
    const D = Math.sqrt((1 + r + t) * (1 + r - t) * (1 - r + t) * (1 - r - t));
    const rq = r * r;
    const tq = t * t;
    const a = (1 + rq - tq + D) / (2 * r);
    const b = (1 - rq + tq + D) / (2 * t);
    const bNm1 = Math.pow(b, N - 1);
    const bN2 = bNm1 * bNm1;
    const a2 = a * a;
    const den2 = a2 * bN2 - 1;
    Rsub = (a * (bN2 - 1)) / den2;
    Tsub = (bNm1 * (a2 - 1)) / den2;
  }
  const den3 = 1 - Rsub * r;
  const T = (Ta * Tsub) / den3;
  const R = Ra + (Ta * Rsub * t) / den3;
  return [R, T];
}

/** Reflectance and transmittance spectra, 400..700 nm by 10 nm. */
export function leafSpectra(leaf: LeafBiochemistry, alphaDeg = 40): { R: number[]; T: number[]; surface: number[] } {
  const R: number[] = [];
  const T: number[] = [];
  const surface: number[] = [];
  const N = Math.max(1, leaf.N);
  for (let i = 0; i < WAVELENGTHS.length; i++) {
    const n = refractiveIndex(WAVELENGTHS[i]);
    const k = (leaf.Cab * K_CHLOROPHYLL[i] + leaf.Car * K_CAROTENOID[i] + leaf.Cbrown * K_BROWN[i]) / N;
    const [r, t] = plateModel(k, n, N, alphaDeg);
    R.push(r);
    T.push(t);
    // The first-surface Fresnel term inside R: the renderer's GGX lobe (F0 from the
    // same n) already provides it, so the diffuse albedo must leave it out.
    surface.push(1 - tavCached(alphaDeg, n));
  }
  return { R, T, surface };
}

/** Integrate a spectrum under D65 with the CIE 1931 observer into linear sRGB, Y of white = 1. */
export function spectrumToLinearSrgb(spectrum: number[]): { rgb: [number, number, number]; Y: number } {
  let X = 0;
  let Y = 0;
  let Z = 0;
  let Yw = 0;
  for (let i = 0; i < WAVELENGTHS.length; i++) {
    const l = WAVELENGTHS[i];
    const e = D65[i];
    X += spectrum[i] * e * cieX(l);
    Y += spectrum[i] * e * cieY(l);
    Z += spectrum[i] * e * cieZ(l);
    Yw += e * cieY(l);
  }
  X /= Yw;
  Y /= Yw;
  Z /= Yw;
  // XYZ (D65) → linear sRGB.
  const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const b = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  return { rgb: [Math.max(0, r), Math.max(0, g), Math.max(0, b)], Y };
}

export function leafOptics(leaf: LeafBiochemistry): LeafOptics {
  const { R, T, surface } = leafSpectra(leaf);
  const r = spectrumToLinearSrgb(R.map((x, i) => Math.max(0, x - surface[i])));
  const t = spectrumToLinearSrgb(T);
  return {
    reflectance: r.rgb,
    transmittance: t.rgb,
    luminanceR: r.Y,
    luminanceT: t.Y,
    ior: refractiveIndex(550),
  };
}

/** Linear interpolation between two biochemistries (age ramps along a frond). */
export function mixBiochemistry(a: LeafBiochemistry, b: LeafBiochemistry, t: number): LeafBiochemistry {
  const k = Math.min(1, Math.max(0, t));
  return {
    N: a.N + (b.N - a.N) * k,
    Cab: a.Cab + (b.Cab - a.Cab) * k,
    Car: a.Car + (b.Car - a.Car) * k,
    Cbrown: a.Cbrown + (b.Cbrown - a.Cbrown) * k,
  };
}

export type RGB = [number, number, number];

/**
 * Optics sampled along a leaf from its base (index 0) to its tip: the tissue at
 * the tip of a frond is younger than at the base, so the biochemistry ramps.
 */
export interface LeafRamp {
  R: RGB[];
  T: RGB[];
  /** Mean over the ramp, for `material.color` and the tracer's pass-through chance. */
  meanR: RGB;
  meanTLuminance: number;
}

export function buildLeafRamp(base: LeafBiochemistry, tip: LeafBiochemistry, steps = 12): LeafRamp {
  const R: RGB[] = [];
  const T: RGB[] = [];
  const meanR: RGB = [0, 0, 0];
  let meanT = 0;
  for (let i = 0; i < steps; i++) {
    const o = leafOptics(mixBiochemistry(base, tip, i / (steps - 1)));
    R.push(o.reflectance);
    T.push(o.transmittance);
    meanR[0] += o.reflectance[0] / steps;
    meanR[1] += o.reflectance[1] / steps;
    meanR[2] += o.reflectance[2] / steps;
    meanT += o.luminanceT / steps;
  }
  return { R, T, meanR, meanTLuminance: meanT };
}

/** Linear interpolation along the ramp; `k` is 0 at the base, 1 at the tip. */
export function sampleLeafRamp(ramp: LeafRamp, k: number): { R: RGB; T: RGB } {
  const x = Math.min(1, Math.max(0, k)) * (ramp.R.length - 1);
  const i = Math.min(ramp.R.length - 2, Math.floor(x));
  const f = x - i;
  const a = ramp.R[i];
  const b = ramp.R[i + 1];
  const c = ramp.T[i];
  const d = ramp.T[i + 1];
  return {
    R: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f],
    T: [c[0] + (d[0] - c[0]) * f, c[1] + (d[1] - c[1]) * f, c[2] + (d[2] - c[2]) * f],
  };
}

/**
 * How much paler a vein is than the lamina around it. Vascular bundles carry no
 * chloroplasts and the bundle-sheath tissue over them holds roughly half the
 * chlorophyll of the mesophyll, so a vein reflects and transmits more green and
 * red. Returned as a per-channel difference to add to the lamina's R and T, taken
 * at the species' reference biochemistry (a first-order correction).
 */
export function veinTint(leaf: LeafBiochemistry): { dR: RGB; dT: RGB } {
  const lamina = leafOptics(leaf);
  const vein = leafOptics({ ...leaf, Cab: leaf.Cab * 0.45, Car: leaf.Car * 0.7 });
  const delta = (a: RGB, b: RGB): RGB => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  return { dR: delta(vein.reflectance, lamina.reflectance), dT: delta(vein.transmittance, lamina.transmittance) };
}

/**
 * Reference leaves. Values follow the LOPEX / ANGERS leaf databases used to
 * calibrate PROSPECT: mature sun leaves hold 40..60 µg/cm² chlorophyll with
 * carotenoids near a fifth of that; expanding leaves have a third of the
 * chlorophyll and look yellow-green; senescent leaves lose chlorophyll first
 * (yellow), then accumulate brown pigment.
 */
export const LEAF_PRESETS = {
  /** Cocos nucifera leaflet, mature: thin monocot blade, high chlorophyll. */
  palmMature: { N: 1.45, Cab: 52, Car: 10, Cbrown: 0 } as LeafBiochemistry,
  /** Coconut spear leaf / newly opened frond: still expanding, pale. */
  palmYoung: { N: 1.3, Cab: 22, Car: 7, Cbrown: 0 } as LeafBiochemistry,
  /** Yellowing old frond before it dies. */
  palmSenescent: { N: 1.5, Cab: 12, Car: 6, Cbrown: 0.25 } as LeafBiochemistry,
  /** Dead hanging frond: chlorophyll gone, tissue browned. */
  palmDead: { N: 1.6, Cab: 0.8, Car: 0.8, Cbrown: 1.6 } as LeafBiochemistry,
  /** Thick waxy tropical broadleaf (Scaevola / Calophyllum type shade leaf). */
  broadleaf: { N: 2.0, Cab: 58, Car: 11, Cbrown: 0 } as LeafBiochemistry,
  broadleafYoung: { N: 1.6, Cab: 28, Car: 8, Cbrown: 0 } as LeafBiochemistry,
  /** Older broadleaf going yellow. */
  broadleafOld: { N: 2.1, Cab: 18, Car: 7, Cbrown: 0.15 } as LeafBiochemistry,
  /** Palmetto-style fan blade. */
  fan: { N: 1.7, Cab: 45, Car: 9, Cbrown: 0 } as LeafBiochemistry,
};
