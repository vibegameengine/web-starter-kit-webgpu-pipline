import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { MultiInstances, StaticGroup, instanceTransform } from '../../shared/fiber/index.ts';
import { useVillageMaterials } from './materials.tsx';

export function BellTowerPrefab() {
  const {limestone}=useVillageMaterials();
  const arch=useMemo(()=>{
    const shape=new THREE.Shape();
    shape.moveTo(-.72,0);shape.lineTo(.72,0);shape.lineTo(.72,1.95);shape.lineTo(-.72,1.95);shape.closePath();
    const hole=new THREE.Path();
    hole.moveTo(-.43,.16);hole.lineTo(-.43,1.15);hole.absarc(0,1.15,.43,Math.PI,0,true);hole.lineTo(.43,.16);hole.closePath();
    shape.holes.push(hole);
    return new THREE.ExtrudeGeometry(shape,{depth:.18,bevelEnabled:true,bevelSize:.025,bevelThickness:.025,bevelSegments:2,curveSegments:16});
  },[]);
  const arcade=useMemo(()=>[{id:'arched-wall',geometry:arch,material:limestone}],[arch,limestone]);
  const corniceParts=useMemo(()=>[{id:'stone-cornice',geometry:new THREE.BoxGeometry(1,1,1),material:limestone}],[limestone]);
  const cornices=useMemo(()=>[.2,3.95,6.05,6.22].map((y,i)=>({id:`tower-cornice-${i}`,matrix:instanceTransform([0,y,0],[i===3?1.72:1.6,.14,i===3?1.72:1.6])})),[]);
  const faces=useMemo(()=>Array.from({length:4},(_,i)=>({id:`belfry-face-${i}`,matrix:instanceTransform([Math.sin(i*Math.PI/2)*.66,4.05,Math.cos(i*Math.PI/2)*.66],[1,1,1],[0,i*Math.PI/2,0])})),[]);
  const bell=useMemo(()=>new THREE.LatheGeometry([[.08,.8],[.15,.74],[.19,.55],[.24,.29],[.38,.1],[.4,.02],[.32,0],[.22,.22]].map(p=>new THREE.Vector2(p[0],p[1])),24),[]);
  return <StaticGroup name="bell-tower" position={[4.1,2.9,-8.35]} lightmap={false}>
    <mesh position={[0,2,0]}><boxGeometry args={[1.3,4,1.3]}/><meshStandardMaterial color="#e0cfaa" roughness={.9}/></mesh>
    <MultiInstances name="belfry-arcades" parts={arcade} instances={faces}/>
    <MultiInstances name="tower-cornices" parts={corniceParts} instances={cornices}/>
    <mesh name="bronze-bell" position={[0,4.5,0]} geometry={bell}><meshStandardMaterial color="#776044" metalness={.65} roughness={.55}/></mesh>
    <mesh position={[0,5.4,0]}><boxGeometry args={[1.05,.12,.17]}/><meshStandardMaterial color="#634732" roughness={.9}/></mesh>
    <mesh position={[0,4.45,0]}><sphereGeometry args={[.065,10,8]}/><meshStandardMaterial color="#423323" metalness={.5} roughness={.5}/></mesh>
    <mesh name="cupola" position={[0,6.3,0]} scale={[1,.82,1]}><sphereGeometry args={[.74,24,12,0,Math.PI*2,0,Math.PI/2]}/><meshStandardMaterial color="#b56d46" roughness={.86}/></mesh>
    <mesh position={[0,7.13,0]}><boxGeometry args={[.035,.65,.035]}/><meshStandardMaterial color="#504739" metalness={.5} roughness={.5}/></mesh>
    <mesh position={[0,7.23,0]}><boxGeometry args={[.3,.035,.035]}/><meshStandardMaterial color="#504739" metalness={.5} roughness={.5}/></mesh>
  </StaticGroup>;
}
