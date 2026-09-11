import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { seededRandom } from '../../shared/lib/noise.ts';
import { MultiInstances, instanceTransform } from '../../shared/fiber/index.ts';
import { useVillageMaterials } from './materials.tsx';

export function CypressPrefab() {
  const {foliage:foliageMaterials}=useVillageMaterials();
  const parts=useMemo(()=>{
    const random=seededRandom(9287);
    const pieces:THREE.BufferGeometry[]=[];
    for(let i=0;i<780;i++) {
      const y=.08+random()*.91;
      const radius=Math.sin(y*Math.PI)**.6*.17*(.5+random()*.5);
      const a=i*2.399;
      const g=new THREE.PlaneGeometry(.2,.18);
      g.applyMatrix4(instanceTransform([Math.cos(a)*radius,y,Math.sin(a)*radius],[.7+random()*.5,.7+random()*.5,1],[random()*.8,a,random()*.7]));
      pieces.push(g);
    }
    const foliage=mergeGeometries(pieces);pieces.forEach(g=>g.dispose());
    return [
      {id:'tapered-trunk',geometry:new THREE.CylinderGeometry(.008,.028,.85,7).translate(0,.425,0),material:new THREE.MeshStandardNodeMaterial({color:'#716044',roughness:.94})},
      {id:'dense-needle-sprays',geometry:foliage,material:foliageMaterials.cypress},
    ];
  },[foliageMaterials.cypress]);
  const instances=useMemo(()=>[[-2.9,-8.9,6.7],[2.2,-8.9,7.1],[5.9,-7.3,5.3]].map(([x,z,h],i)=>({id:`cypress-${i}`,matrix:instanceTransform([x,2.9,z],[2.2,h,2.2],[0,i*1.2,0])})),[]);
  return <MultiInstances name="cypresses" parts={parts} instances={instances}/>;
}
