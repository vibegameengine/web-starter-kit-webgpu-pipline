import * as THREE from 'three/webgpu';
import { Mobility, applyMobility } from '../../world/index.ts';
import { reflectSettings } from './settings.ts';

/**
 * The glossy Cornell variant, behind `?reflScene=1`.
 *
 * A reflection pass over a room of roughness-1 walls draws nothing, which is why this
 * subsystem could be missing for as long as it was without anyone seeing a defect. So
 * the acceptance needs a mirror, and the mirror must not disturb the acceptance
 * baselines every other claim in this build rests on — hence a URL variant that adds
 * meshes, rather than a roughness edit to `content.ts`, which would change every capture
 * ever taken of the default scene.
 *
 * Two surfaces, because they answer different questions. The sphere is the legibility
 * test: a chrome ball between a red wall and a green one has exactly one correct answer
 * and a screenshot either shows it or does not. The floor plate is the *movable
 * geometry* test: the orbiting sphere hangs above it, so `?dyntrace=0` either removes a
 * reflection from a known patch of floor or the tier is not tracing the dynamic
 * structure at all.
 *
 * KNOWN AND DELIBERATE: these meshes are raster-only. They are added on the first frame
 * the reflection pass runs, which is long after `gi.buildScene` has merged and built both
 * acceleration structures, and those structures cannot grow once bound. So the test
 * surfaces reflect the world but do not appear in anything else's rays — no reflection of
 * the plate in the sphere, no shadow of the sphere in the cache. Getting them into the
 * BVH needs a call in `app/main.ts` before the build, which this work is not allowed to
 * make. It costs nothing that the measurements need, and it has the side benefit that
 * the acceleration structures are bit-identical with and without the variant.
 */

let injected = false;

export function injectReflectTestScene(scene: THREE.Scene): void {
  if (injected) return;
  injected = true;

  const rough = Math.max(0.01, reflectSettings.testRoughness);
  const group = new THREE.Group();
  group.name = 'reflectTestScene';

  // Cornell interior: x and z in [-4, 4], floor top at y = -0.5, ceiling at y = 5.5.
  const chrome = new THREE.Mesh(
    new THREE.SphereGeometry(1.0, 64, 48),
    new THREE.MeshStandardNodeMaterial({
      color: 0xffffff,
      roughness: rough,
      metalness: 1.0,
    }),
  );
  // Left of centre and forward of the tall box, so the red wall fills one side of it
  // and the green wall the other. Radius 1.0 sitting on the floor.
  chrome.position.set(-2.2, 0.5, 2.4);
  chrome.name = 'reflectChromeSphere';
  group.add(chrome);

  // 2cm above the real floor rather than replacing it: the floor is in the BVH and the
  // plate is not, and coplanar geometry would have the raster and the tracer disagreeing
  // about which surface a ray started on.
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(7.6, 7.0),
    new THREE.MeshStandardNodeMaterial({
      color: 0x9a9a9a,
      roughness: rough,
      metalness: 1.0,
    }),
  );
  plate.rotation.x = -Math.PI / 2;
  plate.position.set(0, -0.48, 0.4);
  plate.name = 'reflectMirrorFloor';
  group.add(plate);

  applyMobility(group, Mobility.Static);
  scene.add(group);

  console.log(
    `[reflect] test scene injected: chrome sphere + mirror floor at roughness ${rough}`,
  );
}
