import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { MultiInstances, instanceTransform, type PrefabInstance } from '../../shared/fiber/index.ts';
import { VILLAGE_HOUSES } from './layout.ts';
import { useVillageMaterials } from './materials.tsx';

export function RoofTiles() {
  const {terracotta}=useVillageMaterials();
  const parts=useMemo(()=>{
    const geometry=new THREE.CylinderGeometry(.061,.07,.24,8,1,true,Math.PI/2,Math.PI).rotateX(Math.PI/2);
    return [{id:'terracotta-pan',geometry,material:new THREE.MeshStandardNodeMaterial({map:terracotta,color:'#fff1dc',roughness:.91}),tint:true}];
  },[terracotta]);
  const instances=useMemo(()=>{
    const tiles: PrefabInstance[]=[];
    VILLAGE_HOUSES.forEach(h=>{
      const halfW=(h.width+.3)/2;
      const halfD=(h.depth+.3)/2;
      const rise=h.roofRise;
      const ridge=h.hip?Math.max(0,halfW-halfD*.84):halfW;
      for(let x=-halfW+.07;x<halfW-.025;x+=.137)for(let z=-halfD+.105;z<halfD;z+=.195) {
        const frontHeight=h.hip?rise*(1-Math.abs(z)/halfD):Infinity;
        const sideHeight=h.hip?rise*Math.min(1,(halfW-Math.abs(x))/(halfW-ridge)):rise*(1-Math.abs(x)/halfW);
        const y=Math.min(frontHeight,sideHeight);
        const side=sideHeight<frontHeight;
        const rotation=side?[0,Math.sign(x)*Math.PI/2,0]:[Math.sign(z)*Math.atan(rise/halfD),0,0];
        const matrix=instanceTransform([h.x+x,h.base+h.height+y+.025,h.z+z],[1,1,1],rotation);
        if(side)matrix.multiply(new THREE.Matrix4().makeRotationX(Math.atan(rise/(h.hip?halfW-ridge:halfW))));
        const shade=.84+.14*Math.sin(x*71+z*97);
        tiles.push({id:`${h.id}-tile-${tiles.length}`,matrix,color:new THREE.Color(shade,shade*.94,shade*.85)});
      }
    });
    return tiles;
  },[]);
  return <MultiInstances name="terracotta-roof-tiles" parts={parts} instances={instances}/>;
}
