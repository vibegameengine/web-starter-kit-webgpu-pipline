import * as THREE from 'three/webgpu';

/**
 * One description of the lagoon water as a medium, read by three consumers that must
 * agree: the water surface shader (transmittance and single scattering along the
 * refracted view path), the sand shader (sunlight reaching the floor), and the surfel
 * integrator (sunlight reaching any hit below the water line).
 *
 * Absorption is pure water's (Pope & Fry 1997) at roughly 620 / 550 / 450 nm, per
 * metre, linear RGB: red goes first, blue almost not at all — the colour of the sea
 * is the floor seen through that. On top, a spectrally flat particulate term is the
 * one art knob (grill Q25): scattering coefficient σs with single-scattering albedo
 * ω₀ and a Henyey–Greenstein phase function of asymmetry g.
 */
export const WATER_ABSORB = new THREE.Vector3(0.276, 0.0565, 0.0092);
/** Particulate scattering, per metre (clear lagoon ≈ 0.05–0.3). */
export const WATER_SCATTER = 0.1;
export const WATER_SCATTER_ALBEDO = 0.95;
export const WATER_HG_G = 0.85;
export const WATER_IOR = 1.333;

/**
 * Effective attenuation of a beam for the floor's illumination and the view path:
 * absorption plus the part of the scattering that actually leaves the forward cone,
 * σa + σs·(1 − g) — light scattered by a few degrees still arrives.
 */
export function waterAttenuation(): THREE.Vector3 {
  const sigmaA = WATER_ABSORB.clone().addScalar(WATER_SCATTER * (1 - WATER_SCATTER_ALBEDO));
  return sigmaA.addScalar(WATER_SCATTER * (1 - WATER_HG_G));
}
