import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { seededRandom } from '../../shared/lib/noise.ts';
import { MultiInstances, instanceTransform, type PrefabPart } from '../../shared/fiber/index.ts';
import { useVillageMaterials } from './materials.tsx';

function foliageParts(hanging: boolean, flowerMaterial: THREE.Material, leafMaterial: THREE.Material): PrefabPart[] {
  const random=seededRandom(hanging?194:193);
  const leaves:THREE.BufferGeometry[]=[];
  const petals:THREE.BufferGeometry[]=[];
  const stems:THREE.BufferGeometry[]=[];
  const spray=new THREE.PlaneGeometry(1,1,2,2);
  const sprayPositions=spray.getAttribute('position');
  for(let i=0;i<sprayPositions.count;i++) sprayPositions.setZ(i,.11*Math.sin(sprayPositions.getX(i)*Math.PI));
  spray.computeVertexNormals();
  for(let arm=0;arm<16;arm++) {
    const a=arm*2.399;
    const tip=new THREE.Vector3(Math.cos(a)*(.3+random()*.35),hanging?-.2-random()*.9:.75+random()*.65,Math.sin(a)*(.2+random()*.3));
    const start=new THREE.Vector3(0,hanging?0:.4,0);
    const mid=start.clone().lerp(tip,.55).add(new THREE.Vector3(0,.2,0));
    stems.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([start,mid,tip]),5,.014,5,false));
    for(let i=0;i<26;i++) {
      const center=start.clone().lerp(tip,.35+random()*.65);
      center.x+=(random()-.5)*.3;center.z+=(random()-.5)*.3;center.y+=(random()-.5)*.22;
      if(i%3===0) {
        const size=.28+random()*.08;
        const g=spray.clone().applyMatrix4(instanceTransform(center.toArray(),[size,size,size],[random()*Math.PI,random()*Math.PI*2,random()*Math.PI*2]));
        const shade=.85+random()*.15;
        const c=new THREE.Color(shade,shade,shade*.95);
        g.setAttribute('color',new THREE.Float32BufferAttribute(Array.from({length:g.getAttribute('position').count},()=>c.toArray()).flat(),3));leaves.push(g);
      }
      if(i%4===0) {
        const size=.22+random()*.14;
        const g=spray.clone().applyMatrix4(instanceTransform(center.toArray(),[size,size,size],[random()*Math.PI,random()*Math.PI*2,random()*Math.PI*2]));
        const c=new THREE.Color().setRGB(.78+random()*.2,.78+random()*.2,.78+random()*.2);
        g.setAttribute('color',new THREE.Float32BufferAttribute(Array.from({length:g.getAttribute('position').count},()=>c.toArray()).flat(),3));petals.push(g);
      }
    }
  }
  const merge=(pieces:THREE.BufferGeometry[])=>{const result=mergeGeometries(pieces);pieces.forEach(p=>p.dispose());return result;};
  spray.dispose();
  return [
    {id:'woody-branches',geometry:merge(stems),material:new THREE.MeshStandardNodeMaterial({color:'#66513a',roughness:.94})},
    {id:'green-leaf-twigs',geometry:merge(leaves),material:leafMaterial},
    {id:'bougainvillea-sprays',geometry:merge(petals),material:flowerMaterial},
  ];
}

export function PlantingPrefab() {
  const {foliage}=useVillageMaterials();
  const pots=useMemo(()=>{
    const geometry=new THREE.LatheGeometry([[.12,0],[.16,.035],[.21,.13],[.26,.38],[.3,.49],[.3,.54],[.255,.55],[.25,.48],[.22,.43]].map(p=>new THREE.Vector2(p[0],p[1])),20);
    return [
      {id:'terracotta-pot',geometry,material:new THREE.MeshStandardNodeMaterial({color:'#b96d3e',roughness:.93}),tint:true},
      {id:'soil',geometry:new THREE.CylinderGeometry(.245,.245,.025,18).translate(0,.445,0),material:new THREE.MeshStandardNodeMaterial({color:'#483b27',roughness:1})},
    ];
  },[]);
  const plants=useMemo(()=>foliageParts(false,foliage.bougainvilleaFlowers,foliage.bougainvilleaLeaves),[foliage]);
  const vines=useMemo(()=>foliageParts(true,foliage.bougainvilleaFlowers,foliage.bougainvilleaLeaves),[foliage]);
  const potInstances=useMemo(()=>[
    [9.1,1.5,.05,1.2],[8.95,1.5,-1.3,.9],[5.85,1.5,-1.2,.75],[-.7,1.5,-1.5,.8],
    [-2.2,1.95,-3.65,.7],[-4.4,1.95,-3.55,1],[-5.75,2.9,-2.95,1.1],[-7.2,2.9,-2.95,.8],[-8.05,2.9,-4.7,.9],
  ].map(([x,y,z,s],i)=>({id:`flower-pot-${i}`,matrix:instanceTransform([x,y,z],[s,s,s],[0,i*1.7,0]),color:i%3===0?'#d1b994':'#ffffff'})),[]);
  const vineInstances=useMemo(()=>[
    [-1.95,4.35,-3.9,1.5],[-1.6,3.55,-3.3,1.15],[8.95,4.4,-1.43,1.3],[9.4,3.4,-2.35,1.2],
    [3.8,3.45,-3.95,1.3],[-5.05,2.9,-2.65,1.2],[-7.8,3.05,-2.6,1.15],
  ].map(([x,y,z,s],i)=>({id:`climbing-flower-${i}`,matrix:instanceTransform([x,y,z],[s,s,s],[0,i*.7,0])})),[]);
  return <group name="village-planting">
    <MultiInstances name="terracotta-planters" parts={pots} instances={potInstances}/>
    <MultiInstances name="potted-bougainvillea" parts={plants} instances={potInstances}/>
    <MultiInstances name="climbing-bougainvillea" parts={vines} instances={vineInstances}/>
  </group>;
}
