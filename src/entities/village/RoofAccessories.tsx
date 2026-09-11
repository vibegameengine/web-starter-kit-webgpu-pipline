import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { MultiInstances, instanceTransform, type PrefabInstance } from '../../shared/fiber/index.ts';
import { useVillageMaterials } from './materials.tsx';
import { VILLAGE_HOUSES } from './layout.ts';

export function RoofAccessories() {
  const {limestone,terracotta}=useVillageMaterials();
  const ridges=useMemo(()=>[{id:'ridge-cap',geometry:new THREE.CylinderGeometry(.1,.115,.35,10,1,true,Math.PI/2,Math.PI).rotateX(Math.PI/2),material:new THREE.MeshStandardNodeMaterial({map:terracotta,roughness:.94})}],[terracotta]);
  const ridgeInstances=useMemo(()=>VILLAGE_HOUSES.flatMap(h=>{
    const length=h.hip?Math.max(.35,h.width-h.depth*.84):h.depth+.3;
    return Array.from({length:Math.ceil(length/.3)},(_,i)=>{const offset=-length/2+.15+i*.3;return {id:`${h.id}-ridge-${i}`,matrix:instanceTransform([h.x+(h.hip?offset:0),h.base+h.height+h.roofRise+.03,h.z+(h.hip?0:offset)],[1,1,1],[0,h.hip?Math.PI/2:0,0])};});
  }),[]);
  const chimneyParts=useMemo(()=>[
    {id:'limewashed-stack',geometry:new THREE.BoxGeometry(.36,.7,.38).translate(0,.35,0),material:limestone},
    {id:'upper-ledge',geometry:new THREE.BoxGeometry(.47,.085,.49).translate(0,.73,0),material:limestone},
    {id:'cap',geometry:new THREE.BoxGeometry(.49,.09,.51).translate(0,1.01,0),material:limestone},
    ...[-1,1].flatMap(x=>[-1,1].map(z=>({id:`vent-post-${x}-${z}`,geometry:new THREE.BoxGeometry(.075,.2,.075).translate(x*.16,.875,z*.17),material:limestone}))),
  ],[limestone]);
  const chimneys=useMemo(()=>[
    {id:'rear-house-chimney',matrix:instanceTransform([.1,7.95,-7.9])},
    {id:'yellow-house-chimney',matrix:instanceTransform([-4.15,7.1,-6.65])},
    {id:'cafe-chimney',matrix:instanceTransform([8.6,6.53,-3.95],[.75,.8,.75])},
  ],[]);
  const pipeParts=useMemo(()=>[{id:'weathered-copper-pipe',geometry:new THREE.CylinderGeometry(.031,.031,1,8),material:new THREE.MeshStandardNodeMaterial({color:'#647066',metalness:.45,roughness:.72})}],[]);
  const pipes=useMemo(()=>VILLAGE_HOUSES.map(h=>({id:`${h.id}-downpipe`,matrix:instanceTransform([h.x+h.width/2+.045,h.base+h.height/2,h.z+h.depth/2-.09],[1,h.height,1])})),[]);
  const gutters=useMemo(()=>VILLAGE_HOUSES.flatMap(h=>{
    const items:PrefabInstance[]=[];
    for(const side of [-1,1])items.push({id:`${h.id}-gutter-${side}`,matrix:instanceTransform([h.x+(h.hip?0:side*(h.width/2+.1)),h.base+h.height-.05,h.z+(h.hip?side*(h.depth/2+.12):0)],[1,h.hip?h.width+.15:h.depth+.15,1],h.hip?[0,0,Math.PI/2]:[Math.PI/2,0,0])});
    return items;
  }),[]);
  return <group name="roof-accessories">
    <MultiInstances name="terracotta-ridge-caps" parts={ridges} instances={ridgeInstances}/>
    <MultiInstances name="chimney-prefabs" parts={chimneyParts} instances={chimneys}/>
    <MultiInstances name="facade-downpipes" parts={pipeParts} instances={pipes}/>
    <MultiInstances name="eaves-gutters" parts={pipeParts} instances={gutters}/>
  </group>;
}
