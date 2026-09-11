import * as THREE from 'three/webgpu';
import { createScene } from '../../shared/gi/surfel/scene.ts';
import { Layer } from '../../shared/world/index.ts';
import { createFiberSceneRoot } from '../../shared/fiber/index.ts';
import { IslandPrefab } from '../../entities/island/IslandPrefab.tsx';
import { createWater } from '../../entities/water/index.ts';
import { WaterPrefab } from '../../entities/water/WaterPrefab.tsx';
import { bakeBathymetry } from '../../entities/water/bathymetry.ts';
import { createBackdrop } from '../../entities/backdrop/index.ts';
import { RockInstances } from '../../entities/rocks/RockInstances.tsx';
import { VillagePrefab } from '../../entities/village/index.ts';
import { createVillageCoast } from './villageCoast.ts';
import type { BeachScene } from './beachScene.ts';
import { loadVillageMaterials, VillageMaterialsContext } from '../../entities/village/materials.tsx';
import { createVillageMaterialReview } from '../../entities/village/reviewMaterials.ts';
import { bootStage } from '../../shared/ui/bootProgress.ts';

if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', ({ updates }) => {
    const paths = ['/src/entities/village/', '/src/shared/fiber/', '/src/widgets/world/village', '/src/entities/island/IslandPrefab', '/src/entities/rocks/RockInstances', '/src/entities/water/WaterPrefab'];
    if (updates.some(update => paths.some(path => update.path.startsWith(path) || update.acceptedPath.startsWith(path)))) location.reload();
  });
}

export async function createMidseeVillageScene(renderer: THREE.WebGPURenderer, environment: THREE.Texture): Promise<BeachScene> {
  const { scene, camera, controls, dirLight: sun } = createScene(renderer);
  scene.name = 'midsee-village';
  scene.background = null;
  camera.fov = 30;
  camera.near = .2;
  camera.far = 600;
  camera.position.set(24.5, 14.4, 38.8);
  controls.target.set(0, -.9, 0);
  const params = new URLSearchParams(location.search);
  const presets: Record<string, [number[], number[]]> = {
    hero: [[24.5,14.4,38.8],[0,-.9,0]],
    front: [[0,17,46],[0,2,-1]],
    side: [[46,16,0],[0,2,-1]],
    rear: [[-23,20,-43],[0,2,-1]],
    quay: [[12,6,13],[2,3,-2]],
    roofs: [[15,18,8],[0,6,-5]],
  };
  const preset = presets[params.get('cam') ?? ''];
  if (preset) { camera.position.fromArray(preset[0]); controls.target.fromArray(preset[1]); }
  for (const [key, target] of [['camPos',camera.position],['camTarget',controls.target]] as const) {
    const values = params.get(key)?.split(',').map(Number);
    if (values?.length === 3 && values.every(Number.isFinite)) target.fromArray(values);
  }
  camera.updateProjectionMatrix();
  camera.layers.enable(Layer.Debug);
  controls.update();
  const { field, island, batches } = await createVillageCoast();
  const materials = await bootStage('Village: house and quay materials', () => loadVillageMaterials(environment));
  const fiber = await createFiberSceneRoot(renderer, scene, camera);
  const coast = <group name="coast-prefab">
    <IslandPrefab island={island} sun={sun}/>
    <VillageMaterialsContext value={materials}><VillagePrefab/></VillageMaterialsContext>
    <RockInstances batches={batches}/>
  </group>;
  await bootStage('Village: raising the houses and the quay', () => fiber.render(coast));
  const rocks = scene.getObjectByName('village-shore-rocks')!;
  const shoreStructures = ['foundations','terrace-grotto','masonry-courses','terrace-stairs'].map(name=>scene.getObjectByName(name)!);
  const bathymetry = await bootStage('Village: bathymetry', () => bakeBathymetry({renderer,objects:[rocks,...shoreStructures],base:field.toTexture(512,true),half:field.half,size:512}));
  const water = createWater({renderer,field,environment,sun,bathymetry,simulationFrames:Infinity,offThread:true});
  water.onField = texture => island.setWetness(texture);
  await bootStage('Village: settling the water simulation', () => water.ready);
  const backdrop = createBackdrop({islandBottom:field.bottom,islandHalf:field.half});
  backdrop.traverse(o=>{o.layers.set(Layer.Debug);o.userData.giExclude=true;});
  await bootStage('Village: water and backdrop', () => fiber.render(<>{coast}<WaterPrefab water={water}/><primitive object={backdrop} dispose={null}/></>));
  window.addEventListener('resize', () => fiber.resize(renderer.domElement.clientWidth, renderer.domElement.clientHeight));
  (window as unknown as Record<string, unknown>).__village = {
    architecture: 'react-three-fiber',
    reviewMaterials: createVillageMaterialReview([scene.getObjectByName('midsee-village-prefab')!,rocks,scene.getObjectByName('island')!]),
    instances: () => {
      const rows: unknown[] = [];
      scene.traverse(object => {
        const mesh = object as THREE.InstancedMesh;
        if (mesh.isInstancedMesh) rows.push({name:mesh.name,count:mesh.count,geometry:mesh.geometry.uuid,part:mesh.userData.part,ids:mesh.userData.instanceIds});
      });
      return rows;
    },
  };
  return {
    scene,camera,controls,sun,water,field,bindScreen:water.bindScreen,
    atmosphere:{enabled:false},glare:{strength:.16,radius:.5},
    bindGui(gui) {
      const f=gui.addFolder('Village cameras');
      for (const [name,[pos,target]] of Object.entries(presets)) {
        f.add({[name]:()=>{camera.position.fromArray(pos);controls.target.fromArray(target);controls.update();}},name);
      }
    },
    update(t) { fiber.advance(t); },
  };
}
