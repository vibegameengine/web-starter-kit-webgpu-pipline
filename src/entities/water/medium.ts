import * as THREE from 'three/webgpu';

/**
 * One description of the lagoon water as a light-absorbing medium, read by three
 * consumers that must agree: the water surface shader (transmittance along the view
 * path), the sand shader (sunlight reaching the floor), and the surfel integrator
 * (sunlight reaching any hit below the water line, so the bounce off the lagoon floor
 * is already teal when it lands on a rock).
 *
 * Absorption per metre, linear RGB. Red goes first; that is the whole colour of the sea.
 */
export const WATER_ABSORB = new THREE.Vector3(2.0, 0.36, 0.15);
