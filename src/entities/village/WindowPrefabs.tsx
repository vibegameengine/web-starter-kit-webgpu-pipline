import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MultiInstances, instanceTransform, type PrefabPart, type PrefabInstance } from '../../shared/fiber/index.ts';
import { VILLAGE_HOUSES } from './layout.ts';
import { archedDoorLeaf, archedDoorSurround, usesArchedEntry } from './doorGeometry.ts';

function boxes(parts: number[][]): THREE.BufferGeometry {
  const pieces = parts.map(([x,y,z,w,h,d]) => new THREE.BoxGeometry(w,h,d).translate(x,y,z));
  const result = mergeGeometries(pieces);
  pieces.forEach(piece=>piece.dispose());
  return result;
}

function windowParts(shutter: string): PrefabPart[] {
  const frame = boxes([[-.29,0,0,.075,1.04,.095],[.29,0,0,.075,1.04,.095],[0,.5,0,.65,.08,.095],[0,-.5,.025,.7,.09,.18]]);
  const shutterPieces = [-1,1].flatMap(side=>[
    [side*.43,0,.04,.21,1,.07],
    ...Array.from({length:11},(_,i)=>[side*.43,-.425+i*.082,.092,.18,.032,.045]),
  ]);
  return [
    {id:'limestone-surround',geometry:frame,material:new THREE.MeshStandardNodeMaterial({color:'#ede2c3',roughness:.9})},
    {id:'recess',geometry:new THREE.BoxGeometry(.55,.98,.035),material:new THREE.MeshStandardNodeMaterial({color:'#263931',roughness:.82}),matrix:instanceTransform([0,0,-.16])},
    {id:'shutters',geometry:boxes(shutterPieces),material:new THREE.MeshStandardNodeMaterial({color:shutter,roughness:.78})},
    {id:'mullions',geometry:boxes([[0,0,-.108,.025,.91,.04],[0,0,-.105,.5,.025,.04]]),material:new THREE.MeshStandardNodeMaterial({color:'#cab897',roughness:.82})},
  ];
}

export function VillageWindows() {
  const batches = useMemo(()=>['#366d55','#2c7b93'].map((tint,group)=>{
    const instances: PrefabInstance[]=[];
    VILLAGE_HOUSES.filter(h=>(h.id==='yellow-house'||h.id==='coral-house'||h.id==='rear-house')===(group===0)).forEach(h=>{
      const upper=h.height-1.25;
      const frontage=[-h.width*.25,h.width*.25];
      frontage.forEach((x,i)=>instances.push({id:`${h.id}-front-upper-${i}`,matrix:instanceTransform([h.x+x,h.base+upper,h.z+h.depth/2+.055])}));
      for(const side of [-1,1]) {
        instances.push({id:`${h.id}-side-upper-${side}`,matrix:instanceTransform([h.x+side*(h.width/2+.055),h.base+upper,h.z],[.85,1,1],[0,side*Math.PI/2,0])});
      }
      if(h.id!=='blue-cafe') instances.push({id:`${h.id}-lower-window`,matrix:instanceTransform([h.x-h.width*.25,h.base+1.35,h.z+h.depth/2+.06],[.8,.95,1])});
      frontage.forEach((x,i)=>instances.push({id:`${h.id}-rear-upper-${i}`,matrix:instanceTransform([h.x+x,h.base+upper,h.z-h.depth/2-.055],[.8,.9,1],[0,Math.PI,0])}));
    });
    return {name:`${group?'blue':'green'}-shutter-windows`,parts:windowParts(tint),instances};
  }),[]);
  return <group name="window-prefabs">{batches.map(batch=><MultiInstances key={batch.name} {...batch}/>)}</group>;
}

export function VillageDoors() {
  const parts = useMemo(()=>[
    {id:'stone-frame',geometry:boxes([[-.37,.8,0,.12,1.6,.13],[.37,.8,0,.12,1.6,.13],[0,1.57,0,.85,.14,.15],[0,.025,.08,.9,.05,.36]]),material:new THREE.MeshStandardNodeMaterial({color:'#ded1b0',roughness:.9})},
    {id:'timber-door',geometry:new THREE.BoxGeometry(.62,1.5,.075).translate(0,.76,-.205),material:new THREE.MeshStandardNodeMaterial({color:'#38645a',roughness:.8})},
    {id:'panel-rails',geometry:boxes([[-.25,.75,-.156,.034,1.36,.035],[.25,.75,-.156,.034,1.36,.035],[0,.25,-.156,.5,.032,.035],[0,.82,-.156,.5,.032,.035],[0,1.35,-.156,.5,.032,.035]]),material:new THREE.MeshStandardNodeMaterial({color:'#567c68',roughness:.78})},
    {id:'handle',geometry:new THREE.SphereGeometry(.035,8,6).translate(.19,.77,-.12),material:new THREE.MeshStandardNodeMaterial({color:'#5d482b',metalness:.65,roughness:.45})},
  ],[]);
  const archedParts=useMemo(()=>[
    {...parts[0],id:'arch-stone-surround',geometry:archedDoorSurround()},
    {...parts[1],id:'arched-timber-door',geometry:archedDoorLeaf()},
    {...parts[2],geometry:boxes([[-.25,.65,-.156,.034,1.16,.035],[.25,.65,-.156,.034,1.16,.035],[0,.25,-.156,.5,.032,.035],[0,.82,-.156,.5,.032,.035],[0,1.22,-.156,.5,.032,.035],[0,1.39,-.156,.025,.28,.035]])},
    parts[3],
  ],[parts]);
  const batches=useMemo(()=>[false,true].map(arched=>({arched,instances:VILLAGE_HOUSES.filter(h=>h.id!=='blue-cafe'&&usesArchedEntry(h.id)===arched).map(h=>({id:`${h.id}-entry`,matrix:instanceTransform([h.x+h.width*.23,h.base+.04,h.z+h.depth/2+.1],[1.3,1.3,1])}))})),[]);
  return <group name="entry-prefabs">{batches.map(batch=><MultiInstances key={String(batch.arched)} name={batch.arched?'arched-entries':'straight-entries'} parts={batch.arched?archedParts:parts} instances={batch.instances}/>)}</group>;
}
