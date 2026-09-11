import * as THREE from 'three/webgpu';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createScene } from '../../shared/gi/surfel/scene.ts';
import { Layer, Mobility, applyMobility } from '../../shared/world/index.ts';
import { createFiberSceneRoot } from '../../shared/fiber/index.ts';
import { HousePrefab, VILLAGE_HOUSES } from '../../entities/village/index.ts';

import { VillageWindows } from '../../entities/village/WindowPrefabs.tsx';
import { loadVillageMaterials, VillageMaterialsContext } from '../../entities/village/materials.tsx';
import { bootStage } from '../../shared/ui/bootProgress.ts';

export interface VillageLightScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun: THREE.DirectionalLight;
  update: (elapsedSeconds: number) => void;
}

/**
 * @important One house of the village and nothing else: same InstancedMesh prefabs
 * (roof tiles, windows) and same materials, no island, rocks, water, foliage or
 * backdrop. The full village needs ~90 s per boot — 2.3 M triangles of contact BVH and
 * a 2109 m² lightmap — so a four-boot measurement was a ten-minute loop. A check that
 * only asks about instanced motion vectors boots this instead.
 */
export async function createVillageLightScene(renderer: THREE.WebGPURenderer, environment: THREE.Texture): Promise<VillageLightScene> {
  const { scene, camera, controls, dirLight: sun } = createScene(renderer);
  scene.name = 'village-light';
  scene.background = null;
  camera.fov = 35;
  camera.near = 0.2;
  camera.far = 200;
  const house = VILLAGE_HOUSES[0];
  camera.position.set(house.x + 9, 7, house.z + 12);
  controls.target.set(house.x, 3, house.z);
  camera.updateProjectionMatrix();
  camera.layers.enable(Layer.Debug);
  controls.update();

  const ground = new THREE.Mesh(new THREE.BoxGeometry(40, 1, 40), new THREE.MeshStandardNodeMaterial({ color: 0xb9ab92, roughness: 0.9 }));
  ground.position.set(house.x, -0.5, house.z);
  ground.name = 'village-light-ground';
  applyMobility(ground, Mobility.Static);
  scene.add(ground);

  const materials = await bootStage('Village light: materials', () => loadVillageMaterials(environment));
  const fiber = await createFiberSceneRoot(renderer, scene, camera);
  await bootStage('Village light: one house', () => fiber.render(
    <VillageMaterialsContext value={materials}>
      <group name="village-light-prefab">
        <HousePrefab house={house}/>
        <VillageWindows/>
      </group>
    </VillageMaterialsContext>,
  ));
  window.addEventListener('resize', () => fiber.resize(renderer.domElement.clientWidth, renderer.domElement.clientHeight));

  return { scene, camera, controls, sun, update(t) { fiber.advance(t); } };
}
