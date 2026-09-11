import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { MultiInstances, StaticGroup, instanceTransform } from '../../shared/fiber/index.ts';
import { useVillageMaterials } from './materials.tsx';

export function HarborDetails() {
  const {limestone}=useVillageMaterials();
  const metal=useMemo(()=>new THREE.MeshStandardNodeMaterial({color:'#414239',metalness:.55,roughness:.72}),[]);
  const propMetal=useMemo(()=>new THREE.MeshStandardNodeMaterial({color:'#414239',metalness:.55,roughness:.72}),[]);
  const timber=useMemo(()=>new THREE.MeshStandardNodeMaterial({color:'#8a603c',roughness:.9}),[]);
  const balconyParts=useMemo(()=>[
    {id:'stone-floor',geometry:new THREE.BoxGeometry(3.12,.13,.74),material:limestone,matrix:instanceTransform([0,0,0])},
    {id:'top-rail',geometry:new THREE.BoxGeometry(3.08,.035,.04),material:metal,matrix:instanceTransform([0,.86,.31])},
    {id:'bottom-rail',geometry:new THREE.BoxGeometry(3.08,.03,.035),material:metal,matrix:instanceTransform([0,.14,.31])},
  ],[limestone,metal]);
  const balcony=useMemo(()=>[{id:'yellow-balcony',matrix:instanceTransform([-3.2,4.5,-3.73])}],[]);
  const bars=useMemo(()=>[{id:'iron-baluster',geometry:new THREE.CylinderGeometry(.012,.012,.82,6),material:metal}],[metal]);
  const balusters=useMemo(()=>Array.from({length:17},(_,i)=>({id:`balcony-upright-${i}`,matrix:instanceTransform([-4.68+i*.185,4.95,-3.42])})),[]);
  const bollardParts=useMemo(()=>[
    {id:'base',geometry:new THREE.CylinderGeometry(.19,.22,.07,12),material:metal},
    {id:'post',geometry:new THREE.CylinderGeometry(.08,.13,.28,12),material:metal,matrix:instanceTransform([0,.16,0])},
    {id:'cap',geometry:new THREE.CylinderGeometry(.14,.1,.1,12),material:metal,matrix:instanceTransform([0,.34,0])},
  ],[metal]);
  const bollards=useMemo(()=>[3.2,5.35,7.5,9.35].map((x,i)=>({id:`quay-bollard-${i}`,matrix:instanceTransform([x,1.63,1.07])})),[]);
  const rope=useMemo(()=>new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(.1,.37,3.8),new THREE.Vector3(1.1,-.08,2.8),new THREE.Vector3(2.5,.35,1.5),new THREE.Vector3(3.2,1.85,1.07)]),32,.012,5,false),[]);
  return <group name="harbor-details">
    <MultiInstances name="balcony" parts={balconyParts} instances={balcony}/>
    <MultiInstances name="balcony-balusters" parts={bars} instances={balusters}/>
    <MultiInstances name="mooring-bollards" parts={bollardParts} instances={bollards}/>
    <StaticGroup name="harbor-props" lightmap={false}>
      <mesh geometry={rope}><meshStandardMaterial color="#9c8b64" roughness={.95}/></mesh>
      {[-1,1].map(side=><mesh key={side} position={[-3.2+side*1.3,4.19,-3.76]} rotation={[.65,0,0]} material={propMetal}><boxGeometry args={[.055,.7,.065]}/></mesh>)}
      {[5.15,8.7].map(x=><mesh key={x} position={[x,.75,1.4]}><torusGeometry args={[.2,.048,8,24]}/><meshStandardMaterial color="#353732" roughness={.8}/></mesh>)}
      <mesh position={[-4.1,.07,3.3]}><sphereGeometry args={[.28,16,12]}/><meshStandardMaterial color="#d47838" roughness={.65}/></mesh>
      <mesh position={[-.5,.02,5.3]}><sphereGeometry args={[.12,12,8]}/><meshStandardMaterial color="#d5c8a2" roughness={.65}/></mesh>
      <group position={[3.8,1.5,.35]}>
        {[-.55,.55].map(x=><mesh key={x} position={[x,.23,0]} material={propMetal}><boxGeometry args={[.065,.46,.36]}/></mesh>)}
        {[-.16,0,.16].map(z=><mesh key={z} position={[0,.48,z]} material={timber}><boxGeometry args={[1.45,.065,.135]}/></mesh>)}
        {[.65,.8,.95].map(y=><mesh key={y} position={[0,y,-.2]} material={timber}><boxGeometry args={[1.45,.115,.045]}/></mesh>)}
        {[-.58,.58].map(x=><mesh key={x} position={[x,.73,-.23]} material={propMetal}><boxGeometry args={[.04,.53,.04]}/></mesh>)}
      </group>
      {[2.9,9.1].map(x=><group key={x} position={[x,1.5,-.45]}>
        <mesh position={[0,1.23,0]} material={propMetal}><cylinderGeometry args={[.026,.048,2.46,8]}/></mesh>
        <mesh position={[0,2.55,0]}><boxGeometry args={[.19,.3,.19]}/><meshStandardMaterial color="#d6c8a0" roughness={.45}/></mesh>
        <mesh position={[0,2.76,0]} material={propMetal}><coneGeometry args={[.2,.15,4]}/></mesh>
        {[-1,1].flatMap(a=>[-1,1].map(b=><mesh key={`${a}-${b}`} position={[a*.1,2.55,b*.1]} material={propMetal}><boxGeometry args={[.018,.34,.018]}/></mesh>))}
      </group>)}
    </StaticGroup>
  </group>;
}
