import * as THREE from 'three/webgpu';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { createScene } from '../../shared/gi/surfel/scene.ts';
import { Layer, Mobility, applyMobility } from '../../shared/world/index.ts';

export interface LeakRoomScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun: THREE.DirectionalLight;
  update: (elapsedSeconds: number) => void;
  interiorVolumes: THREE.Box3[];
  gapMetres: number;
  scale: number;
}

const INNER = 2;
const WALL = 0.2;
const HEIGHT = 2;
const GROUND = 12;
const OUTER = INNER + 2 * WALL;

const CAMERA_PRESETS: Record<string, [THREE.Vector3, THREE.Vector3]> = {
  inside: [new THREE.Vector3(-0.6, 1, 0.6), new THREE.Vector3(1.1, 0.3, -0.2)],
  contact: [new THREE.Vector3(-0.2, 0.4, 0.35), new THREE.Vector3(1.1, 0.03, -0.05)],
  floor: [new THREE.Vector3(0, 0.25, 0.8), new THREE.Vector3(0, 0.02, -0.9)],
  outside: [new THREE.Vector3(4.2, 2.6, 4.2), new THREE.Vector3(0, 1, 0)],
};

function matte(hex: number): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(hex) });
  material.roughness = 1;
  material.metalness = 0;
  return material;
}

function slab(name: string, size: THREE.Vector3, at: THREE.Vector3, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
  mesh.name = name;
  mesh.position.copy(at);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function placeCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, search: URLSearchParams, scale: number): void {
  const preset = CAMERA_PRESETS[search.get('cam') ?? ''] ?? CAMERA_PRESETS.contact;
  camera.position.copy(preset[0]).multiplyScalar(scale);
  controls.target.copy(preset[1]).multiplyScalar(scale);
  controls.update();
}

/* @important The sealed room is the only receiver whose true irradiance is known: zero. A lightmap
   that puts light on its inner faces is leaking, and the amount is the error in physical units.
   ?gap= opens a slit of that many millimetres along the foot of the +X wall, so the same scene also
   proves the opposite - a real opening still lets light in, and a fix that passes by thickening
   walls or darkening the bake fails here. Design section 07, scenes A1 and A2. */
/* @important ?scale= is design section 07's A3. Every length the tracer compares against is now
   explicit, but two of them are still absolute - the ray distance guard and the spawn offset - so a
   room a thousand times smaller or larger is the test that says whether they hold. The scene, the
   camera and the gap scale together, so the only thing that may change is the tracer's arithmetic. */
export function createLeakRoomScene(renderer: THREE.WebGPURenderer): LeakRoomScene {
  const search = new URLSearchParams(window.location.search);
  const rawScale = Number(search.get('scale') ?? '1');
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
  const gapMillimetres = Number(search.get('gap') ?? '0');
  const gapMetres = (Number.isFinite(gapMillimetres) ? Math.max(0, gapMillimetres) / 1000 : 0) * scale;

  const { scene, camera, controls, dirLight: sun } = createScene(renderer);
  scene.background = null;
  camera.fov = 55;
  camera.near = 0.02 * scale;
  camera.far = 200 * scale;
  camera.updateProjectionMatrix();
  camera.layers.enable(Layer.Debug);
  placeCamera(camera, controls, search, scale);

  const elevation = THREE.MathUtils.degToRad(Number(search.get('sunElevation') ?? '22'));
  sun.position.set(Math.cos(elevation) * 30 * scale, Math.sin(elevation) * 30 * scale, 6 * scale);
  sun.intensity = Number(search.get('sunIntensity') ?? '6');
  sun.target.position.set(0, 0, 0);
  scene.add(sun.target);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND * scale, GROUND * scale), matte(0x9a9a9a));
  ground.name = 'ground';
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const shell = matte(0x8f8f8f);
  const half = (INNER / 2 + WALL / 2) * scale;
  const wall = WALL * scale;
  const height = HEIGHT * scale;
  const outer = OUTER * scale;
  scene.add(slab('wall-x-minus', new THREE.Vector3(wall, height, outer), new THREE.Vector3(-half, height / 2, 0), shell));
  scene.add(slab('wall-z-minus', new THREE.Vector3(outer, height, wall), new THREE.Vector3(0, height / 2, -half), shell));
  scene.add(slab('wall-z-plus', new THREE.Vector3(outer, height, wall), new THREE.Vector3(0, height / 2, half), shell));
  scene.add(slab('ceiling', new THREE.Vector3(outer, wall, outer), new THREE.Vector3(0, height + wall / 2, 0), shell));
  scene.add(slab('wall-x-plus', new THREE.Vector3(wall, height, outer), new THREE.Vector3(half, gapMetres + height / 2, 0), shell));

  applyMobility(scene, Mobility.Static);

  const interior = new THREE.Box3(
    new THREE.Vector3(-INNER / 2, 0, -INNER / 2).multiplyScalar(scale),
    new THREE.Vector3(INNER / 2, HEIGHT, INNER / 2).multiplyScalar(scale),
  );

  return { scene, camera, controls, sun, update: () => {}, interiorVolumes: [interior], gapMetres, scale };
}

export const LEAK_ROOM_PROBES: [number, number, number][] = [
  [0, 0.001, 0],
  [0.6, 0.001, 0.6],
  [-0.6, 0.001, -0.6],
  [-INNER / 2 + 0.002, 1, 0],
  [0, 1, -INNER / 2 + 0.002],
  [0, HEIGHT - 0.002, 0],
];
