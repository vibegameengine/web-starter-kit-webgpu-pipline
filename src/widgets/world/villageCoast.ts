import * as THREE from 'three/webgpu';
import { createIsland, type CliffTextures } from '../../entities/island/index.ts';
import { loadSandLayerMaps } from '../../entities/island/sandLayerTextures.ts';
import { useSandLayerMaps } from '../../entities/island/sandLayerMaps.ts';
import { createRockGeometry, createRockMaterial } from '../../entities/rocks/index.ts';
import type { RockBatch } from '../../entities/rocks/RockInstances.tsx';
import { instanceTransform } from '../../shared/fiber/index.ts';
import { VillageField } from './villageField.ts';
import { VILLAGE_PLOT } from '../../entities/village/layout.ts';
import { villageRockLayout } from '../../entities/village/coastLayout.ts';
import { applyVillageHeadlandSurface } from '../../entities/village/terrainMaterial.ts';
import { bootStage } from '../../shared/ui/bootProgress.ts';

export async function createVillageCoast() {
  const loader = new THREE.TextureLoader();
  const load = async (path: string, srgb: boolean) => {
    const t = await loader.loadAsync(`${import.meta.env.BASE_URL}textures/${path}`);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  };
  const [rockColor, rockNormal, rockRoughness, rockAo, dirtColor, dirtNormal] = await bootStage('Village: rock and dirt textures', () => Promise.all([
    load('rock/Rock030_2K-JPG_Color.jpg',true),load('rock/Rock030_2K-JPG_NormalGL.jpg',false),
    load('rock/Rock030_2K-JPG_Roughness.jpg',false),load('rock/Rock030_2K-JPG_AmbientOcclusion.jpg',false),
    load('dirt/Ground037_2K-JPG_Color.jpg',true),load('dirt/Ground037_2K-JPG_NormalGL.jpg',false),
  ]));
  const textures: CliffTextures = { rockColor, rockNormal, rockRoughness, dirtColor, dirtNormal };
  const field = await bootStage('Village: headland terrain', () => new VillageField(91,VILLAGE_PLOT.half,VILLAGE_PLOT.bottom));
  useSandLayerMaps(await bootStage('Village: sand layer maps', () => loadSandLayerMaps()));
  const island = await bootStage('Village: shore terrain surface', () => createIsland({ field, textures }));
  const maps = { map:rockColor, normalMap:rockNormal, roughnessMap:rockRoughness, aoMap:rockAo };
  const dry = createRockMaterial(maps,'dry');
  const wet = createRockMaterial(maps,'submerged');
  applyVillageHeadlandSurface(island.sand,dry);
  const kinds=['outcrop','rubble','reef','pebble'] as const;
  const batches:RockBatch[]=await bootStage('Village: shore rock variants', () => kinds.flatMap((kind,k)=>Array.from({length:3},(_,variant)=>{
    const geometry=createRockGeometry({seed:933+k*17+variant,radius:1,detail:kind==='outcrop'?31:kind==='pebble'?4:12,sharpness:kind==='pebble'?.25:.8});
    const box=geometry.boundingBox!;
    const center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());
    geometry.translate(-center.x,-center.y,-center.z);geometry.scale(2/size.x,2/size.y,2/size.z);
    geometry.computeBoundingBox();geometry.computeBoundingSphere();
    return {id:`${kind}-variant-${variant}`,parts:[{id:'stone',geometry,material:kind==='reef'?wet:dry}],instances:[]};
  })));
  await bootStage('Village: placing the shore rocks', () => villageRockLayout().forEach((r,i)=>{
    const ground=r.kind==='outcrop'?Math.min(field.height(r.x,r.z),field.height(r.x-r.sx*.8,r.z),field.height(r.x+r.sx*.8,r.z),field.height(r.x,r.z-r.sz*.8),field.height(r.x,r.z+r.sz*.8)):field.height(r.x,r.z);
    const y=ground+r.sy*r.buried;
    const batch=kinds.indexOf(r.kind)*3+i%3;
    batches[batch].instances.push({id:r.id,matrix:instanceTransform([r.x,y,r.z],[r.sx,r.sy,r.sz],[0,r.yaw,r.roll])});
    if(r.kind!=='pebble')field.addStamp(r.x,r.z,r.sx*.75,r.sz*.75,y+r.sy*.6);
  }));
  return { field, island, batches };
}
