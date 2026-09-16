import * as THREE from 'three/webgpu';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createScene } from '../../shared/gi/surfel/scene.ts';
import { Layer } from '../../shared/world/index.ts';
import { createFiberSceneRoot, StaticGroup } from '../../shared/fiber/index.ts';
import { bootStage } from '../../shared/ui/bootProgress.ts';

export interface SkyLabScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun: THREE.DirectionalLight;
  update: (elapsedSeconds: number) => void;
}

const PLINTH_SIZE = 20;
const COLUMN_COUNT = 7;
const COLUMN_SPACING = 2.2;

const CAMERA_PRESETS: Record<string, [number[], number[]]> = {
  horizon: [[0, 1.6, 9], [0, 3, -20]],
  sunward: [[-2, 1.4, 7], [30, 6, -20]],
  zenith: [[0, 1.6, 4], [0, 40, -6]],
  objects: [[6, 3.2, 8], [0, 1.2, 0]],
};

function Colonnade() {
  const offset = ((COLUMN_COUNT - 1) * COLUMN_SPACING) / 2;
  return <group name="colonnade" position={[0, 0, -4]}>
    {Array.from({ length: COLUMN_COUNT }, (_, index) => (
      <mesh key={index} name={`column-${index}`} position={[index * COLUMN_SPACING - offset, 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.28, 0.32, 4, 24]}/>
        <meshStandardMaterial color="#d8d2c4" roughness={0.85}/>
      </mesh>
    ))}
    <mesh name="architrave" position={[0, 4.2, 0]} castShadow receiveShadow>
      <boxGeometry args={[COLUMN_COUNT * COLUMN_SPACING, 0.4, 0.9]}/>
      <meshStandardMaterial color="#d8d2c4" roughness={0.85}/>
    </mesh>
  </group>;
}

function SkyLabPrefab() {
  return <StaticGroup name="sky-lab">
    <mesh name="plinth" position={[0, -0.1, 0]} receiveShadow castShadow>
      <boxGeometry args={[PLINTH_SIZE, 0.2, PLINTH_SIZE]}/>
      <meshStandardMaterial color="#8c8577" roughness={0.95}/>
    </mesh>
    <Colonnade/>
    <mesh name="white-sphere" position={[-2.5, 0.8, 2]} castShadow receiveShadow>
      <sphereGeometry args={[0.8, 48, 32]}/>
      <meshStandardMaterial color="#f2f2f2" roughness={0.9}/>
    </mesh>
    <mesh name="mirror-sphere" position={[2.5, 0.8, 2]} castShadow receiveShadow>
      <sphereGeometry args={[0.8, 48, 32]}/>
      <meshStandardMaterial color="#ffffff" metalness={1} roughness={0.04}/>
    </mesh>
    <mesh name="obelisk" position={[6, 3, -1]} castShadow receiveShadow>
      <boxGeometry args={[0.8, 6, 0.8]}/>
      <meshStandardMaterial color="#6f5b4b" roughness={0.7}/>
    </mesh>
  </StaticGroup>;
}

/* @important A sky test rig, not a scene: a small plinth so the lightmap stays one page and the
   boot stays in seconds, with nothing past its edge, so every pixel above the plinth's rim is the
   atmosphere itself, including the planet's ground below the horizon. The colonnade throws long
   shadows at low sun, the white sphere shows the sun's colour against the sky's, the mirror sphere
   shows the whole dome at once. */
export async function createSkyLabScene(renderer: THREE.WebGPURenderer): Promise<SkyLabScene> {
  const { scene, camera, controls, dirLight: sun } = createScene(renderer);
  scene.name = 'sky-lab';
  scene.background = null;
  camera.fov = 50;
  camera.near = 0.1;
  camera.far = 4000;
  const [position, target] = CAMERA_PRESETS[new URLSearchParams(location.search).get('cam') ?? ''] ?? CAMERA_PRESETS.horizon;
  camera.position.fromArray(position);
  controls.target.fromArray(target);
  camera.updateProjectionMatrix();
  camera.layers.enable(Layer.Debug);
  controls.update();
  scene.add(sun.target);

  const fiber = await createFiberSceneRoot(renderer, scene, camera);
  await bootStage('Sky lab: plinth and colonnade', () => fiber.render(<SkyLabPrefab/>));
  window.addEventListener('resize', () => fiber.resize(renderer.domElement.clientWidth, renderer.domElement.clientHeight));
  return { scene, camera, controls, sun, update(t) { fiber.advance(t); } };
}
