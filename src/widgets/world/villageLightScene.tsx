import * as THREE from 'three/webgpu';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createScene } from '../../shared/gi/surfel/scene.ts';
import { Layer } from '../../shared/world/index.ts';
import { createFiberSceneRoot } from '../../shared/fiber/index.ts';
import { IslandPrefab } from '../../entities/island/IslandPrefab.tsx';
import { VillagePrefab } from '../../entities/village/index.ts';
import { createVillageCoast } from './villageCoast.ts';
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
 * @important The village's charted surfaces and nothing else. Same island, same houses,
 * terraces, quay and roofs through the same prefabs, so the atlas under test holds the
 * same charts and the black patches on the walls reproduce here. What is dropped is what
 * never reaches a chart and only costs a shader and a contact tree: the water simulation
 * and its bathymetry bake, the shore rocks, the backdrop, and the prefab's dressing -
 * pines, cypresses, garden trees, planting, the boat and the harbour clutter. The full
 * village takes about five minutes a boot, which turned any four-boot measurement into a
 * ten-minute loop.
 */
export async function createVillageLightScene(renderer: THREE.WebGPURenderer, environment: THREE.Texture): Promise<VillageLightScene> {
  const { scene, camera, controls, dirLight: sun } = createScene(renderer);
  scene.name = 'village-light';
  scene.background = null;
  camera.fov = 35;
  camera.near = .2;
  camera.far = 200;
  const presets: Record<string, [number[], number[]]> = {
    quay: [[12, 6, 13], [2, 3, -2]],
    front: [[0, 17, 46], [0, 2, -1]],
    walls: [[.5, 5.5, 7.5], [7, 3.6, -3]],
  };
  const params = new URLSearchParams(location.search);
  const [position, target] = presets[params.get('cam') ?? ''] ?? presets.quay;
  camera.position.fromArray(position);
  controls.target.fromArray(target);
  camera.updateProjectionMatrix();
  camera.layers.enable(Layer.Debug);
  controls.update();

  const { island } = await createVillageCoast();
  const materials = await bootStage('Village stand: materials', () => loadVillageMaterials(environment));
  const fiber = await createFiberSceneRoot(renderer, scene, camera);
  await bootStage('Village stand: island, houses and quay', () => fiber.render(
    <group name="coast-prefab">
      <IslandPrefab island={island} sun={sun}/>
      <VillageMaterialsContext value={materials}><VillagePrefab dressing={false}/></VillageMaterialsContext>
    </group>,
  ));
  window.addEventListener('resize', () => fiber.resize(renderer.domElement.clientWidth, renderer.domElement.clientHeight));

  return { scene, camera, controls, sun, update(t) { fiber.advance(t); } };
}
