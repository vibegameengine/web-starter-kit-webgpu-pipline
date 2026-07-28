import * as THREE from 'three';

/**
 * CPU twin of the SkyAtmosphere scattering math (Hillaire/UE model).
 * Feeds sun color, ambient tints and the multiple-scattering term to both
 * the WebGL and the WebGPU/TSL sky implementations. Units: km.
 */

export const Rg = 6360;
export const Rt = 6460;
export const BETA_R = [5.802e-3, 13.558e-3, 33.1e-3];
export const BETA_M_S = 3.996e-3;
export const BETA_M_A = 4.4e-3;
export const BETA_O = [0.650e-3, 1.881e-3, 0.085e-3];
export const H_R = 8;
export const H_M = 1.2;

export function medium(h: number): { sR: number[]; sM: number; ext: number[] } {
  const dR = Math.exp(-h / H_R);
  const dM = Math.exp(-h / H_M);
  const dO = Math.max(0, 1 - Math.abs(h - 25) / 15);
  const sR = BETA_R.map((b) => b * dR);
  const sM = BETA_M_S * dM;
  const ext = sR.map((s, i) => s + (BETA_M_S + BETA_M_A) * dM + BETA_O[i] * dO);
  return { sR, sM, ext };
}

export function raySphereJS(ro: number[], rd: number[], r: number): number {
  const b = ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2];
  const c = ro[0] ** 2 + ro[1] ** 2 + ro[2] ** 2 - r * r;
  let h = b * b - c;
  if (h < 0) return -1;
  h = Math.sqrt(h);
  let t = -b - h;
  if (t > 0) return t;
  t = -b + h;
  return t > 0 ? t : -1;
}

export function sunTransmittanceJS(p: number[], sun: number[]): number[] {
  if (raySphereJS(p, sun, Rg) > 0) return [0, 0, 0];
  const tTop = raySphereJS(p, sun, Rt);
  const N = 16;
  const seg = tTop / N;
  const od = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const sp = [p[0] + sun[0] * (i + 0.5) * seg, p[1] + sun[1] * (i + 0.5) * seg, p[2] + sun[2] * (i + 0.5) * seg];
    const h = Math.hypot(sp[0], sp[1], sp[2]) - Rg;
    const { ext } = medium(h);
    od[0] += ext[0] * seg;
    od[1] += ext[1] * seg;
    od[2] += ext[2] * seg;
  }
  return od.map((o) => Math.exp(-o));
}

/**
 * Isotropic multiple-scattering term Ψms (Hillaire eq. 10 approximation):
 * integrate 2nd-order in-scatter over the sphere at ground level, then
 * amplify by the geometric series 1/(1-f_ms).
 */
export function computePsiMS(sun: number[]): THREE.Vector3 {
  const ro = [0, Rg + 0.002, 0];
  const DIRS = 8;
  const lum = [0, 0, 0];
  const fms = [0, 0, 0];
  for (let d = 0; d < DIRS; d++) {
    // Fibonacci sphere directions
    const y = 1 - (2 * (d + 0.5)) / DIRS;
    const r = Math.sqrt(1 - y * y);
    const a = d * 2.399963;
    const rd = [r * Math.cos(a), y, r * Math.sin(a)];
    const tG = raySphereJS(ro, rd, Rg);
    const tMax = tG > 0 ? tG : raySphereJS(ro, rd, Rt);
    const N = 12;
    const seg = tMax / N;
    const T = [1, 1, 1];
    const mu = rd[0] * sun[0] + rd[1] * sun[1] + rd[2] * sun[2];
    const phR = (3 / (16 * Math.PI)) * (1 + mu * mu);
    const g = 0.8;
    const dd = 1 + g * g - 2 * g * mu;
    const phM = ((3 / (8 * Math.PI)) * ((1 - g * g) * (1 + mu * mu))) / ((2 + g * g) * dd * Math.sqrt(dd));
    for (let i = 0; i < N; i++) {
      const p = [ro[0] + rd[0] * (i + 0.5) * seg, ro[1] + rd[1] * (i + 0.5) * seg, ro[2] + rd[2] * (i + 0.5) * seg];
      const h = Math.hypot(p[0], p[1], p[2]) - Rg;
      const { sR, sM, ext } = medium(h);
      const sunT = sunTransmittanceJS(p, sun);
      for (let k = 0; k < 3; k++) {
        const sampleT = Math.exp(-ext[k] * seg);
        const S = (sR[k] * phR + sM * phM) * sunT[k];
        const Sf = sR[k] + sM; // isotropic re-scatter potential
        lum[k] += (T[k] * (S - S * sampleT)) / ext[k] / DIRS;
        fms[k] += (T[k] * (Sf - Sf * sampleT)) / ext[k] / DIRS;
        T[k] *= sampleT;
      }
    }
  }
  return new THREE.Vector3(
    lum[0] / (1 - Math.min(0.99, fms[0])),
    lum[1] / (1 - Math.min(0.99, fms[1])),
    lum[2] / (1 - Math.min(0.99, fms[2])),
  );
}

/** Sky radiance toward rd — coarse CPU twin for fog/ambient tints. */
export function skyRadianceJS(rd: number[], sun: number[], psi: THREE.Vector3, intensity: number): THREE.Color {
  const ro = [0, Rg + 0.002, 0];
  const tG = raySphereJS(ro, rd, Rg);
  const tMax = tG > 0 ? tG : raySphereJS(ro, rd, Rt);
  const N = 16;
  const seg = tMax / N;
  const mu = rd[0] * sun[0] + rd[1] * sun[1] + rd[2] * sun[2];
  const phR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g = 0.8;
  const dd = 1 + g * g - 2 * g * mu;
  const phM = ((3 / (8 * Math.PI)) * ((1 - g * g) * (1 + mu * mu))) / ((2 + g * g) * dd * Math.sqrt(dd));
  const L = [0, 0, 0];
  const T = [1, 1, 1];
  const psiArr = [psi.x, psi.y, psi.z];
  for (let i = 0; i < N; i++) {
    const p = [ro[0] + rd[0] * (i + 0.5) * seg, ro[1] + rd[1] * (i + 0.5) * seg, ro[2] + rd[2] * (i + 0.5) * seg];
    const h = Math.hypot(p[0], p[1], p[2]) - Rg;
    const { sR, sM, ext } = medium(h);
    const sunT = sunTransmittanceJS(p, sun);
    for (let k = 0; k < 3; k++) {
      const sampleT = Math.exp(-ext[k] * seg);
      const S = (sR[k] * phR + sM * phM) * sunT[k] + (sR[k] + sM) * psiArr[k];
      L[k] += (T[k] * (S - S * sampleT)) / ext[k];
      T[k] *= sampleT;
    }
  }
  return new THREE.Color(L[0] * intensity, L[1] * intensity, L[2] * intensity);
}

