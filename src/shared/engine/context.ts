import * as THREE from 'three';

/**
 * WorldContext — the single source of truth shared by every system,
 * mirroring how one UE DirectionalLight drives light + fog + sky + clouds.
 */
export interface WorldContext {
  /** Normalized direction FROM origin TOWARD the sun. */
  sunDir: THREE.Vector3;
  /** Sun disc color after atmospheric absorption (linear). */
  sunColor: THREE.Color;
  /** Average sky/ambient tint (linear). */
  skyColor: THREE.Color;
  /** Zenith sky tint used for aerial perspective (linear). */
  zenithColor: THREE.Color;
  /** Horizon sky tint used by fog (linear). */
  horizonColor: THREE.Color;
  /** Elapsed time, seconds. */
  time: number;
  /** Wind direction (xz) and strength. */
  windDir: THREE.Vector2;
  windStrength: number;
  camera: THREE.PerspectiveCamera;
}

export function createContext(camera: THREE.PerspectiveCamera): WorldContext {
  return {
    sunDir: new THREE.Vector3(0, 1, 0),
    sunColor: new THREE.Color(1, 0.95, 0.85),
    skyColor: new THREE.Color(0.45, 0.6, 0.85),
    zenithColor: new THREE.Color(0.2, 0.4, 0.8),
    horizonColor: new THREE.Color(0.75, 0.82, 0.9),
    time: 0,
    windDir: new THREE.Vector2(0.8, 0.6).normalize(),
    windStrength: 0.6,
    camera,
  };
}
