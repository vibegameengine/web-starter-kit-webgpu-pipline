import * as THREE from 'three/webgpu';

/**
 * One description of the lagoon water as a light-absorbing medium, read by the two
 * consumers that must agree: the water surface shader (transmittance along the view
 * path) and the sand shader (sunlight reaching the floor). The surfel integrator has
 * a hook for it (`setGiMedium`) that is not wired yet.
 *
 * Absorption per metre, linear RGB. Red goes first; that is the whole colour of the sea.
 */
export const WATER_ABSORB = new THREE.Vector3(0.5, 0.085, 0.075);
