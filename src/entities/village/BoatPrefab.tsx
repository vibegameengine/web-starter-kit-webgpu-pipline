import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { StaticGroup } from '../../shared/fiber/index.ts';

function hullGeometry() {
  const vertices:number[]=[];
  const indices:number[]=[];
  const rings=[[-.29,.32],[-.13,.74],[.28,1],[.28,.9],[-.05,.65],[-.2,.25]];
  const count=48;
  for(const [y,width] of rings)for(let i=0;i<count;i++) {
    const a=i/count*Math.PI*2;
    const x=Math.cos(a)*1.5;
    vertices.push(x*(.76+.24*width),y+.13*Math.abs(Math.cos(a))**5,Math.sin(a)*.63*width*(1-.18*Math.cos(a)));
  }
  for(let ring=0;ring<rings.length-1;ring++)for(let i=0;i<count;i++) {
    const a=ring*count+i,b=ring*count+(i+1)%count,c=b+count,d=a+count;
    indices.push(a,b,c,a,c,d);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));g.setIndex(indices);g.computeVertexNormals();
  return g;
}

export function BoatPrefab() {
  const hull=useMemo(hullGeometry,[]);
  const rim=useMemo(()=>{
    const points=Array.from({length:49},(_,i)=>{const a=i/48*Math.PI*2;return new THREE.Vector3(Math.cos(a)*1.5,.3+.13*Math.abs(Math.cos(a))**5,Math.sin(a)*.63*(1-.18*Math.cos(a)));});
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points,true),80,.035,6,true);
  },[]);
  const trim=useMemo(()=>rim.clone().scale(.92,1,.77).translate(0,-.28,0),[rim]);
  return <StaticGroup name="fishing-boat" position={[-1.4,.03,3.8]} lightmap={false}>
    <mesh name="open-hull" geometry={hull}><meshStandardMaterial color="#e5dcc5" roughness={.72} side={THREE.DoubleSide}/></mesh>
    <mesh name="gunwale" geometry={rim}><meshStandardMaterial color="#386f79" roughness={.6}/></mesh>
    <mesh name="red-waterline" geometry={trim}><meshStandardMaterial color="#964c31" roughness={.8}/></mesh>
    <mesh position={[0,-.13,0]}><boxGeometry args={[2.1,.07,.55]}/><meshStandardMaterial color="#9e7950" roughness={.88}/></mesh>
    {[-.72,.1,.78].map(x=><mesh key={x} position={[x,.15,0]}><boxGeometry args={[.22,.075,x>.6?.66:.93]}/><meshStandardMaterial color="#a98250" roughness={.88}/></mesh>)}
    <mesh position={[.05,.24,.12]} rotation={[0,0,Math.PI/2]}><cylinderGeometry args={[.021,.026,2.3,8]}/><meshStandardMaterial color="#ac8b56" roughness={.8}/></mesh>
  </StaticGroup>;
}
