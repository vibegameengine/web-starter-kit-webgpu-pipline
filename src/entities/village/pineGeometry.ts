import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { seededRandom } from '../../shared/lib/noise.ts';
import { instanceTransform, type PrefabPart } from '../../shared/fiber/index.ts';

function merged(pieces: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g=mergeGeometries(pieces);
  pieces.forEach(p=>p.dispose());
  return g;
}

export function pineParts(leafMaterial: THREE.Material): PrefabPart[] {
  const random=seededRandom(91021);
  const branches: THREE.BufferGeometry[]=[];
  const foliage: THREE.BufferGeometry[]=[];
  const path=(points:number[][],r:number)=>{
    const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p as [number,number,number])));
    branches.push(new THREE.TubeGeometry(curve,9,r,6,false));
  };
  path([[0,0,0],[.02,.26,.01],[-.045,.48,.035],[.045,.68,0],[.13,.89,.01]],.027);
  for(let arm=0;arm<9;arm++) {
    const angle=arm*Math.PI*2/9+.2;
    const radius=.68+random()*.22;
    const x=Math.cos(angle)*radius;
    const z=Math.sin(angle)*radius;
    path([[.025,.55,0],[x*.3,.75,z*.4],[x*.73,.86,z*.76],[x,.96,z]],.012);
    for(let fork=0;fork<5;fork++) {
      const a=angle+(fork-2)*.36;
      const r=radius*(.44+fork*.15);
      const tip=[Math.cos(a)*r,.91+.29*(1-Math.min(r,1)**2)+random()*.035,Math.sin(a)*r];
      path([[x*.56,.81,z*.56],[tip[0]*.8,tip[1]-.1,tip[2]*.8],tip],.005);
      for(let leaf=0;leaf<48;leaf++) {
        const t=random()*Math.PI*2;
        const rr=Math.sqrt(random())*.2;
        const geometry=new THREE.PlaneGeometry(1,1);
        geometry.applyMatrix4(instanceTransform([tip[0]+Math.cos(t)*rr,tip[1]+random()*.08,tip[2]+Math.sin(t)*rr],[.13+random()*.1,.08+random()*.06,1],[random()*Math.PI,random()*6,random()*6]));
        const c=new THREE.Color().setHSL(.19+random()*.025,.18+random()*.15,.45+random()*.15);
        geometry.setAttribute('color',new THREE.Float32BufferAttribute(Array.from({length:geometry.getAttribute('position').count},()=>c.toArray()).flat(),3));
        foliage.push(geometry);
      }
    }
  }
  return [
    {id:'branch-network',geometry:merged(branches),material:new THREE.MeshStandardNodeMaterial({color:'#786047',roughness:.94})},
    {id:'needle-crown',geometry:merged(foliage),material:leafMaterial},
  ];
}
