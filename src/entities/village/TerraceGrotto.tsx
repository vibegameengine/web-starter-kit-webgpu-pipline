import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { MultiInstances, instanceTransform } from '../../shared/fiber/index.ts';
import { useVillageMaterials } from './materials.tsx';
import { VILLAGE_PLOT } from './layout.ts';

export function TerraceGrotto() {
  const {limestone}=useVillageMaterials();
  const parts=useMemo(()=>{
    const shape=new THREE.Shape();
    shape.moveTo(-2.55,VILLAGE_PLOT.bottom);shape.lineTo(1.8,VILLAGE_PLOT.bottom);shape.lineTo(1.8,2.9);shape.lineTo(-2.55,2.9);shape.closePath();
    const hole=new THREE.Path();
    hole.moveTo(-.57,.32);hole.lineTo(-.57,1.43);hole.absarc(0,1.43,.57,Math.PI,0,true);hole.lineTo(.57,.32);hole.closePath();
    shape.holes.push(hole);
    return [
      {id:'vaulted-front',geometry:new THREE.ExtrudeGeometry(shape,{depth:.64,bevelEnabled:false,curveSegments:20}),material:limestone,matrix:instanceTransform([0,0,-.64])},
      {id:'terrace-core',geometry:new THREE.BoxGeometry(4.35,2.9-VILLAGE_PLOT.bottom,6.63),material:limestone,matrix:instanceTransform([-.375,(2.9+VILLAGE_PLOT.bottom)/2,-3.985])},
      {id:'threshold',geometry:new THREE.BoxGeometry(1.14,.12,.65),material:limestone,matrix:instanceTransform([0,.29,-.3])},
    ];
  },[limestone]);
  const instance=useMemo(()=>[{id:'pine-terrace-vault',matrix:instanceTransform([-6.8,0,-2.7])}],[]);
  const wedges=useMemo(()=>[{id:'arch-voussoir',geometry:new THREE.BoxGeometry(.23,.27,.19),material:limestone}],[limestone]);
  const arch=useMemo(()=>Array.from({length:11},(_,i)=>{const a=i/10*Math.PI;return {id:`vault-arch-stone-${i}`,matrix:instanceTransform([-6.8+Math.cos(a)*.7,1.43+Math.sin(a)*.7,-2.62],[1,1,1],[0,0,a-Math.PI/2])};}),[]);
  return <group name="terrace-grotto"><MultiInstances name="pine-terrace-vault" parts={parts} instances={instance}/><MultiInstances name="vault-arch-masonry" parts={wedges} instances={arch}/></group>;
}
