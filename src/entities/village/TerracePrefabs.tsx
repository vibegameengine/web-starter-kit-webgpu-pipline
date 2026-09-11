import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { MultiInstances, instanceTransform } from '../../shared/fiber/index.ts';
import { useVillageMaterials } from './materials.tsx';
import { VILLAGE_STAIRS, VILLAGE_TERRACES } from './layout.ts';
import { seededRandom } from '../../shared/lib/noise.ts';

function masonryStone() {
  const geometry=new RoundedBoxGeometry(1,1,1,2,.065);
  const positions=geometry.getAttribute('position');
  for(let i=0;i<positions.count;i++) {
    const x=positions.getX(i),y=positions.getY(i),z=positions.getZ(i);
    const wear=Math.sin(x*19+y*31+z*23)*Math.sin(x*37-y*13+z*29)*.015;
    positions.setXYZ(i,x*(1+wear),y*(1+wear),z*(1+wear*2));
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function TerraceSteps() {
  const materials=useVillageMaterials();
  const parts=useMemo(()=>[{id:'limestone-step',geometry:new THREE.BoxGeometry(1,1,1),material:materials.limestone}],[materials]);
  const steps=useMemo(()=>VILLAGE_STAIRS.flatMap(s=>Array.from({length:s.count},(_,i)=>{
    const top=s.bottom+(s.top-s.bottom)*(i+1)/s.count;
    const footing=.08;
    return {id:`${s.id}-${i}`,matrix:instanceTransform([s.x,(top+footing)/2,s.z-i*s.run/s.count],[s.width,top-footing,s.run/s.count+.03])};
  })),[]);
  const facingParts=useMemo(()=>[{id:'stair-facing-stone',geometry:masonryStone(),material:materials.limestone,tint:true}],[materials]);
  const facing=useMemo(()=>VILLAGE_STAIRS.flatMap(s=>Array.from({length:s.count},(_,i)=>{
    const top=s.bottom+(s.top-s.bottom)*(i+1)/s.count;
    const count=Math.max(1,Math.ceil((top-.08)/.3));
    const course=(top-.08)/count;
    return [-1,1].flatMap(side=>Array.from({length:count},(_,row)=>({
      id:`${s.id}-side-${side}-${i}-${row}`,
      matrix:instanceTransform([s.x+side*(s.width/2+.026),.08+(row+.5)*course,s.z-i*s.run/s.count],[.11,course-.018,s.run/s.count-.014]),
      color:new THREE.Color().setHSL(.105,.16,.77+.1*Math.sin(i*9+row*13)),
    })));
  }).flat()),[]);
  const risers=useMemo(()=>VILLAGE_STAIRS.flatMap(s=>Array.from({length:s.count},(_,i)=>{
    const top=s.bottom+(s.top-s.bottom)*(i+1)/s.count;
    const exposedBottom=i===0?.08:s.bottom+(s.top-s.bottom)*i/s.count;
    const courses=Math.max(1,Math.ceil((top-exposedBottom)/.28));
    const course=(top-exposedBottom)/courses;
    const columns=Math.ceil(s.width/.52);
    const width=s.width/columns;
    return Array.from({length:courses},(_,row)=>Array.from({length:columns},(_,column)=>({
      id:`${s.id}-riser-${i}-${row}-${column}`,
      matrix:instanceTransform([s.x-s.width/2+(column+.5)*width,exposedBottom+(row+.5)*course,s.z-i*s.run/s.count+s.run/s.count/2+.025],[width-.018,course-.012,.08]),
      color:new THREE.Color().setHSL(.105,.14,.8+.08*Math.sin(column*7+i*3+row*9)),
    }))).flat();
  }).flat()),[]);
  return <group name="terrace-stairs">
    <MultiInstances name="stair-cores" parts={parts} instances={steps}/>
    <MultiInstances name="stair-side-masonry" parts={facingParts} instances={facing}/>
    <MultiInstances name="stair-riser-masonry" parts={facingParts} instances={risers}/>
  </group>;
}

export function QuayMasonry() {
  const materials=useVillageMaterials();
  const parts=useMemo(()=>[{id:'limestone-block',geometry:masonryStone(),material:materials.limestone,tint:true}],[materials]);
  const blocks=useMemo(()=>{
    const list=[];
    const random=seededRandom(7741);
    for(const t of VILLAGE_TERRACES) {
      let bottom=-.8,row=0;
      while(bottom<t.top-.03) {
        const course=Math.min(.25+random()*.13,t.top-bottom);
        const y=bottom+course/2;
        for(let x=t.x0;x<t.x1-.04;) {
          const width=Math.min(.37+random()*.42,t.x1-x);
          const cx=x+width/2;
          const archOverlap=t.id==='pine-terrace'&&x< -5.98&&x+width> -7.62&&y>.12&&y<2.22;
          if(!archOverlap)list.push({id:`${t.id}-front-${row}-${x}`,matrix:instanceTransform([cx,y,t.z1+.055],[width-.022,course-.021,.15+random()*.035],[0,0,(random()-.5)*.018])});
          x+=width;
        }
        for(let z=t.z0;z<t.z1-.04;) {
          const width=Math.min(.37+random()*.42,t.z1-z);
          list.push({id:`${t.id}-side-${row}-${z}`,matrix:instanceTransform([t.x1+.045,y,z+width/2],[.16,course-.021,width-.022],[(random()-.5)*.018,0,0])});
          z+=width;
        }
        bottom+=course;row++;
      }
      for(let x=t.x0+.3;x<t.x1-.1;x+=.62)list.push({id:`${t.id}-coping-${x}`,matrix:instanceTransform([x,t.top+.045,t.z1],[.6,.16,.45])});
    }
    return list.map((instance,i)=>({...instance,color:new THREE.Color().setHSL(.1+(i%7)*.003,.12+(i%5)*.025,.72+(Math.sin(i*3.14)+1)*.13)}));
  },[]);
  return <MultiInstances name="masonry-courses" parts={parts} instances={blocks}/>;
}

export function QuayPaving() {
  const {limestone}=useVillageMaterials();
  const parts=useMemo(()=>[{id:'worn-paving-stone',geometry:new RoundedBoxGeometry(1,1,1,2,.04),material:limestone,tint:true}],[limestone]);
  const instances=useMemo(()=>VILLAGE_TERRACES.flatMap(t=>{
    const stones=[];
    for(let z=t.z0+.27;z<t.z1-.2;z+=.55)for(let x=t.x0+.36;x<t.x1-.2;x+=.75) {
      const shade=.91+.07*Math.sin(x*43+z*23);
      stones.push({id:`${t.id}-paver-${x}-${z}`,matrix:instanceTransform([x,t.top+.007,z],[.73,.045,.53],[0,Math.sin(x*51+z)*.012,0]),color:new THREE.Color(shade,shade*.985,shade*.96)});
    }
    return stones;
  }),[]);
  return <MultiInstances name="quay-paving" parts={parts} instances={instances}/>;
}
