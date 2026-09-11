import * as THREE from 'three/webgpu';

/* @important The sun's shadow camera used to cover the whole static world, which on the corridor is
   26 m across a 4096 map - 6.3 mm a texel. A lit sliver narrower than one texel is what drew the
   white line along the wall feet: measured at ?scene=corridor&cam=bench with the lightmap, probes
   and reflections at zero, the line is 72 bright pixels at 6.3 mm, 11 at 2.9 mm and 2 at 0.7 mm, and
   no depth or normal bias moves it. Fitting to what the camera can see buys that resolution without
   a bigger map. The fit is a sphere, not a box, so turning the camera cannot change its size, and
   its centre is snapped to whole texels, or the map would crawl under the smallest rotation. */
export interface SunShadowFit {
  update(camera: THREE.PerspectiveCamera): void;
  readonly extent: number;
  enabled: boolean;
}

const CORNERS = Array.from({ length: 8 }, () => new THREE.Vector3());
const lightView = new THREE.Matrix4();
const centre = new THREE.Vector3();
const lightDirection = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);
const fallbackUp = new THREE.Vector3(1, 0, 0);
const lightCentre = new THREE.Vector3();
const eye = new THREE.Vector3();

function viewSphere(camera: THREE.PerspectiveCamera, maxDistance: number): number {
  const near = camera.near;
  const far = Math.min(camera.far, maxDistance);
  const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const tanX = tanY * camera.aspect;
  let index = 0;
  for (const depth of [near, far]) {
    for (const sy of [-1, 1]) {
      for (const sx of [-1, 1]) {
        CORNERS[index++].set(sx * tanX * depth, sy * tanY * depth, -depth).applyMatrix4(camera.matrixWorld);
      }
    }
  }
  centre.set(0, 0, 0);
  for (const corner of CORNERS) centre.add(corner);
  centre.multiplyScalar(1 / CORNERS.length);
  let radius = 0;
  for (const corner of CORNERS) radius = Math.max(radius, corner.distanceTo(centre));
  return radius;
}

export function createSunShadowFit(
  sun: THREE.DirectionalLight,
  bounds: THREE.Box3,
  direction: () => THREE.Vector3,
  options: { maxDistance?: number; minExtent?: number } = {},
): SunShadowFit {
  const maxDistance = options.maxDistance ?? 30;
  const minExtent = options.minExtent ?? 2;
  const worldRadius = bounds.isEmpty() ? 0 : bounds.getSize(new THREE.Vector3()).length() * 0.5;
  const state = { enabled: true, extent: sun.shadow.camera.top };

  return {
    get extent() { return state.extent; },
    get enabled() { return state.enabled; },
    set enabled(value: boolean) { state.enabled = value; },
    update(camera: THREE.PerspectiveCamera): void {
      if (!state.enabled) return;
      const radius = Math.max(minExtent, viewSphere(camera, maxDistance));
      lightDirection.copy(direction()).normalize();
      const up = Math.abs(lightDirection.y) > 0.99 ? fallbackUp : worldUp;
      eye.copy(centre).addScaledVector(lightDirection, worldRadius + radius);
      lightView.lookAt(eye, centre, up).setPosition(eye).invert();

      const texel = (2 * radius) / sun.shadow.mapSize.x;
      lightCentre.copy(centre).applyMatrix4(lightView);
      lightCentre.x = Math.round(lightCentre.x / texel) * texel;
      lightCentre.y = Math.round(lightCentre.y / texel) * texel;
      lightCentre.applyMatrix4(lightView.clone().invert());

      sun.position.copy(lightCentre).addScaledVector(lightDirection, worldRadius + radius);
      sun.target.position.copy(lightCentre);
      sun.target.updateMatrixWorld();

      const shadowCamera = sun.shadow.camera;
      shadowCamera.left = -radius;
      shadowCamera.right = radius;
      shadowCamera.top = radius;
      shadowCamera.bottom = -radius;
      shadowCamera.near = 0.1;
      shadowCamera.far = 2 * (worldRadius + radius) + 1;
      shadowCamera.updateProjectionMatrix();
      sun.shadow.normalBias = texel * 0.3;
      state.extent = radius;
    },
  };
}
