import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { createScene } from '../../shared/gi/surfel/scene.ts';
import { Layer, Mobility, applyMobility } from '../../shared/world/index.ts';
import { createCorridorMaterials } from '../../entities/corridor/index.ts';

export interface CorridorScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun: THREE.DirectionalLight;
  update: (elapsedSeconds: number) => void;
  glare: { strength: number; radius: number };
}

const CAMERA_PRESETS: Record<string, [THREE.Vector3, THREE.Vector3]> = {
  hero: [new THREE.Vector3(6.6, 1.6, 0.0), new THREE.Vector3(-6.0, 1.2, 0.0)],
  wide: [new THREE.Vector3(15.0, 9.5, 13.0), new THREE.Vector3(0.0, 1.0, 0.0)],
  bench: [new THREE.Vector3(2.4, 1.25, -0.6), new THREE.Vector3(0.0, 0.45, -1.8)],
  panels: [new THREE.Vector3(1.0, 1.7, 3.2), new THREE.Vector3(-2.0, 1.9, 5.6)],
  floor: [new THREE.Vector3(1.6, 0.55, 1.2), new THREE.Vector3(-3.0, 0.05, 0.4)],
  deep: [new THREE.Vector3(-6.5, 1.6, 1.0), new THREE.Vector3(6.0, 1.4, -0.4)],
};

function placeCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls): void {
  const search = new URLSearchParams(window.location.search);
  const triple = (key: string) => {
    const raw = search.get(key)?.split(',').map(Number);
    return raw?.length === 3 && raw.every(Number.isFinite) ? new THREE.Vector3(raw[0], raw[1], raw[2]) : null;
  };
  const preset = CAMERA_PRESETS[search.get('cam') ?? ''] ?? CAMERA_PRESETS.hero;
  camera.position.copy(preset[0]);
  controls.target.copy(preset[1]);
  const free = triple('camPos');
  if (free) {
    camera.position.copy(free);
    controls.target.copy(triple('camTarget') ?? new THREE.Vector3(0, 1, 0));
  }
  controls.update();
}

function unshareGeometry(root: THREE.Object3D): void {
  const owner = new Map<THREE.BufferGeometry, THREE.Mesh>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const first = owner.get(mesh.geometry);
    if (first && first !== mesh) mesh.geometry = mesh.geometry.clone();
    else owner.set(mesh.geometry, mesh);
  });
}

function prepareSurfaces(root: THREE.Object3D): void {
  unshareGeometry(root);
  const concrete = createCorridorMaterials();
  const replace = (entry: THREE.Material) => {
    const built = concrete.get(entry.name);
    if (!built) return entry;
    built.side = entry.side;
    built.shadowSide = entry.shadowSide;
    return built;
  };
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (!mesh.geometry.getAttribute('uv')) {
      const count = mesh.geometry.getAttribute('position').count;
      mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(replace)
      : replace(mesh.material);
  });
}

export async function createCorridorScene(renderer: THREE.WebGPURenderer): Promise<CorridorScene> {
  const { scene, camera, controls, dirLight: sun } = createScene(renderer);
  scene.background = null;

  camera.fov = 42;
  camera.near = 0.05;
  camera.far = 400;
  camera.updateProjectionMatrix();
  placeCamera(camera, controls);
  camera.layers.enable(Layer.Debug);

  const url = `${import.meta.env.BASE_URL}models/corridor/corridor.glb`;
  const gltf = await new GLTFLoader().loadAsync(url);
  const corridor = gltf.scene;
  corridor.name = 'corridor';
  prepareSurfaces(corridor);
  scene.add(corridor);
  applyMobility(corridor, Mobility.Static);

  return {
    scene,
    camera,
    controls,
    sun,
    glare: { strength: 0.16, radius: 0.5 },
    update: () => {},
  };
}
